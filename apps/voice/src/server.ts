import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serve, type WebSocketData, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { WSContext, WSMessageReceive } from "hono/ws";
import { WebSocket as UpstreamSocket, WebSocketServer } from "ws";

import {
  createAgent,
  listAgentSessions,
  readAgentConfig,
  type AgentEvent,
  type AgentRuntime,
} from "../../../packages/core/src/index.ts";
import { createSentenceBuffer } from "./sentence.ts";
import { isSessionId, maxUploadBytes, storeUpload, uploadName, workspacePath } from "./storage.ts";

try {
  loadEnvFile(fileURLToPath(new URL("../../../packages/core/.env.local", import.meta.url)));
} catch {
  // Environment variables supplied by the process take precedence.
}

const sampleRate = 16_000;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const sarvamApiKey = requiredEnvironment("SARVAM_API_KEY");

const port = Number(process.env.PORT || 3000);
const clientRoot = fileURLToPath(new URL("../dist/client", import.meta.url));
const dataRoot = process.env.VOICE_DATA_DIR?.trim()
  ? resolve(process.env.VOICE_DATA_DIR)
  : fileURLToPath(new URL("../.data", import.meta.url));
const sessionsDir = join(dataRoot, "sessions");
const workspacesDir = join(dataRoot, "workspaces");
const agentDir = join(dataRoot, "agent");
await Promise.all([
  mkdir(sessionsDir, { recursive: true }),
  mkdir(workspacesDir, { recursive: true }),
  mkdir(agentDir, { recursive: true }),
]);

const supportedTtsLanguages = new Set([
  "bn-IN",
  "en-IN",
  "gu-IN",
  "hi-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
]);

type ClientMessage =
  | { type: "start"; language?: string }
  | { type: "stop" }
  | { type: "cancel" }
  | { type: "text"; text: string }
  | { type: "playback_done" }
  | { type: "new_session" }
  | { type: "open_session"; sessionId: string }
  | { type: "file"; path: string };

interface SarvamMessage {
  type?: unknown;
  data?: {
    transcript?: unknown;
    language_code?: unknown;
    signal_type?: unknown;
    error?: unknown;
  };
}

function isByteArrayList(value: WebSocketData): value is readonly Uint8Array[] {
  return Array.isArray(value);
}

function parseClientMessage(value: string): ClientMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return undefined;
    }
    const type = parsed.type;
    if (
      type === "stop" ||
      type === "cancel" ||
      type === "playback_done" ||
      type === "new_session"
    ) {
      return { type };
    }
    if (type === "start") {
      return {
        type,
        language:
          "language" in parsed && typeof parsed.language === "string" ? parsed.language : undefined,
      };
    }
    if (type === "text" && "text" in parsed && typeof parsed.text === "string") {
      return { type, text: parsed.text };
    }
    if (type === "open_session" && "sessionId" in parsed && typeof parsed.sessionId === "string") {
      return { type, sessionId: parsed.sessionId };
    }
    if (type === "file" && "path" in parsed && typeof parsed.path === "string") {
      return { type, path: parsed.path };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseSarvamMessage(value: WebSocketData): SarvamMessage | undefined {
  try {
    let text: string;
    if (typeof value === "string") {
      text = value;
    } else if (value instanceof ArrayBuffer) {
      text = Buffer.from(value).toString();
    } else if (isByteArrayList(value)) {
      text = Buffer.concat(value.map((entry) => Buffer.from(entry))).toString();
    } else {
      text = Buffer.from(value).toString();
    }
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as SarvamMessage) : undefined;
  } catch {
    return undefined;
  }
}

async function messageBytes(value: Exclude<WSMessageReceive, string>): Promise<Buffer> {
  if (value instanceof Blob) return Buffer.from(await value.arrayBuffer());
  return Buffer.from(new Uint8Array(value));
}

async function createSessionAgent(requestedId?: string): Promise<AgentRuntime> {
  const sessionId = requestedId && isSessionId(requestedId) ? requestedId : randomUUID();
  const workspace = workspacePath(workspacesDir, sessionId);
  await mkdir(workspace, { recursive: true });
  return createAgent(
    {
      ...readAgentConfig(),
      cwd: workspace,
    },
    {
      agentDir,
      sessionId,
      sessionsDir,
    },
  );
}

