import { effect, signal, useSignalEffect } from "@preact/signals";
import { Forma } from "forma-embedded-view-sdk/auto";
import { CameraState } from "forma-embedded-view-sdk/dist/internal/scene/camera";
import { useCallback } from "preact/hooks";

const storageSchemaVersion = 2;

type SharedState = {
  schemaVersion: typeof storageSchemaVersion;
  offer: string | undefined;
  offerId: string | undefined;
  answer: string | undefined;
  answerId: string | undefined;
};

const storageKey = "state";
const storagePollingState = signal<"initialize" | "idle" | "loading" | "failed">("initialize");
const storageWriteState = signal<"idle" | "writing" | "failed">("idle");
const storageState = signal<SharedState | undefined>(undefined);
const isSharing = signal<boolean>(false);

type Message = {
  type: "cameraPosition";
  cameraPosition: CameraState;
};
const offerId = signal<string | undefined>(undefined);

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
    await Forma.extensions.storage.setObject({ key: storageKey, data: JSON.stringify(updated) });
    storageWriteState.value = "idle";
    storageState.value = updated;
  } catch (e) {
    console.error("Writing failed", e);
    storageWriteState.value = "failed";
    throw e;
  }
}

const rtcConfiguration = {
  iceServers: [{ urls: "stun:stun.gmx.net" }],
};
const presenterConnection = new RTCPeerConnection(rtcConfiguration);

presenterConnection.onicecandidate = function (e) {
  if (e.candidate == null) {
    console.log("presenterConnection.onicecandidate", e);
    offerId.value = crypto.randomUUID();
    const newState: SharedState = {
      schemaVersion: storageSchemaVersion,
      answer: undefined,
      offer: JSON.stringify(presenterConnection.localDescription),
      offerId: offerId.value,
      answerId: undefined,
    };
    writeSharedState(newState);
  }
};

effect(async () => {
  while (offerId.value) {
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
  if (storageState.value?.offerId === offerId.value) {
    presenterDataChannel.send(JSON.stringify(message));
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

const receiverConnection = new RTCPeerConnection(rtcConfiguration);

receiverConnection.onicecandidate = function (e) {
  console.log(e);
  if (e.candidate == null) {
    const newState: SharedState = {
      schemaVersion: storageSchemaVersion,
      answer: JSON.stringify(receiverConnection.localDescription),
      offer: storageState.value?.offer,
      offerId: storageState.value?.offerId,
      answerId: storageState.value?.offerId,
    };
    writeSharedState(newState);
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

export default function App() {
  const createAndStoreOffer = useCallback(() => {
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
  }, []);

  useSignalEffect(() => {
    // Don't do anything if there is no answer matching the offer
    if (storageState.value?.answerId !== offerId.value) {
      return;
    }
    if (storageState.value?.answerId === offerId.value && storageState.value?.answer != null) {
      console.log("setting remote description answer");
      var answerDesc = new RTCSessionDescription(JSON.parse(storageState.value.answer));
      presenterConnection.setRemoteDescription(answerDesc);
      return;
    }
  });

  const connectToOffer = () => {
    if (storageState.value?.offer && storageState.value.offerId !== offerId.value) {
      receiverConnection.setRemoteDescription(JSON.parse(storageState.value.offer));
      receiverConnection.createAnswer(
        function (answerDesc) {
          receiverConnection.setLocalDescription(answerDesc);
        },
        () => {},
      );
    }
  };

  const sendPresenterMessage = async () => {
    console.log(presenterDataChannel);
    const camera = await Forma.camera.getCurrent();
    presenterDataChannel.send(JSON.stringify(camera));
  };

  return (
    <>
      <h1>Multiplayer</h1>
      <p>Hello world!</p>
      <button onClick={createAndStoreOffer}>Start presenting (create offer)</button>
      <button onClick={connectToOffer}>Connect to presenter (accept offer)</button>
      <button onClick={sendPresenterMessage}>Send message as presenter</button>
      <p>Storage polling state: {storagePollingState.value}</p>
      <p>Storage writing state: {storageWriteState.value}</p>
      <p>Offer Id: {offerId.value}</p>
      <pre>
        Storage state:
        <br />
        {JSON.stringify(storageState.value, undefined, "  ")}
      </pre>
    </>
  );
}
