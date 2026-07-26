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
const appShell = requiredElement<HTMLElement>(".app-shell");
const voiceButtonLabel = requiredElement("#voice-button-label");
const interruptButton = requiredElement<HTMLButtonElement>("#interrupt-button");
const language = requiredElement<HTMLSelectElement>("#language");
const connectionDot = requiredElement("#connection-dot");
const connectionLabel = requiredElement("#connection-label");
const orb = requiredElement<HTMLElement>("#orb");
const stateLabel = requiredElement("#state-label");
const stateDetail = requiredElement("#state-detail");
const textForm = requiredElement<HTMLFormElement>("#text-form");
const textInput = requiredElement<HTMLTextAreaElement>("#text-input");
const sessionSelect = requiredElement<HTMLSelectElement>("#session-select");
const sessionList = requiredElement<HTMLElement>("#session-list");
const newSessionButton = requiredElement<HTMLButtonElement>("#new-session");
const sidebar = requiredElement<HTMLElement>("#sidebar");
const sidebarOpenButton = requiredElement<HTMLButtonElement>("#sidebar-open");
const sidebarToggleButton = requiredElement<HTMLButtonElement>("#sidebar-toggle");
const sidebarBackdrop = requiredElement<HTMLButtonElement>("#sidebar-backdrop");
const history = requiredElement("#history");
const historyCount = requiredElement("#history-count");
const conversationView = requiredElement<HTMLElement>(".conversation-view");
const uploadForm = requiredElement<HTMLFormElement>("#upload-form");
const fileInput = requiredElement<HTMLInputElement>("#file-input");
const uploadButton = requiredElement<HTMLButtonElement>("#upload-button");
const uploadStatus = requiredElement("#upload-status");
const addButton = requiredElement<HTMLButtonElement>("#add-button");
const settingsButton = requiredElement<HTMLButtonElement>("#settings-button");
const settingsPanel = requiredElement<HTMLElement>("#settings-panel");
const speakerButton = requiredElement<HTMLButtonElement>("#speaker-button");
const sendButton = requiredElement<HTMLButtonElement>("#send-button");

let socket: WebSocket | undefined;
let mediaStream: MediaStream | undefined;
let audioContext: AudioContext | undefined;
let sourceNode: MediaStreamAudioSourceNode | undefined;
let workletNode: AudioWorkletNode | undefined;
let currentAudio: HTMLAudioElement | undefined;
let activeSessionId = window.localStorage.getItem("sia-session") || "";
let historyMessages: ConversationMessage[] = [];
let recording = false;
let responseText = "";
let ttsEnded = false;
let muted = false;
let pendingUserEcho: string | undefined;
let activeAssistant:
  | {
      item: HTMLElement;
      text: HTMLParagraphElement;
    }
  | undefined;
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
  interruptButton.disabled = !["speaking", "thinking", "tool"].includes(state);
}

function createMessage(message: ConversationMessage): HTMLElement {
  const item = document.createElement("article");
  item.className = `history-message ${message.role}`;
  const role = document.createElement("span");
  role.textContent = message.role === "user" ? "You" : "Sia";
  const text = document.createElement("p");
  text.textContent = message.text;
  item.append(role, text);
  return item;
}

function updateHistoryCount(): void {
  const count = historyMessages.length;
  historyCount.textContent = `${count} ${count === 1 ? "message" : "messages"}`;
}

function scrollToLatest(): void {
  window.requestAnimationFrame(() => {
    conversationView.scrollTop = conversationView.scrollHeight;
  });
}

function removeEmptyHistory(): void {
  history.querySelector(".history-empty")?.remove();
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
  activeAssistant = undefined;
  history.replaceChildren();

  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "This conversation is just getting started.";
    history.append(empty);
  } else {
    for (const message of messages) {
      history.append(createMessage(message));
    }
  }

  updateHistoryCount();
  scrollToLatest();
}

function appendHistory(message: ConversationMessage): void {
  removeEmptyHistory();
  historyMessages.push(message);
  history.append(createMessage(message));
  updateHistoryCount();
  scrollToLatest();
}