class VoiceSession {
  private agent: AgentRuntime;
  private readonly sentences = createSentenceBuffer();
  private unsubscribeAgent: () => void;
  private client: WSContext | undefined;
  private stt: UpstreamSocket | undefined;
  private language = "en-IN";
  private lastTranscript = "";
  private ttsGeneration = 0;
  private ttsSequence = 0;
  private ttsStarted = false;
  private ttsChain: Promise<void> = Promise.resolve();
  private ttsAbort: AbortController | undefined;
  private capturing = false;
  private closed = false;

  private constructor(agent: AgentRuntime) {
    this.agent = agent;
    this.unsubscribeAgent = agent.subscribe((event) => this.handleAgentEvent(event));
  }

  static async create(sessionId?: string): Promise<VoiceSession> {
    return new VoiceSession(await createSessionAgent(sessionId));
  }

  open(client: WSContext): void {
    this.client = client;
    this.send({ type: "ready" });
    this.publishSession();
    this.state("idle");
  }

  receive(value: WSMessageReceive): void {
    if (typeof value === "string") {
      const message = parseClientMessage(value);
      if (!message) {
        this.fail("Invalid client message");
        return;
      }
      void this.handleControl(message).catch((error: unknown) => {
        this.fail(error instanceof Error ? error.message : String(error));
      });
      return;
    }

    void messageBytes(value)
      .then((bytes) => this.sendAudio(bytes))
      .catch((error: unknown) => {
        this.fail(error instanceof Error ? error.message : String(error));
      });
  }

  close(): void {
    this.closed = true;
    this.stt?.close();
    this.cancelTts();
    void this.agent.abort("client disconnected");
    this.unsubscribeAgent();
    this.agent.dispose();
  }

  private send(message: object): void {
    if (!this.closed && this.client?.readyState === 1) {
      this.client.send(JSON.stringify(message));
    }
  }

  private state(value: string): void {
    this.send({ type: "state", value });
  }

  private rest(): void {
    this.state(this.capturing ? "listening" : "idle");
  }

  private publishSession(): void {
    this.send({
      type: "session",
      id: this.agent.sessionId,
      history: this.agent.history(),
    });
  }

  private fail(message: string): void {
    this.send({ type: "error", message });
    this.state("error");
  }

  private async handleControl(message: ClientMessage): Promise<void> {
    if (message.type === "new_session") {
      await this.replaceAgent();
      return;
    }
    if (message.type === "open_session") {
      if (!isSessionId(message.sessionId)) {
        this.fail("Invalid session ID");
        return;
      }
      const sessions = await listAgentSessions(sessionsDir);
      if (!sessions.some((session) => session.id === message.sessionId)) {
        this.fail("Conversation not found");
        return;
      }
      await this.replaceAgent(message.sessionId);
      return;
    }
    if (message.type === "start") {
      this.capturing = true;
      this.connectStt(message.language || "unknown");
      return;
    }
    if (message.type === "stop") {
      this.capturing = false;
      if (this.stt?.readyState === UpstreamSocket.OPEN) {
        this.stt.send(JSON.stringify({ type: "flush" }));
      }
      this.rest();
      return;
    }
    if (message.type === "cancel") {
      await this.interrupt("user cancelled");
      this.rest();
      return;
    }
    if (message.type === "playback_done") {
      this.rest();
      return;
    }
    if (message.type === "file") {
      let relativePath: string;
      try {
        relativePath = uploadName(message.path);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
        return;
      }
      const workspace = workspacePath(workspacesDir, this.agent.sessionId);
      try {
        await access(join(workspace, relativePath));
      } catch {
        this.fail("Uploaded file not found");
        return;
      }
      await this.submitTranscript(
        `I uploaded a file at "./${relativePath}" in your current workspace. Read that path with your file tools and briefly explain its contents.`,
        this.language,
      );
      return;
    }
    await this.submitTranscript(message.text, this.language);
  }

