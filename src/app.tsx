import { effect, signal } from "@preact/signals";
import { Forma } from "forma-embedded-view-sdk/auto";
import { CameraState } from "forma-embedded-view-sdk/dist/internal/scene/camera";
import { useCallback } from "preact/hooks";

const storageSchemaVersion = 2;

type SharedState = {
  schemaVersion: typeof storageSchemaVersion;
  offer: string | undefined;
  answer: string | undefined;
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
const connection = new RTCPeerConnection(rtcConfiguration);

connection.onicecandidate = function (e) {
  if (e.candidate == null) {
    const newState: SharedState = {
      schemaVersion: storageSchemaVersion,
      answer: storageState.value?.answer,
      offer: JSON.stringify(connection.localDescription),
    };
    writeSharedState(newState);
  }
};

function shareCamera(cameraState: CameraState) {
  console.log("TODO: Share camera state", cameraState);
}
async function pollCamera(): Promise<CameraState> {
  console.log("TODO: Poll camera state");
  const curPos = await Forma.camera.getCurrent();

  return {
    position: { x: curPos.position.x, y: curPos.position.y, z: curPos.position.z },
    target: { x: curPos.target.x, y: curPos.target.y, z: curPos.target.z },
    type: curPos.type,
  };
}

effect(async () => {
  if (isSharing.value)
    while (true) {
      try {
        Forma.camera.getCurrent().then((camera) => {
          shareCamera(camera);
        });
      } catch (e) {
        console.error("Failed while sharing", e);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  else {
    while (true) {
      try {
        await Forma.camera.move(await pollCamera());
      } catch (e) {
        console.error("Failed while following", e);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

function sendCameraPosition(cameraPosition: CameraState) {
  const message: Message = {
    type: "cameraPosition",
    cameraPosition,
  };

  console.log("TODO: send message", message);
}

function isMessage(data: unknown): data is Message {
  return data != null && typeof data === "object" && "type" in data;
}

function onMessage(message: unknown) {
  if (!isMessage(message)) {
    console.error("Unexpected message", message);
    return;
  }

  switch (message.type) {
    case "cameraPosition":
      // TODO: switch perspective
      void Forma.camera.move({
        position: message.cameraPosition.position,
        target: message.cameraPosition.target,
      });
      break;
  }
}

export default function App() {
  const createAndStoreOffer = useCallback(() => {
    const dc1 = connection.createDataChannel("test", {});
    dc1.onopen = function (_e) {};
    dc1.onmessage = function (e) {
      if (e.data.charCodeAt(0) == 2) {
        return;
      }
      var data = JSON.parse(e.data);
      console.log(data);
    };
    connection.createOffer(
      function (desc) {
        connection.setLocalDescription(
          desc,
          function () {},
          function () {},
        );
      },
      function () {},
      {},
    );
  }, []);
  return (
    <>
      <h1>Multiplayer</h1>
      <p>Hello world!</p>
      <button onClick={createAndStoreOffer}>Start presenting (create offer)</button>
      <p>Storage polling state: {storagePollingState.value}</p>
      <p>Storage writing state: {storageWriteState.value}</p>
      <pre>
        Storage state:
        <br />
        {JSON.stringify(storageState.value, undefined, "  ")}
      </pre>
    </>
  );
}