function startAssistantMessage(): void {
  if (activeAssistant) return;
  removeEmptyHistory();
  const item = createMessage({ role: "assistant", text: "" });
  item.classList.add("streaming");
  const text = item.querySelector("p");
  if (!text) throw new Error("Assistant message is missing its text element");
  history.append(item);
  activeAssistant = { item, text };
  scrollToLatest();
}

function streamAssistantMessage(text: string): void {
  if (!activeAssistant) startAssistantMessage();
  if (!activeAssistant) return;
  activeAssistant.text.textContent = text;
  scrollToLatest();
}

function commitAssistantMessage(text: string): void {
  if (!activeAssistant && text) startAssistantMessage();
  if (!activeAssistant) return;

  if (!text) {
    activeAssistant.item.remove();
  } else {
    activeAssistant.text.textContent = text;
    activeAssistant.item.classList.remove("streaming");
    historyMessages.push({ role: "assistant", text });
  }
  activeAssistant = undefined;
  updateHistoryCount();
  scrollToLatest();
}

function sessionTitle(session: SessionSummary): string {
  return session.firstMessage === "(no messages)"
    ? "New conversation"
    : session.firstMessage.replace(/\s+/g, " ").slice(0, 46);
}

function sessionDate(modified: string): string {
  const date = new Date(modified);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function closeSidebarOnMobile(): void {
  sidebar.classList.remove("open");
  sidebarBackdrop.classList.remove("visible");
  sidebarOpenButton.setAttribute("aria-expanded", "false");
}

function openSession(sessionId: string): void {
  closeSidebarOnMobile();
  if (!sessionId || sessionId === activeSessionId) return;
  cancelAudio();
  commitAssistantMessage(responseText);
  responseText = "";
  setState("connecting");
  send({ type: "open_session", sessionId });
}

async function refreshSessions(): Promise<void> {
  const response = await fetch("/api/sessions");
  if (!response.ok) throw new Error("Could not load conversations");
  const payload = await parseJsonResponse<{ sessions: SessionSummary[] }>(response);
  sessionSelect.replaceChildren();
  sessionList.replaceChildren();

  if (activeSessionId && !payload.sessions.some((session) => session.id === activeSessionId)) {
    payload.sessions.unshift({
      id: activeSessionId,
      firstMessage: "(no messages)",
      modified: new Date().toISOString(),
    });
  }

  for (const session of payload.sessions) {
    const title = sessionTitle(session);
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = title;
    sessionSelect.append(option);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-item";
    button.dataset.sessionId = session.id;
    button.title = title;
    if (session.id === activeSessionId) {
      button.classList.add("active");
      button.setAttribute("aria-current", "page");
    }

    const marker = document.createElement("span");
    marker.className = "session-marker";
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "session-copy sidebar-label";
    const name = document.createElement("span");
    name.className = "session-title";
    name.textContent = title;
    const modified = document.createElement("span");
    modified.className = "session-date";
    modified.textContent = sessionDate(session.modified);
    copy.append(name, modified);
    button.append(marker, copy);
    sessionList.append(button);
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
  player.muted = muted;
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
    window.localStorage.setItem("sia-session", message.id);
    renderHistory(message.history);
    pendingUserEcho = undefined;
    responseText = "";
    uploadButton.disabled = false;
    void refreshSessions().catch(() => undefined);
    return;
  }
  if (message.type === "state") {
    setState(message.value);
    return;
  }
  if (message.type === "transcript") {
    commitAssistantMessage(responseText);
    responseText = "";
    if (pendingUserEcho === message.text) {
      pendingUserEcho = undefined;
      return;
    }
    appendHistory({ role: "user", text: message.text });
    return;
  }
  if (message.type === "assistant_start") {
    responseText = "";
    startAssistantMessage();
    return;
  }
  if (message.type === "assistant_delta") {
    responseText += message.text;
    streamAssistantMessage(responseText);
    return;
  }
  if (message.type === "assistant_end") {
    const text = message.text || responseText;
    commitAssistantMessage(text);
    responseText = "";
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
  voiceButton.setAttribute("aria-label", "Stop conversation");
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
  voiceButton.setAttribute("aria-label", "Start conversation");
  language.disabled = false;
}

voiceButton.addEventListener("click", () => {
  void (recording ? stopRecording() : startRecording()).catch((error: unknown) => {
    setState("error");
    stateDetail.textContent = error instanceof Error ? error.message : String(error);
  });
});

interruptButton.addEventListener("click", () => {
  cancelAudio();
  commitAssistantMessage(responseText);
  responseText = "";
  interruptButton.disabled = true;
  send({ type: "cancel" });
  setState(recording ? "listening" : "idle");
});

textForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  commitAssistantMessage(responseText);
  responseText = "";
  appendHistory({ role: "user", text });
  pendingUserEcho = text;
  send({ type: "text", text });
  textInput.value = "";
  sendButton.disabled = true;
});

