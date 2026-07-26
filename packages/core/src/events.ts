import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface AgentConfig {
  provider: "openai";
  model: string;
  apiKey: string;
  systemPrompt: string;
  tools?: AgentTool[];
  cwd?: string;
}

export type AgentEvent =
  | { type: "turn_start"; turnId: string; text: string }
  | { type: "assistant_start"; turnId: string }
  | { type: "assistant_delta"; turnId: string; text: string }
  | { type: "tool_start"; turnId: string; name: string; args: unknown }
  | {
      type: "tool_end";
      turnId: string;
      name: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "assistant_end"; turnId: string; text: string }
  | { type: "turn_cancelled"; turnId: string; reason: string }
  | { type: "turn_error"; turnId: string; error: Error };

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export interface AgentRuntime {
  prompt(text: string): Promise<string>;
  abort(reason?: string): Promise<void>;
  reset(): Promise<void>;
  subscribe(listener: AgentEventListener): () => void;
  readonly busy: boolean;
}
