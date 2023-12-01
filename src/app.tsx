import { computed, effect, signal } from "@preact/signals";
import { Forma } from "forma-embedded-view-sdk/auto";
import { CameraState } from "forma-embedded-view-sdk/dist/internal/scene/camera";
import { useCallback } from "preact/hooks";
import pLimit from "p-limit";
import equal from "fast-deep-equal";

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

const fetchLimit = pLimit(1);

const clientId = crypto.randomUUID();
const clientState = signal<SharedState["clients"][0]>({
  id: clientId,
  lastSeen: Date.now(),
  name: clientId.slice(0, 8),
  answers: [],
  offers: [],
});

const storageSchemaVersion = 8;
const storageKey = "state";
const storagePollingState = signal<"initialize" | "idle" | "loading" | "failed">("initialize");
const storageWriteState = signal<"idle" | "writing" | "failed">("idle");
const storageState = signal<SharedState>({
  schemaVersion: storageSchemaVersion,
  clients: [],
  leaderClientId: undefined,
});

const rtcConfiguration = {
  iceServers: [{ urls: "stun:stun.gmx.net" }],
};
const dataChannels = new Map<string, RTCDataChannel>();
const connectedLeaderClientId = signal<string | undefined>(undefined);
const clientsSettingUp = new Set<string>();

function updateClientState(updated?: Partial<SharedState["clients"][0]>) {
  clientState.value = {
    ...clientState.value,
    ...updated,
    lastSeen: Date.now(),
  };
  storageState.value = {
    ...storageState.value,
    clients: getClientsState(),
  };
}

type Message =
  | {
      type: "cameraPosition";
      cameraPosition: CameraState;
    }
  | {
      type: "selectionPaths";
      selection: string[];
    };

startStoragePolling();

async function refreshState(override?: Partial<SharedState>) {
  if (override) {
    storageState.value = {
      ...storageState.value,
      ...override,
    };
  }

  await fetchLimit(async () => {
    try {
      storagePollingState.value = "loading";
      const response = await Forma.extensions.storage.getTextObject({ key: storageKey });
      if (response) {
        const parsed = JSON.parse(response.data) as SharedState;

        // Ignore old versioned state.
        if (parsed.schemaVersion === storageSchemaVersion) {
          console.log("Got updated state", parsed);
          storageState.value = {
            ...parsed,
            ...override,
          };
        }
      }

      storagePollingState.value = "idle";
    } catch (e) {
      console.error("Polling failed", e);
      storagePollingState.value = "failed";
    }
  });
}

