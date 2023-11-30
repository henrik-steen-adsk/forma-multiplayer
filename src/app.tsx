import { effect, signal } from "@preact/signals";
import { Forma } from "forma-embedded-view-sdk/auto";
import { CameraState } from "forma-embedded-view-sdk/dist/internal/scene/camera";
import { useCallback } from "preact/hooks";

const storageSchemaVersion = 8;

const connectedLeaderClientId = signal<string | undefined>(undefined);
const clientId = crypto.randomUUID();

type SharedState = {
  schemaVersion: typeof storageSchemaVersion;
  clients: {
    id: string;
    lastSeen: number;
    name: string;
    offers: {
      value: string;
      targetClientId: string;
    }[];
    answers: {
      value: string;
      targetClientId: string;
    }[];
  }[];
  leaderClientId: string | undefined;
};

const clientState = signal<SharedState["clients"][0]>(createClientState());

function getState(): SharedState {
  return storageState.value ?? createBlankState();
}

function createBlankState(): SharedState {
  return {
    schemaVersion: storageSchemaVersion,
    clients: [],
    leaderClientId: undefined,
  };
}

function createClientState(): SharedState["clients"][0] {
  return {
    id: clientId,
    lastSeen: Date.now(),
    name: clientId,
    answers: [],
    offers: [],
  };
}

function updateClientState(updated?: Partial<SharedState["clients"][0]>) {
  clientState.value = {
    ...clientState.value,
    ...updated,
    lastSeen: Date.now(),
  };
}

const storageKey = "state";
const storagePollingState = signal<"initialize" | "idle" | "loading" | "failed">("initialize");
const storageWriteState = signal<"idle" | "writing" | "failed">("idle");
const storageState = signal<SharedState | undefined>(undefined);

type Message =
  | {
      type: "cameraPosition";
      cameraPosition: CameraState;
    }
  | {
      type: "selectionPaths";
      selection: string[];
    };

const currentSelection = signal<string[] | undefined>(undefined);

startStoragePolling();

async function refreshState() {
  try {
    storagePollingState.value = "loading";
    const response = await Forma.extensions.storage.getTextObject({ key: storageKey });
    if (response) {
      const parsed = JSON.parse(response.data) as SharedState;

      // Ignore old versioned state.
      if (parsed.schemaVersion === storageSchemaVersion) {
        storageState.value = parsed;
      }
    }

    storagePollingState.value = "idle";

    await writeSharedState();
  } catch (e) {
    console.error("Polling failed", e);
    storagePollingState.value = "failed";
  }
}

