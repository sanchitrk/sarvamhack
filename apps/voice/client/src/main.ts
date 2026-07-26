type ServerMessage =
  | { type: "ready" }
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

let socket: WebSocket | undefined;
let mediaStream: MediaStream | undefined;
let audioContext: AudioContext | undefined;
let sourceNode: MediaStreamAudioSourceNode | undefined;
let workletNode: AudioWorkletNode | undefined;
let currentAudio: HTMLAudioElement | undefined;
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
  tool: ["Working", "Using a tool to help with your request"],
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
  if (message.type === "state") {
    setState(message.value);
    return;
  }
  if (message.type === "transcript") {
    setText(transcript, message.text);
    detectedLanguage.textContent = message.language;
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
    setText(response, message.text || responseText);
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
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
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

window.addEventListener("beforeunload", () => {
  for (const track of mediaStream?.getTracks() || []) track.stop();
  socket?.close();
});

connect();
