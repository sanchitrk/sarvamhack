type ConversationMessage = {
  role: "user" | "assistant";
  text: string;
};

type SessionSummary = {
  id: string;
  modified: string;
  firstMessage: string;
};

type ServerMessage =
  | { type: "ready" }
  | { type: "session"; id: string; history: ConversationMessage[] }
  | { type: "state"; value: string }
  | { type: "speech_start" }
  | { type: "speech_end" }
  | { type: "transcript"; text: string; language: string }
  | { type: "assistant_start" }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_end"; text: string }
  | { type: "tts_start" }
  | { type: "tts_end" }
  | { type: "tts_audio"; audio: string; mimeType: string; sequence: number }
  | { type: "cancel_audio" }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; isError: boolean }
  | { type: "error"; message: string };

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const voiceButton = requiredElement<HTMLButtonElement>("#voice-button");
const voiceButtonLabel = requiredElement("#voice-button-label");
const language = requiredElement<HTMLSelectElement>("#language");
const transcript = requiredElement("#transcript");
const response = requiredElement("#response");
const detectedLanguage = requiredElement("#detected-language");
const connectionDot = requiredElement("#connection-dot");
const connectionLabel = requiredElement("#connection-label");
const orb = requiredElement<HTMLElement>("#orb");
const stateLabel = requiredElement("#state-label");
const stateDetail = requiredElement("#state-detail");
const textForm = requiredElement<HTMLFormElement>("#text-form");
const textInput = requiredElement<HTMLInputElement>("#text-input");
const sessionSelect = requiredElement<HTMLSelectElement>("#session-select");
const newSessionButton = requiredElement<HTMLButtonElement>("#new-session");
const history = requiredElement("#history");
const historyCount = requiredElement("#history-count");
const uploadForm = requiredElement<HTMLFormElement>("#upload-form");
const fileInput = requiredElement<HTMLInputElement>("#file-input");
const uploadButton = requiredElement<HTMLButtonElement>("#upload-button");
const uploadStatus = requiredElement("#upload-status");

let socket: WebSocket | undefined;
let mediaStream: MediaStream | undefined;
let audioContext: AudioContext | undefined;
let sourceNode: MediaStreamAudioSourceNode | undefined;
let workletNode: AudioWorkletNode | undefined;
let currentAudio: HTMLAudioElement | undefined;
let activeSessionId = window.localStorage.getItem("vaani-session") || "";
let historyMessages: ConversationMessage[] = [];
let recording = false;
let responseText = "";
let ttsEnded = false;
const audioQueue: Array<{ audio: string; mimeType: string }> = [];

const stateCopy: Record<string, [string, string]> = {
  idle: ["Ready when you are", "Press start and allow microphone access"],
  connecting: ["Connecting", "Opening a secure speech connection"],
  listening: ["Listening", "Speak naturally in any supported language"],
  hearing: ["I hear you", "Keep speaking — I’ll detect when you finish"],
  thinking: ["Thinking", "Reasoning about what you said"],
  speaking: ["Speaking", "You can interrupt me at any time"],
  tool: ["Reading", "Inspecting your uploaded context"],
  error: ["Something went wrong", "Try stopping and starting again"],
};

function setState(state: string): void {
  orb.dataset.state = state;
  const copy = stateCopy[state] || [state, ""];
  stateLabel.textContent = copy[0];
  stateDetail.textContent = copy[1];
}

function setText(element: Element, text: string): void {
  element.textContent = text;
  element.classList.toggle("placeholder", !text);
}