textInput.addEventListener("input", () => {
  sendButton.disabled = !textInput.value.trim();
  textInput.style.height = "auto";
  textInput.style.height = `${Math.min(textInput.scrollHeight, 96)}px`;
});

textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    textForm.requestSubmit();
  }
});

addButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) uploadForm.requestSubmit();
});

settingsButton.addEventListener("click", () => {
  const willOpen = settingsPanel.hidden;
  settingsPanel.hidden = !willOpen;
  settingsButton.setAttribute("aria-expanded", String(willOpen));
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (
    !settingsPanel.hidden &&
    target instanceof Node &&
    !settingsPanel.contains(target) &&
    !settingsButton.contains(target)
  ) {
    settingsPanel.hidden = true;
    settingsButton.setAttribute("aria-expanded", "false");
  }
});

speakerButton.addEventListener("click", () => {
  muted = !muted;
  if (currentAudio) currentAudio.muted = muted;
  speakerButton.classList.toggle("active", muted);
  speakerButton.setAttribute("aria-pressed", String(muted));
  speakerButton.setAttribute(
    "aria-label",
    muted ? "Unmute voice responses" : "Mute voice responses",
  );
});

sessionSelect.addEventListener("change", () => {
  openSession(sessionSelect.value);
});

sessionList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>(".session-item");
  if (button?.dataset.sessionId) openSession(button.dataset.sessionId);
});

newSessionButton.addEventListener("click", () => {
  closeSidebarOnMobile();
  cancelAudio();
  commitAssistantMessage(responseText);
  responseText = "";
  setState("connecting");
  send({ type: "new_session" });
});

sidebarOpenButton.addEventListener("click", () => {
  sidebar.classList.add("open");
  sidebarBackdrop.classList.add("visible");
  sidebarOpenButton.setAttribute("aria-expanded", "true");
});

sidebarToggleButton.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 860px)").matches) {
    closeSidebarOnMobile();
    return;
  }
  const collapsed = !appShell.classList.contains("sidebar-collapsed");
  appShell.classList.toggle("sidebar-collapsed", collapsed);
  sidebarToggleButton.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggleButton.setAttribute(
    "aria-label",
    collapsed ? "Expand conversations" : "Collapse conversations",
  );
  window.localStorage.setItem("sia-sidebar-collapsed", String(collapsed));
});

sidebarBackdrop.addEventListener("click", closeSidebarOnMobile);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSidebarOnMobile();
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

    uploadStatus.textContent = `${payload.name} uploaded. Sia is reading it now.`;
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
const sidebarStartsCollapsed = window.localStorage.getItem("sia-sidebar-collapsed") === "true";
appShell.classList.toggle("sidebar-collapsed", sidebarStartsCollapsed);
sidebarToggleButton.setAttribute("aria-expanded", String(!sidebarStartsCollapsed));
sidebarToggleButton.setAttribute(
  "aria-label",
  sidebarStartsCollapsed ? "Expand conversations" : "Collapse conversations",
);
connect();