  private async replaceAgent(sessionId?: string): Promise<void> {
    await this.interrupt("session changed");
    this.unsubscribeAgent();
    this.agent.dispose();
    const agent = await createSessionAgent(sessionId);
    if (this.closed) {
      agent.dispose();
      return;
    }
    this.agent = agent;
    this.unsubscribeAgent = agent.subscribe((event) => this.handleAgentEvent(event));
    this.lastTranscript = "";
    this.publishSession();
    this.state("idle");
  }

  private connectStt(language: string): void {
    this.stt?.close();
    this.state("connecting");

    const query = new URLSearchParams({
      model: "saaras:v3",
      mode: "transcribe",
      "language-code": language,
      sample_rate: String(sampleRate),
      input_audio_codec: "pcm_s16le",
      high_vad_sensitivity: "true",
      vad_signals: "true",
      flush_signal: "true",
    });
    const socket = new UpstreamSocket(`wss://api.sarvam.ai/speech-to-text/ws?${query}`, {
      headers: {
        "api-subscription-key": sarvamApiKey,
      },
    });
    this.stt = socket;

    socket.on("open", () => {
      this.state("listening");
    });
    socket.on("message", (value) => {
      this.handleSarvamMessage(parseSarvamMessage(value));
    });
    socket.on("error", (error) => {
      this.fail(`Speech recognition failed: ${error.message}`);
    });
    socket.on("close", () => {
      if (!this.closed && this.stt === socket) this.state("idle");
    });
  }

  private sendAudio(bytes: Buffer): void {
    if (this.stt?.readyState !== UpstreamSocket.OPEN || bytes.length === 0) {
      return;
    }
    this.stt.send(
      JSON.stringify({
        audio: {
          data: bytes.toString("base64"),
          sample_rate: sampleRate,
          encoding: "audio/wav",
        },
      }),
    );
  }

  private handleSarvamMessage(message: SarvamMessage | undefined): void {
    if (!message) return;

    if (message.type === "events") {
      const signal = message.data?.signal_type;
      if (signal === "START_SPEECH") {
        this.send({ type: "speech_start" });
        this.state("hearing");
        void this.interrupt("barge-in");
      }
      if (signal === "END_SPEECH") {
        this.send({ type: "speech_end" });
      }
      return;
    }

    if (message.type === "error") {
      const error = message.data?.error;
      this.fail(typeof error === "string" ? error : "Sarvam STT failed");
      return;
    }

    const transcript = message.data?.transcript;
    if (message.type !== "data" || typeof transcript !== "string") return;
    const language =
      typeof message.data?.language_code === "string" ? message.data.language_code : this.language;
    void this.submitTranscript(transcript, language);
  }