function send(message: object): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function parseMessage(value: string): ServerMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as ServerMessage) : undefined;
  } catch {
    return undefined;
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    throw new Error(`Server returned an empty response (${response.status})`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Server returned an invalid response (${response.status})`);
  }
}

function renderHistory(messages: ConversationMessage[]): void {
  historyMessages = [...messages];
  history.replaceChildren();

  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "This conversation is just getting started.";
    history.append(empty);
  } else {
    for (const message of messages) {
      const item = document.createElement("article");
      item.className = `history-message ${message.role}`;
      const role = document.createElement("span");
      role.textContent = message.role === "user" ? "You" : "Vaani";
      const text = document.createElement("p");
      text.textContent = message.text;
      item.append(role, text);
      history.append(item);
    }
  }

  historyCount.textContent = `${messages.length} ${messages.length === 1 ? "message" : "messages"}`;
  history.scrollTop = history.scrollHeight;
}

function appendHistory(message: ConversationMessage): void {
  renderHistory([...historyMessages, message]);
}

async function refreshSessions(): Promise<void> {
  const response = await fetch("/api/sessions");
  if (!response.ok) throw new Error("Could not load conversations");
  const payload = await parseJsonResponse<{ sessions: SessionSummary[] }>(response);
  sessionSelect.replaceChildren();

  if (activeSessionId && !payload.sessions.some((session) => session.id === activeSessionId)) {
    const current = document.createElement("option");
    current.value = activeSessionId;
    current.textContent = "New conversation";
    sessionSelect.append(current);
  }

  for (const session of payload.sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    const title =
      session.firstMessage === "(no messages)"
        ? "New conversation"
        : session.firstMessage.replace(/\s+/g, " ").slice(0, 54);
    option.textContent = title;
    sessionSelect.append(option);
  }
  sessionSelect.value = activeSessionId;
}

function cancelAudio(): void {
  audioQueue.length = 0;
  ttsEnded = false;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = undefined;
  }
}

function playNext(): void {
  if (currentAudio || audioQueue.length === 0) {
    if (!currentAudio && audioQueue.length === 0 && ttsEnded) {
      send({ type: "playback_done" });
    }
    return;
  }

  const item = audioQueue.shift();
  if (!item) return;
  const bytes = Uint8Array.from(atob(item.audio), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: item.mimeType }));
  const player = new Audio(url);
  currentAudio = player;
  const finish = () => {
    URL.revokeObjectURL(url);
    if (currentAudio === player) currentAudio = undefined;
    playNext();
  };
  player.addEventListener("ended", finish, { once: true });
  player.addEventListener("error", finish, { once: true });
  void player.play().catch(finish);
}

function handleMessage(message: ServerMessage): void {
  if (message.type === "ready") {
    connectionDot.classList.add("connected");
    connectionLabel.textContent = "Connected";
    return;
  }
  if (message.type === "session") {
    activeSessionId = message.id;
    window.localStorage.setItem("vaani-session", message.id);
    renderHistory(message.history);
    setText(transcript, "");
    setText(response, "");
    detectedLanguage.textContent = "—";
    uploadButton.disabled = false;
    void refreshSessions().catch(() => undefined);
    return;
  }
  if (message.type === "state") {
    setState(message.value);
    return;
  }
  if (message.type === "transcript") {
    setText(transcript, message.text);
    detectedLanguage.textContent = message.language;
    appendHistory({ role: "user", text: message.text });
    return;
  }
  if (message.type === "assistant_start") {
    responseText = "";
    setText(response, "");
    return;
  }
  if (message.type === "assistant_delta") {
    responseText += message.text;
    setText(response, responseText);
    return;
  }
  if (message.type === "assistant_end") {
    const text = message.text || responseText;
    setText(response, text);
    if (text) appendHistory({ role: "assistant", text });
    void refreshSessions().catch(() => undefined);
    return;
  }
  if (message.type === "tts_start") {
    ttsEnded = false;
    return;
  }
  if (message.type === "tts_audio") {
    audioQueue.push(message);
    playNext();
    return;
  }
  if (message.type === "tts_end") {
    ttsEnded = true;
    playNext();
    return;
  }
  if (message.type === "cancel_audio") {
    cancelAudio();
    return;
  }
  if (message.type === "error") {
    setState("error");
    stateDetail.textContent = message.message;
  }
}

function connect(): void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = activeSessionId ? `?session=${encodeURIComponent(activeSessionId)}` : "";
  socket = new WebSocket(`${protocol}//${window.location.host}/ws${query}`);
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = parseMessage(event.data);
    if (message) handleMessage(message);
  });
  socket.addEventListener("close", () => {
    connectionDot.classList.remove("connected");
    connectionLabel.textContent = "Reconnecting";
    window.setTimeout(connect, 1000);
  });
  socket.addEventListener("error", () => {
    connectionLabel.textContent = "Connection error";
  });
}

async function startRecording(): Promise<void> {
  if (socket?.readyState !== WebSocket.OPEN) {
    throw new Error("The voice server is still connecting");
  }
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule("/pcm-worklet.js");
  await audioContext.resume();

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, "pcm-worklet");
  const silentOutput = audioContext.createGain();
  silentOutput.gain.value = 0;
  sourceNode.connect(workletNode);
  workletNode.connect(silentOutput);
  silentOutput.connect(audioContext.destination);
  workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (recording && socket?.readyState === WebSocket.OPEN) {
      socket.send(event.data);
    }
  };

  recording = true;
  voiceButton.classList.add("active");
  voiceButtonLabel.textContent = "Stop conversation";
  language.disabled = true;
  send({ type: "start", language: language.value });
}

async function stopRecording(): Promise<void> {
  recording = false;
  send({ type: "stop" });
  workletNode?.disconnect();
  sourceNode?.disconnect();
  for (const track of mediaStream?.getTracks() || []) track.stop();
  await audioContext?.close();
  mediaStream = undefined;
  audioContext = undefined;
  sourceNode = undefined;
  workletNode = undefined;
  voiceButton.classList.remove("active");
  voiceButtonLabel.textContent = "Start conversation";
  language.disabled = false;
}

voiceButton.addEventListener("click", () => {
  void (recording ? stopRecording() : startRecording()).catch((error: unknown) => {
    setState("error");
    stateDetail.textContent = error instanceof Error ? error.message : String(error);
  });
});

textForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  send({ type: "text", text });
  textInput.value = "";
});

sessionSelect.addEventListener("change", () => {
  const sessionId = sessionSelect.value;
  if (!sessionId || sessionId === activeSessionId) return;
  cancelAudio();
  setState("connecting");
  send({ type: "open_session", sessionId });
});

newSessionButton.addEventListener("click", () => {
  cancelAudio();
  setState("connecting");
  send({ type: "new_session" });
});

uploadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const file = fileInput.files?.[0];
    if (!file) throw new Error("Choose a file first");
    if (!activeSessionId) throw new Error("The conversation is still connecting");

    uploadButton.disabled = true;
    uploadStatus.textContent = `Uploading ${file.name}…`;
    const body = new FormData();
    body.append("file", file);
    const result = await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/files`, {
      method: "POST",
      body,
    });
    const payload = await parseJsonResponse<{ name?: string; path?: string; error?: string }>(
      result,
    );
    if (!result.ok || !payload.name || !payload.path) {
      throw new Error(payload.error || "Upload failed");
    }

    uploadStatus.textContent = `${payload.name} uploaded. Vaani is reading it now.`;
    fileInput.value = "";
    send({ type: "file", path: payload.path });
  })()
    .catch((error: unknown) => {
      uploadStatus.textContent = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      uploadButton.disabled = !activeSessionId;
    });
});

window.addEventListener("beforeunload", () => {
  for (const track of mediaStream?.getTracks() || []) track.stop();
  socket?.close();
});

uploadButton.disabled = !activeSessionId;
connect();
