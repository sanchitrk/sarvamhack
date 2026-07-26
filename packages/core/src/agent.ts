import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  type AgentSessionEvent,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type AssistantMessage,
  type TextContent,
  type UserMessage,
} from "@earendil-works/pi-ai";

import { resolveOpenAIModel } from "./config.ts";
import {
  AgentBusyError,
  AgentCancelledError,
  AgentConfigError,
  AgentInputError,
} from "./errors.ts";
import {
  createDocumentIntelligenceTool,
  DOCUMENT_INTELLIGENCE_TOOL_NAME,
} from "./tools/document.ts";
import type {
  AgentConfig,
  AgentEvent,
  AgentEventListener,
  AgentRuntime,
  AgentSessionOptions,
  AgentSessionSummary,
  ConversationMessage,
} from "./events.ts";

export type HarnessEvent =
  | { type: "assistant_start" }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_end"; name: string; result: unknown; isError: boolean };

export interface AgentHarnessAdapter {
  prompt(text: string): Promise<string>;
  abort(): Promise<void>;
  subscribe(listener: (event: HarnessEvent) => void | Promise<void>): () => void;
  history?(): ConversationMessage[];
  dispose?(): void;
  readonly sessionId?: string;
}

export type AgentHarnessFactory = () => Promise<AgentHarnessAdapter>;

interface ActiveTurn {
  id: string;
  cancelled: boolean;
  cancellationReason: string;
  cancellationEmitted: boolean;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function contentText(content: UserMessage["content"] | AssistantMessage["content"]): string {
  if (typeof content === "string") return content.trim();
  return content
    .filter((entry): entry is TextContent => entry.type === "text")
    .map((entry) => entry.text)
    .join("")
    .trim();
}

function assistantText(message: AssistantMessage): string {
  return contentText(message.content);
}

function conversationHistory(messages: AgentMessage[]): ConversationMessage[] {
  const history: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = contentText(message.content);
    if (text) history.push({ role: message.role, text });
  }
  return history;
}

export function translatePiEvent(event: AgentSessionEvent): HarnessEvent | undefined {
  if (event.type === "message_start" && event.message.role === "assistant") {
    return { type: "assistant_start" };
  }

  if (
    event.type === "message_update" &&
    event.message.role === "assistant" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    return {
      type: "assistant_delta",
      text: event.assistantMessageEvent.delta,
    };
  }

  if (event.type === "tool_execution_start") {
    return {
      type: "tool_start",
      name: event.toolName,
      args: event.args,
    };
  }

  if (event.type === "tool_execution_end") {
    return {
      type: "tool_end",
      name: event.toolName,
      result: event.result,
      isError: event.isError,
    };
  }

  return undefined;
}