  private async submitTranscript(transcript: string, language: string): Promise<void> {
    const text = transcript.trim();
    if (!text || text === this.lastTranscript) return;
    this.lastTranscript = text;
    this.language = supportedTtsLanguages.has(language) ? language : "en-IN";

    await this.interrupt("new utterance");
    this.send({ type: "transcript", text, language });
    this.state("thinking");

    try {
      await this.agent.prompt(text);
    } catch (error) {
      if (error instanceof Error && error.name === "AgentCancelledError") return;
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async interrupt(reason: string): Promise<void> {
    this.cancelTts();
    this.sentences.clear();
    this.send({ type: "cancel_audio" });
    if (this.agent.busy) await this.agent.abort(reason);
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.type === "assistant_start") {
      this.sentences.clear();
      this.ttsStarted = false;
      this.send({ type: "assistant_start" });
      return;
    }
    if (event.type === "assistant_delta") {
      this.send({ type: "assistant_delta", text: event.text });
      for (const chunk of this.sentences.push(event.text)) {
        this.enqueueTts(chunk);
      }
      return;
    }
    if (event.type === "tool_start") {
      this.send({ type: "tool_start", name: event.name });
      this.state("tool");
      return;
    }
    if (event.type === "tool_end") {
      this.send({
        type: "tool_end",
        name: event.name,
        isError: event.isError,
      });
      return;
    }
    if (event.type === "assistant_end") {
      const tail = this.sentences.flush();
      if (tail) this.enqueueTts(tail);
      this.send({ type: "assistant_end", text: event.text });
      this.finishTts();
      return;
    }
    if (event.type === "turn_error") this.fail(event.error.message);
  }

  private enqueueTts(text: string): void {
    const generation = this.ttsGeneration;
    if (!this.ttsStarted) {
      this.ttsStarted = true;
      this.ttsSequence = 0;
      this.send({ type: "tts_start" });
      this.state("speaking");
    }

    this.ttsChain = this.ttsChain
      .then(async () => {
        if (generation !== this.ttsGeneration || this.closed) return;

        const controller = new AbortController();
        this.ttsAbort = controller;
        const response = await fetch("https://api.sarvam.ai/text-to-speech/stream", {
          method: "POST",
          headers: {
            "api-subscription-key": sarvamApiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text,
            target_language_code: this.language,
            speaker: process.env.SARVAM_TTS_SPEAKER || "shubh",
            model: "bulbul:v3",
            pace: 1,
            output_audio_codec: "mp3",
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Sarvam TTS returned ${response.status}: ${await response.text()}`);
        }

        const audio = Buffer.from(await response.arrayBuffer()).toString("base64");
        if (generation !== this.ttsGeneration || this.closed) return;
        this.send({
          type: "tts_audio",
          sequence: this.ttsSequence,
          mimeType: response.headers.get("content-type") || "audio/mpeg",
          audio,
        });
        this.ttsSequence += 1;
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        this.fail(error instanceof Error ? error.message : String(error));
      });
  }

  private finishTts(): void {
    const generation = this.ttsGeneration;
    const pending = this.ttsChain;
    void pending.then(() => {
      if (generation !== this.ttsGeneration || this.closed) return;
      this.send({ type: "tts_end" });
      if (!this.ttsStarted) this.rest();
    });
  }

  private cancelTts(): void {
    this.ttsGeneration += 1;
    this.ttsAbort?.abort();
    this.ttsAbort = undefined;
    this.ttsChain = Promise.resolve();
    this.ttsStarted = false;
  }
}

const app = new Hono();
app.get("/health", (context) =>
  context.json({
    ok: true,
    stt: "saaras:v3",
    tts: "bulbul:v3",
  }),
);
app.get("/api/sessions", async (context) =>
  context.json({
    sessions: await listAgentSessions(sessionsDir),
  }),
);
app.post("/api/sessions/:sessionId/files", async (context) => {
  const sessionId = context.req.param("sessionId");
  if (!isSessionId(sessionId)) return context.json({ error: "Invalid session ID" }, 400);

  try {
    await access(workspacePath(workspacesDir, sessionId));
  } catch {
    return context.json({ error: "Conversation not found" }, 404);
  }

  try {
    const body = await context.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return context.json({ error: "A file is required" }, 400);
    if (file.size > maxUploadBytes) {
      return context.json({ error: "File exceeds the 5 MB limit" }, 413);
    }

    const name = await storeUpload(
      workspacesDir,
      sessionId,
      file.name,
      new Uint8Array(await file.arrayBuffer()),
    );
    return context.json({
      name,
      path: name,
    });
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
app.get(
  "/ws",
  upgradeWebSocket(
    async (context) => {
      const requestedSession = context.req.query("session");
      const session = await VoiceSession.create(requestedSession);
      return {
        onOpen(_event, client) {
          session.open(client);
        },
        onMessage(event) {
          session.receive(event.data);
        },
        onClose() {
          session.close();
        },
        onError() {
          session.close();
        },
      };
    },
    {
      onError(error) {
        console.error(error);
      },
    },
  ),
);
app.use(
  "/*",
  serveStatic({
    root: clientRoot,
    rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
  }),
);

const websocketServer = new WebSocketServer({ noServer: true });
serve(
  {
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port,
    websocket: { server: websocketServer },
  },
  ({ port: activePort }) => {
    console.log(`Voice agent server: http://127.0.0.1:${activePort}`);
  },
);
