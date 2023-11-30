import WebRtcChat from "./components/WebRtcChat";
import { signal } from "@preact/signals";
import { Forma } from "forma-embedded-view-sdk/auto";

const storageSchemaVersion = 1;

type SharedState = {
  schemaVersion: typeof storageSchemaVersion;
  count: number;
  // TODO: add stuff here, consider bumping version above
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
export default function App() {
  return (
    <>
      <h1>Multiplayer</h1>
      <p>Hello world!</p>
      <WebRtcChat />
      <p>Storage polling state: {storagePollingState.value}</p>
      <p>Storage writing state: {storageWriteState.value}</p>
      <pre>
        Storage state:
        <br />
        {JSON.stringify(storageState.value, undefined, "  ")}
      </pre>
      <button
        onClick={async () => {
          await writeSharedState({
            schemaVersion: storageSchemaVersion,
            count: (storageState.value?.count ?? 0) + 1,
          });
        }}
      >
        Write some state
      </button>
    </>
  );
}