export async function createRuntimeWithHarness(
  createHarness: AgentHarnessFactory,
): Promise<AgentRuntime> {
  const listeners = new Set<AgentEventListener>();
  let harness = await createHarness();
  let activeTurn: ActiveTurn | undefined;

  async function emit(event: AgentEvent): Promise<void> {
    for (const listener of listeners) {
      try {
        await listener(event);
      } catch {
        // A UI, logger, or speech listener must not break the agent loop.
      }
    }
  }

  async function forward(event: HarnessEvent): Promise<void> {
    const turn = activeTurn;
    if (!turn || turn.cancelled) return;

    if (event.type === "assistant_start") {
      await emit({ type: "assistant_start", turnId: turn.id });
      return;
    }
    if (event.type === "assistant_delta") {
      await emit({
        type: "assistant_delta",
        turnId: turn.id,
        text: event.text,
      });
      return;
    }
    if (event.type === "tool_start") {
      await emit({
        type: "tool_start",
        turnId: turn.id,
        name: event.name,
        args: event.args,
      });
      return;
    }
    await emit({
      type: "tool_end",
      turnId: turn.id,
      name: event.name,
      result: event.result,
      isError: event.isError,
    });
  }

  let unsubscribeHarness = harness.subscribe(forward);

  async function abortTurn(reason = "cancelled"): Promise<void> {
    const turn = activeTurn;
    if (!turn || turn.cancelled) return;

    turn.cancelled = true;
    turn.cancellationReason = reason;
    try {
      await harness.abort();
    } finally {
      if (!turn.cancellationEmitted) {
        turn.cancellationEmitted = true;
        await emit({
          type: "turn_cancelled",
          turnId: turn.id,
          reason,
        });
      }
      if (activeTurn === turn) activeTurn = undefined;
    }
  }

  return {
    get busy() {
      return activeTurn !== undefined;
    },

    get sessionId() {
      return harness.sessionId || "memory";
    },

    async prompt(text) {
      const normalized = text.trim();
      if (!normalized) {
        throw new AgentInputError("Prompt text cannot be blank");
      }
      if (activeTurn) throw new AgentBusyError();

      const turn: ActiveTurn = {
        id: randomUUID(),
        cancelled: false,
        cancellationReason: "cancelled",
        cancellationEmitted: false,
      };
      activeTurn = turn;
      await emit({ type: "turn_start", turnId: turn.id, text: normalized });

      try {
        if (turn.cancelled) {
          throw new AgentCancelledError(turn.cancellationReason);
        }
        const response = await harness.prompt(normalized);
        if (turn.cancelled) {
          throw new AgentCancelledError(turn.cancellationReason);
        }
        await emit({
          type: "assistant_end",
          turnId: turn.id,
          text: response,
        });
        return response;
      } catch (error) {
        if (turn.cancelled) {
          throw new AgentCancelledError(turn.cancellationReason);
        }
        const normalizedError = toError(error);
        await emit({
          type: "turn_error",
          turnId: turn.id,
          error: normalizedError,
        });
        throw normalizedError;
      } finally {
        if (activeTurn === turn) activeTurn = undefined;
      }
    },

    abort: abortTurn,

    async reset() {
      if (activeTurn) {
        await abortTurn("session reset");
      }
      unsubscribeHarness();
      harness.dispose?.();
      harness = await createHarness();
      unsubscribeHarness = harness.subscribe(forward);
    },

    history() {
      return harness.history?.() || [];
    },

    dispose() {
      unsubscribeHarness();
      harness.dispose?.();
      listeners.clear();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function sessionManagerFor(
  cwd: string,
  options: AgentSessionOptions,
): Promise<SessionManager> {
  const sessionId = options.sessionId;
  if (!sessionId) return SessionManager.create(cwd, options.sessionsDir);

  const sessions = options.sessionsDir
    ? await SessionManager.listAll(options.sessionsDir)
    : await SessionManager.list(cwd);
  const existing = sessions.find((session) => session.id === sessionId);
  return existing
    ? SessionManager.open(existing.path, options.sessionsDir, cwd)
    : SessionManager.create(cwd, options.sessionsDir, { id: sessionId });
}

export async function listAgentSessions(sessionsDir: string): Promise<AgentSessionSummary[]> {
  const sessions = await SessionManager.listAll(sessionsDir);
  return sessions.map((session) => ({
    id: session.id,
    name: session.name,
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
  }));
}

export async function createAgent(
  config: AgentConfig,
  options: AgentSessionOptions = {},
): Promise<AgentRuntime> {
  if (!config.apiKey.trim()) {
    throw new AgentConfigError("OpenAI API key cannot be blank");
  }

  const model = resolveOpenAIModel(config.model);
  const cwd = config.cwd || process.cwd();
  const agentDir = options.agentDir || join(options.sessionsDir || cwd, ".agent");
  const documentTools = config.sarvamApiKey
    ? [createDocumentIntelligenceTool({ apiKey: config.sarvamApiKey })]
    : [];
  const defaultTools = [
    "read",
    "grep",
    "find",
    "ls",
    ...(documentTools.length > 0 ? [DOCUMENT_INTELLIGENCE_TOOL_NAME] : []),
  ];
  let requestedSessionId = options.sessionId;

  return createRuntimeWithHarness(async () => {
    const sessionManager = await sessionManagerFor(cwd, {
      ...options,
      sessionId: requestedSessionId,
    });
    requestedSessionId = undefined;

    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({
      type: "api_key",
      key: config.apiKey,
    }));
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
    });

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      systemPrompt: `${config.systemPrompt}

You can inspect files in the current workspace with read, grep, find, and ls.
When the user uploads or asks about a file, inspect it with the appropriate tool before answering.

Tools:
Use document_intelligence for PDFs, scans, document images, and ZIP archives of page images.
Never claim to have read a file unless a tool successfully returned its contents.
If a tool cannot decode the format, explain that limitation clearly.`,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
      }),
      tools: config.toolNames || defaultTools,
      customTools: documentTools,
    });

    return {
      sessionId: session.sessionId,
      async prompt(text) {
        await session.prompt(text, { expandPromptTemplates: false });
        const response = [...session.state.messages]
          .reverse()
          .find((message): message is AssistantMessage => message.role === "assistant");
        return response ? assistantText(response) : "";
      },
      async abort() {
        await session.abort();
      },
      history() {
        return conversationHistory(session.state.messages);
      },
      dispose() {
        session.dispose();
      },
      subscribe(listener) {
        return session.subscribe((event) => {
          const translated = translatePiEvent(event);
          if (translated) void listener(translated);
        });
      },
    };
  });
}