async function startStoragePolling() {
  while (true) {
    await refreshState();
    const persistedClientState = storageState.value.clients.find(
      (client) => client.id === clientId,
    );
    if (
      persistedClientState == null ||
      persistedClientState.lastSeen < Date.now() - 15000 ||
      !equal(persistedClientState, clientState.value)
    ) {
      await writeSharedState();
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

function getClientsState() {
  const otherClients = storageState.value.clients.filter(
    (client) => client.id !== clientId && client.lastSeen >= Date.now() - 20000,
  );

  return [...otherClients, clientState.value].sort((a, b) => a.id.localeCompare(b.id));
}

async function writeSharedState(update?: Partial<SharedState>) {
  try {
    updateClientState();
    storageWriteState.value = "writing";
    storageState.value = {
      ...storageState.value,
      clients: getClientsState(),
      ...update,
    };
    console.log("Save new state", storageState.value);
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

async function createPresenterConnection(targetClientId: string) {
  console.log(`Create connection towards ${targetClientId}`);

  const connection = new RTCPeerConnection(rtcConfiguration);

  const dataChannel = connection.createDataChannel("main");
  dataChannel.onopen = (e) => {
    console.log(`Presenter's data channel to viewer ${targetClientId} open`, e);
  };
  dataChannel.onmessage = (e) => {
    console.warn("Unexpected message on presenter", e);
  };
  dataChannels.set(targetClientId, dataChannel);

  // Listen for connection answer.
  const cleanup = effect(() => {
    if (dataChannels.get(targetClientId) !== dataChannel) {
      cleanup();
      return;
    }

    const targetClient = storageState.value.clients.find((client) => client.id === targetClientId);
    if (!targetClient) return;

    const answer = targetClient.answers.find((answer) => answer.targetClientId === clientId);
    if (!answer) return;

    console.log(`Got answer from ${targetClientId}`);
    connection.setRemoteDescription(new RTCSessionDescription(JSON.parse(answer.value)));

    cleanup();
  });

  connection.setLocalDescription();

  return new Promise<{ offer: RTCSessionDescriptionInit }>(async (resolve) => {
    connection.onicecandidate = async (e) => {
      // Check if all ICE gathering completed.
      if (e.candidate == null) {
        console.log(`Got all candidates for ${targetClientId}`, {
          localDescription: connection.localDescription!.sdp,
        });
        resolve({ offer: connection.localDescription! });
      }
    };
  });
}

let lastSentCameraPosition:
  | {
      value: CameraState;
      time: number;
    }
  | undefined;
let lastSentSelection:
  | {
      value: string[];
      time: number;
    }
  | undefined;
let activeSender: symbol | undefined;

async function startCameraPositionSending(sender: symbol) {
  while (activeSender === sender) {
    try {
      const cameraPosition = await Forma.camera.getCurrent();
      if (
        lastSentCameraPosition == null ||
        !equal(lastSentCameraPosition.value, cameraPosition) ||
        lastSentCameraPosition.time < performance.now() - 4000
      ) {
        lastSentCameraPosition = {
          value: cameraPosition,
          time: performance.now(),
        };
        broadcast({
          type: "cameraPosition",
          cameraPosition,
        });
      }
    } catch (e) {
      console.error("Failed while sending camera position", e);
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

async function startSelectionSending(sender: symbol) {
  while (activeSender === sender) {
    try {
      const selection = await Forma.selection.getSelection();
      if (
        lastSentSelection == null ||
        !equal(lastSentSelection.value, selection) ||
        lastSentSelection.time < performance.now() - 4000
      ) {
        lastSentSelection = {
          value: selection,
          time: performance.now(),
        };
        broadcast({
          type: "selectionPaths",
          selection,
        });
      }
    } catch (e) {
      console.error("Failed while sending selection", e);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

effect(() => {
  const shouldBeSending = storageState.value.leaderClientId === clientId;
  if (!shouldBeSending && activeSender) {
    activeSender = undefined;
  }
  if (shouldBeSending && !activeSender) {
    activeSender = Symbol();
    void startCameraPositionSending(activeSender);
    void startSelectionSending(activeSender);
  }
});

function broadcast(message: Message) {
  if (dataChannels.size === 0) return;

  console.log("Send message", message);
  const serialized = JSON.stringify(message);
  for (const channel of dataChannels.values()) {
    try {
      if (channel.readyState === "open") {
        channel.send(serialized);
      }
    } catch (e) {
      console.error("Failed to send message", e);
    }
  }
}

function isMessage(data: unknown): data is Message {
  return data != null && typeof data === "object" && "type" in data;
}

function concatFloat32Arrays(items: Float32Array[]) {
  const length = items.reduce((acc, cur) => acc + cur.length, 0);
  const result = new Float32Array(length);

  let offset = 0;
  for (const item of items) {
    result.set(item, offset);
    offset += item.length;
  }

  return result;
}

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
      const triangles = concatFloat32Arrays(tris);

      const color = new Uint8Array((triangles.length / 3) * 4);
      for (let i = 0; i < color.length; i += 4) {
        color[i] = 255;
        color[i + 1] = 0;
        color[i + 2] = 0;
        color[i + 3] = 255;
      }
      await Forma.render.updateMesh({
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
      });
      break;
  }
}

async function createViewerConnection(targetClientId: string, offer: RTCSessionDescriptionInit) {
  console.log(`Create connection (answer) towards ${targetClientId}`, { offer });

  const connection = new RTCPeerConnection(rtcConfiguration);

  connection.ondatachannel = (e) => {
    console.log(`Got viewer's data channel to presenter ${targetClientId}`);

    var datachannel = e.channel || e;
    datachannel.onopen = () => {
      console.log(`Viewer's data channel to presenter ${targetClientId} open`, e);
    };
    datachannel.onmessage = (e) => {
      onMessage(JSON.parse(e.data));
    };
  };

  connection.setRemoteDescription(offer);
  connection.setLocalDescription();

  return new Promise<{ answer: RTCSessionDescriptionInit }>(async (resolve) => {
    connection.onicecandidate = async (e) => {
      // Check if all ICE gathering completed.
      if (e.candidate == null) {
        console.log(`Got all candidates for ${targetClientId}`, {
          localDescription: connection.localDescription!.sdp,
        });
        resolve({ answer: connection.localDescription! });
      }
    };
  });
}

effect(async () => {
  const state = storageState.value;

  const leader = state.clients.find((client) => client.id === state.leaderClientId);
  if (!leader) return;

  const offer = leader.offers.find((offer) => offer.targetClientId === clientId);
  if (!offer) return;

  if (connectedLeaderClientId.value == leader.id) return;
  connectedLeaderClientId.value = leader.id;

  const { answer } = await createViewerConnection(leader.id, JSON.parse(offer.value));

  updateClientState({
    answers: [
      ...clientState.value.answers.filter((it) => it.targetClientId !== leader.id),
      {
        value: JSON.stringify(answer),
        targetClientId: leader.id,
      },
    ],
  });
  await refreshState();
  await writeSharedState();
});

async function flagAsLeaderAndAddClients(clients: SharedState["clients"] = []) {
  for (const client of clients) {
    clientsSettingUp.add(client.id);
  }

  await refreshState({
    leaderClientId: clientId,
  });
  await writeSharedState();

  await Promise.allSettled(
    clients.map((client) =>
      (async () => {
        const { offer } = await createPresenterConnection(client.id);

        updateClientState({
          ...clientState.value,
          offers: [
            ...clientState.value.offers.filter((it) => it.targetClientId !== client.id),
            {
              value: JSON.stringify(offer),
              targetClientId: client.id,
            },
          ],
        });

        clientsSettingUp.delete(client.id);
      })(),
    ),
  );
}

// Add late viewers.
effect(() => {
  if (storageState.value.leaderClientId !== clientId) return;

  const existingOffersTo = clientState.value.offers.map((offer) => offer.targetClientId);
  const clients = storageState.value.clients.filter(
    (client) =>
      client.id !== clientId &&
      !existingOffersTo.includes(client.id) &&
      !clientsSettingUp.has(client.id),
  );

  if (clients.length > 0) {
    flagAsLeaderAndAddClients(clients);
  }
});

const showDebug = signal<boolean>(false);

function startPresent() {
  const clients = storageState.value.clients.filter((client) => client.id !== clientId);
  flagAsLeaderAndAddClients(clients);
}

export default function App() {
  return (
    <>
      <p style="display: flex; align-items: flex-end">
        <weave-input
          label="Your name"
          showlabel
          value={clientState.value.name}
          onChange={(e) => {
            updateClientState({
              name: (e.target as HTMLInputElement).value,
            });
          }}
        />
        {storageState.value.leaderClientId !== clientId && (
          <weave-button onClick={startPresent} style="margin-left: 12px">
            Present
          </weave-button>
        )}
      </p>
      {storageState.value.leaderClientId === clientId && <p>You are presenting!</p>}
      <p>Other participants:</p>
      {storageState.value.clients
        .filter((client) => client.id !== clientId)
        .map((client) => (
          <p>
            {client.name}
            {client.id === connectedLeaderClientId.value && <> (presenter)</>}
          </p>
        ))}
      <p>
        <weave-button onClick={() => (showDebug.value = !showDebug.value)}>Debug</weave-button>
      </p>
      {showDebug.value && (
        <>
          <p>Storage polling state: {storagePollingState.value}</p>
          <p>Storage writing state: {storageWriteState.value}</p>
          <p>Client ID: {clientId}</p>
          <pre>
            Storage state:
            <br />
            {JSON.stringify(storageState.value, undefined, "  ")}
          </pre>
        </>
      )}
    </>
  );
}
