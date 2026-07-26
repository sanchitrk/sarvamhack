import { randomUUID } from "node:crypto";

import {
  AgentHarness,
  InMemorySessionRepo,
  type AgentHarnessEvent,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

import { resolveOpenAIModel } from "./config.ts";
import {
  AgentBusyError,
  AgentCancelledError,
  AgentConfigError,
  AgentInputError,
} from "./errors.ts";
import type { AgentConfig, AgentEvent, AgentEventListener, AgentRuntime } from "./events.ts";

export type HarnessEvent =
  | { type: "assistant_start" }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_end"; name: string; result: unknown; isError: boolean };

export interface AgentHarnessAdapter {
  prompt(text: string): Promise<string>;
  abort(): Promise<void>;
  subscribe(listener: (event: HarnessEvent) => void | Promise<void>): () => void;
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

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((entry): entry is TextContent => entry.type === "text")
    .map((entry) => entry.text)
    .join("")
    .trim();
}

export function translatePiEvent(event: AgentHarnessEvent): HarnessEvent | undefined {
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
        // A UI, logger, or future speech listener must not break the agent loop.
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
      harness = await createHarness();
      unsubscribeHarness = harness.subscribe(forward);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export async function createAgent(config: AgentConfig): Promise<AgentRuntime> {
  if (!config.apiKey.trim()) {
    throw new AgentConfigError("OpenAI API key cannot be blank");
  }

  const model = resolveOpenAIModel(config.model);
  const sessions = new InMemorySessionRepo();
  const environment = new NodeExecutionEnv({
    cwd: config.cwd || process.cwd(),
  });

  return createRuntimeWithHarness(async () => {
    const session = await sessions.create({ id: randomUUID() });
    const harness = new AgentHarness({
      env: environment,
      session,
      model,
      tools: config.tools || [],
      systemPrompt: config.systemPrompt,
      getApiKeyAndHeaders: async () => ({ apiKey: config.apiKey }),
    });

    return {
      async prompt(text) {
        return assistantText(await harness.prompt(text));
      },
      async abort() {
        await harness.abort();
      },
      subscribe(listener) {
        return harness.subscribe(async (event) => {
          const translated = translatePiEvent(event);
          if (translated) await listener(translated);
        });
      },
    };
  });
}
