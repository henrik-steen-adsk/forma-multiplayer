import { effect, signal } from "@preact/signals";
import { Forma } from "forma-embedded-view-sdk/auto";
import { CameraState } from "forma-embedded-view-sdk/dist/internal/scene/camera";
import { useCallback } from "preact/hooks";

const storageSchemaVersion = 8;

const offerClientId = signal<string | undefined>(undefined);
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

function updateClientState(prev: SharedState, cur: SharedState["clients"][0]) {
  clientState.value = cur;
  return {
    ...prev,
    clients: [
      ...prev.clients.filter(
        (client) => client.id !== clientId && client.lastSeen >= Date.now() - 20000,
      ),
      {
        ...cur,
        lastSeen: Date.now(),
      },
    ],
  };
}

const storageKey = "state";
const storagePollingState = signal<"initialize" | "idle" | "loading" | "failed">("initialize");
const storageWriteState = signal<"idle" | "writing" | "failed">("idle");
const storageState = signal<SharedState | undefined>(undefined);

type Message = {
  type: "cameraPosition";
  cameraPosition: CameraState;
};

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

    await writeSharedState(updateClientState(getState(), clientState.value));
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

async function writeSharedState(updated: SharedState) {
  try {
    storageWriteState.value = "writing";
    storageState.value = updated;
    await Forma.extensions.storage.setObject({ key: storageKey, data: JSON.stringify(updated) });
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

function createPresenterConnection(targetClientId: string) {
  console.log("createPresenterConnection", targetClientId);
  const presenterConnection = new RTCPeerConnection(rtcConfiguration);

  presenterConnection.onicecandidate = async function (e) {
    if (e.candidate == null) {
      console.log("presenterConnection.onicecandidate", e);

      await refreshState();

      await writeSharedState(
        updateClientState(
          {
            ...getState(),
            leaderClientId: clientId,
          },
          {
            ...clientState.value,
            offers: [
              ...(clientState.value.offers ?? []),
              {
                value: JSON.stringify(presenterConnection.localDescription),
                targetClientId,
              },
            ],
          },
        ),
      );
    }
  };

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

  return presenterConnection;
}

effect(async () => {
  while (getState().leaderClientId === clientId) {
    try {
      Forma.camera.getCurrent().then((camera) => {
        sendCameraPosition(camera);
      });
    } catch (e) {
      console.error("Failed while sharing", e);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
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

async function onMessage(message: unknown) {
  if (!isMessage(message)) {
    console.error("Unexpected message", message);
    return;
  }

  switch (message.type) {
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
      await writeSharedState(
        updateClientState(getState(), {
          ...clientState.value,
          answers: [
            {
              value: JSON.stringify(receiverConnection.localDescription),
              targetClientId: offerClientId.value!,
            },
          ],
        }),
      );
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

effect(() => {
  const state = getState();
  const leader = state.clients.find((client) => client.id === state.leaderClientId);

  if (!leader) return;

  const offer = leader.offers.find((offer) => offer.targetClientId === clientId);

  if (!offer) return;
  if (offerClientId.value == leader.id) return;

  offerClientId.value = leader.id;

  const receiverConnection = createReceiverConnection();
  receiverConnection.setRemoteDescription(JSON.parse(offer.value));
  receiverConnection.createAnswer(
    function (answerDesc) {
      receiverConnection.setLocalDescription(answerDesc);
    },
    () => {},
  );
});

export default function App() {
  const createAndStoreOffer = useCallback(() => {
    const otherClients = getState().clients.filter((client) => client.id !== clientId);
    for (const client of otherClients) {
      const presenterConnection = createPresenterConnection(client.id);
      presenterConnection.createOffer(
        function (desc) {
          presenterConnection.setLocalDescription(
            desc,
            function () {},
            function () {},
          );
        },
        function () {},
        {},
      );
    }
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