async function startStoragePolling() {
  while (true) {
    await refreshState();
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function writeSharedState(update?: Partial<SharedState>) {
  try {
    updateClientState();
    const prev = getState();
    storageWriteState.value = "writing";
    storageState.value = {
      ...prev,
      clients: [
        ...prev.clients.filter(
          (client) => client.id !== clientId && client.lastSeen >= Date.now() - 20000,
        ),
        clientState.value,
      ],
      ...update,
    };
    await Forma.extensions.storage.setObject({
      key: storageKey,
      data: JSON.stringify(storageState.value),
    });
    storageWriteState.value = "idle";
  } catch (e) {
    console.error("Writing failed", e);
    storageWriteState.value = "failed";
    throw e;
  }
}

const rtcConfiguration = {
  iceServers: [{ urls: "stun:stun.gmx.net" }],
};

const answeredClientIds: string[] = [];

const presenterDataChannels: RTCDataChannel[] = [];

async function createPresenterConnection(targetClientId: string) {
  console.log("createPresenterConnection", targetClientId);
  const presenterConnection = new RTCPeerConnection(rtcConfiguration);

  const presenterDataChannel = presenterConnection.createDataChannel("test", {});
  presenterDataChannel.onopen = function (e) {
    console.log("presenter connection open", e);
  };
  presenterDataChannel.onmessage = function (e) {
    console.log(e);
    if (e.data.charCodeAt(0) == 2) {
      return;
    }
    var data = JSON.parse(e.data);
    console.log(data);
  };

  presenterDataChannels.push(presenterDataChannel);

  effect(() => {
    const answers = getState()
      .clients.filter((client) => client.id === targetClientId)
      .flatMap((client) =>
        client.answers
          .filter((answer) => answer.targetClientId === clientId)
          .map((answer) => ({
            answer,
            client,
          })),
      );

    for (const { answer, client } of answers) {
      if (answeredClientIds.includes(client.id)) continue;
      console.log("setting remote description answer");
      var answerDesc = new RTCSessionDescription(JSON.parse(answer.value));
      presenterConnection.setRemoteDescription(answerDesc);
      answeredClientIds.push(client.id);
    }
  });

  const offer = await presenterConnection.createOffer();
  presenterConnection.setLocalDescription(offer);

  return {
    offer,
  };
}

function sendSelection(selection: string[]) {
  if (selection == currentSelection.value) return;
  const message: Message = {
    type: "selectionPaths",
    selection,
  };
  for (const presenterDataChannel of presenterDataChannels) {
    try {
      if (presenterDataChannel.readyState === "open") {
        presenterDataChannel.send(JSON.stringify(message));
      }
    } catch (e) {
      console.error("Failed to send message", e);
    }
  }
}

effect(async () => {
  while (getState().leaderClientId === clientId) {
    try {
      Forma.camera.getCurrent().then((camera) => {
        sendCameraPosition(camera);
      });
      Forma.selection.getSelection().then((selection) => {
        sendSelection(selection);
      });
    } catch (e) {
      console.error("Failed while sharing", e);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
});

function sendCameraPosition(cameraPosition: CameraState) {
  const message: Message = {
    type: "cameraPosition",
    cameraPosition,
  };
  if (getState().leaderClientId === clientId) {
    for (const presenterDataChannel of presenterDataChannels) {
      try {
        if (presenterDataChannel.readyState === "open") {
          presenterDataChannel.send(JSON.stringify(message));
        }
      } catch (e) {
        console.error("Failed to send message", e);
      }
    }
  }
}

function isMessage(data: unknown): data is Message {
  return data != null && typeof data === "object" && "type" in data;
}

const _appendBuffer = function (buffer1: Float32Array, buffer2: Float32Array) {
  const tmp = new Float32Array(buffer1.length + buffer2.length);
  tmp.set(new Float32Array(buffer1), 0);
  tmp.set(new Float32Array(buffer2), buffer1.length);
  return tmp;
};

async function onMessage(message: unknown) {
  if (!isMessage(message)) {
    console.error("Unexpected message", message);
    return;
  }

  switch (message.type) {
    case "selectionPaths":
      const tris = await Promise.all(
        message.selection.map((path) => {
          return Forma.geometry.getTriangles({ path });
        }),
      );
      const triangles = tris.reduce((acc, val) => _appendBuffer(acc, val), new Float32Array(0));

      const color = new Uint8Array((triangles.length / 3) * 4);
      for (let i = 0; i < color.length; i += 4) {
        color[i] = 255;
        color[i + 1] = 0;
        color[i + 2] = 0;
        color[i + 3] = 255;
      }
      Forma.render.updateMesh({
        id: "selection",
        geometryData: { position: triangles, color },
      });
      break;
    case "cameraPosition":
      const currentCameraState = await Forma.camera.getCurrent();
      if (currentCameraState.type !== message.cameraPosition.type) {
        // TODO: Should not use toggles for async operations.
        await Forma.camera.switchPerspective();
      }

      // TODO: Would be nice with perspective as part of this API call.
      await Forma.camera.move({
        position: message.cameraPosition.position,
        target: message.cameraPosition.target,
        transitionTimeMs: 100,
      });
      break;
  }
}

function createReceiverConnection() {
  const receiverConnection = new RTCPeerConnection(rtcConfiguration);

  receiverConnection.onicecandidate = async function (e) {
    console.log(e);
    if (e.candidate == null) {
      await refreshState();
      updateClientState({
        answers: [
          {
            value: JSON.stringify(receiverConnection.localDescription),
            targetClientId: connectedLeaderClientId.value!,
          },
        ],
      });
      await writeSharedState();
    }
  };

  receiverConnection.ondatachannel = function (e) {
    var datachannel = e.channel || e;
    const dc2 = datachannel;
    dc2.onopen = function () {
      console.log("receiver connection open");
    };
    dc2.onmessage = function (e) {
      var data = JSON.parse(e.data);
      onMessage(data);
    };
  };

  return receiverConnection;
}

effect(async () => {
  const state = getState();

  const leader = state.clients.find((client) => client.id === state.leaderClientId);
  if (!leader) return;

  const offer = leader.offers.find((offer) => offer.targetClientId === clientId);
  if (!offer) return;

  if (connectedLeaderClientId.value == leader.id) return;
  connectedLeaderClientId.value = leader.id;

  const receiverConnection = createReceiverConnection();
  receiverConnection.setRemoteDescription(JSON.parse(offer.value));
  receiverConnection.setLocalDescription(await receiverConnection.createAnswer());
});

async function addClientsForLeader(clients: SharedState["clients"] = []) {
  const offers: SharedState["clients"][0]["offers"] = [];
  for (const client of clients) {
    console.log("Add client", client.id);

    const { offer } = await createPresenterConnection(client.id);
    offers.push({
      value: JSON.stringify(offer),
      targetClientId: client.id,
    });
  }

  updateClientState({
    ...clientState.value,
    offers: [...clientState.value.offers, ...offers],
  });

  await refreshState();
  await writeSharedState({
    leaderClientId: clientId,
  });
}

effect(() => {
  if (getState().leaderClientId !== clientId) return;

  const existingOffersTo = clientState.value.offers.map((offer) => offer.targetClientId);

  const clients = getState().clients.filter(
    (client) => client.id !== clientId && !existingOffersTo.includes(client.id),
  );

  if (clients.length > 0) {
    addClientsForLeader(clients);
  }
});

export default function App() {
  const createAndStoreOffer = useCallback(async () => {
    const clients = getState().clients.filter((client) => client.id !== clientId);
    addClientsForLeader(clients);
  }, []);

  return (
    <>
      <h1>Multiplayer</h1>
      <p>Hello world!</p>
      <button onClick={createAndStoreOffer}>Start presenting (create offer)</button>
      <p>Storage polling state: {storagePollingState.value}</p>
      <p>Storage writing state: {storageWriteState.value}</p>
      <p>Client ID: {clientId}</p>
      <pre>
        Storage state:
        <br />
        {JSON.stringify(storageState.value, undefined, "  ")}
      </pre>
    </>
  );
}
