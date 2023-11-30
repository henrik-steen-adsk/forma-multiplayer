import { signal } from "@preact/signals";
import { Forma } from "forma-embedded-view-sdk/auto";
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
export default function App() {
  const createAndStoreOffer = useCallback(() => {
    const dc1 = connection.createDataChannel("test", {});
    dc1.onopen = function (e) {};
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
