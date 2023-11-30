import { computed, effect, signal } from "@preact/signals";
import { Forma } from "forma-embedded-view-sdk/auto";
import { CameraState } from "forma-embedded-view-sdk/dist/internal/scene/camera";
import { useCallback } from "preact/hooks";

const storageSchemaVersion = 3;

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
  return {
    ...prev,
    clients: [
      ...prev.clients.filter(
        (client) => client.id !== clientId && client.lastSeen >= Date.now() - 60000,
      ),
      cur,
    ],
  };
}

const storageKey = "state";
const storagePollingState = signal<"initialize" | "idle" | "loading" | "failed">("initialize");
const storageWriteState = signal<"idle" | "writing" | "failed">("idle");
const storageState = signal<SharedState | undefined>(undefined);
const isSharing = signal<boolean>(false);

const hasInited = signal(false);

effect(() => {
  if (!hasInited.value && storageState.value) {
    void writeSharedState(updateClientState(getState(), createClientState()));
    hasInited.value = true;
  }
});

type Message = {
  type: "cameraPosition";
  cameraPosition: CameraState;
};

startStoragePolling();

async function startStoragePolling() {
  while (true) {
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
    } catch (e) {
      console.error("Polling failed", e);
      storagePollingState.value = "failed";
    }

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

const presenterDataChannels: RTCDataChannel[] = [];

function createPresenterConnection(targetClientId: string) {
  console.log("createPresenterConnection", targetClientId);
  const presenterConnection = new RTCPeerConnection(rtcConfiguration);

  presenterConnection.onicecandidate = function (e) {
    if (e.candidate == null) {
      console.log("presenterConnection.onicecandidate", e);

      const clientState =
        getState().clients.find((client) => client.id === clientId) ?? createClientState();

      writeSharedState(
        updateClientState(
          {
            ...getState(),
            leaderClientId: clientId,
          },
          {
            ...clientState,
            offers: [
              ...(clientState?.offers ?? []),
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
    const answers = getState().clients.flatMap((client) =>
      client.answers.filter((answer) => answer.targetClientId === clientId),
    );
    const firstAnswer = answers[0];

    // Don't do anything if there is no answer matching the offer
    if (!firstAnswer) {
      return;
    }
    console.log("setting remote description answer");
    var answerDesc = new RTCSessionDescription(JSON.parse(firstAnswer.value));
    presenterConnection.setRemoteDescription(answerDesc);
    return;
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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
        presenterDataChannel.send(JSON.stringify(message));
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

  receiverConnection.onicecandidate = function (e) {
    console.log(e);
    if (e.candidate == null) {
      writeSharedState(
        updateClientState(getState(), {
          id: clientId,
          lastSeen: Date.now(),
          name: clientId,
          answers: [
            {
              value: JSON.stringify(receiverConnection.localDescription),
              targetClientId: offerClientId.value!,
            },
          ],
          offers: [],
        }),
      );
    }
  };

  receiverConnection.ondatachannel = function (e) {
    var datachannel = e.channel || e;
    const dc2 = datachannel;
    dc2.onopen = function (e) {
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
