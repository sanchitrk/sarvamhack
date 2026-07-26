# Layer 1: Minimum Agent Loop

**Status:** Implemented  
**Date:** 2026-07-26  
**Git commit:** `fb997db`

## 1. Purpose

Layer 1 is the smallest useful conversational agent:

1. Accept one finalized user text utterance.
2. Send it through a stateful Pi agent backed by OpenAI.
3. Stream assistant text and tool lifecycle events.
4. Preserve conversation context for the session.
5. Allow the active turn to be cancelled.

This layer is text-first. It does not record, transcribe, synthesize, or play audio yet. Its public events and cancellation behavior are designed so Sarvam speech-to-text and text-to-speech can be added without changing the agent loop.

The end-state product is an intelligent voice agent that listens to a user, reasons and optionally uses tools, then replies aloud.

## 2. Hackathon Principle

Build one vertical seam at a time:

```text
Layer 1: text -> Pi agent/OpenAI -> streamed text
Layer 2: microphone -> Sarvam STT -> Layer 1
Layer 3: Layer 1 deltas -> Sarvam TTS -> speaker
Layer 4: turn detection, barge-in, latency tuning, and resilience
```

Layer 1 must be independently runnable and testable from a terminal. Audio must not be required to prove the core loop.

## 3. Reference Findings from PiBot

PiBot is reference material only; no code is copied.

The useful patterns in `.repos/pibot` are:

- `AgentHarness` owns the model interaction, session context, tool loop, and abort behavior.
- `InMemorySessionRepo` is enough for an initial session.
- `NodeExecutionEnv` supplies the runtime environment.
- Pi model selection is separated from the agent harness.
- Pi events are translated into a small application-owned event union.
- Assistant text deltas are exposed as they arrive instead of waiting for the complete response.
- Speech orchestration is outside the Pi harness.
- Barge-in cancels both speech output and `harness.abort()`.

The parts intentionally excluded from Layer 1 are PiBot's robot controls, local LLM server, local STT/TTS workers, browser protocol, authentication, persistent memory, and multi-user runtime.

## 4. Decisions

### 4.1 Pi packages

Start with the same tested package family and pinned version used by the vendored PiBot:

```json
{
  "@earendil-works/pi-agent-core": "0.78.1",
  "@earendil-works/pi-ai": "0.78.1"
}
```

Pin exact versions for the hackathon. Upgrading to the current release is a separate task because Pi package APIs are moving quickly.

### 4.2 Model provider

Layer 1 supports OpenAI first:

- `PI_PROVIDER=openai`
- `PI_MODEL=<model id>`
- `OPENAI_API_KEY=<secret>`

`PI_MODEL` is explicit configuration rather than a code constant. The implementation validates it with Pi AI's model catalog using `getModels()` and `getModel()`.

No Sarvam LLM is required for Layer 1. The provider boundary remains replaceable because model selection belongs in configuration, not in the conversation loop.

### 4.3 Session storage

Use `InMemorySessionRepo`.

Consequences:

- Conversation context survives across turns in one process.
- Context is lost on process restart.
- One `AgentRuntime` represents one user session.
- Persistent sessions are deliberately deferred.

### 4.4 Tools

The runtime accepts `AgentTool[]`, but Layer 1 starts with an empty array.

This proves the real Pi agent loop without inventing hackathon tools too early. A tiny deterministic test tool may exist only in tests to verify tool event forwarding.

### 4.5 Streaming

Stream assistant deltas immediately. Do not wait for the full response.

This is required for low-latency TTS later: complete speakable chunks can be sent to Sarvam while the model continues generating.

### 4.6 Turn concurrency

One session runs at most one agent turn at a time.

Calling `prompt()` while busy returns a typed `AgentBusyError`. A future voice coordinator must cancel the active turn before submitting a barge-in utterance.

## 5. Architecture

```text
                     Layer 1
┌──────────────┐   finalized text   ┌───────────────────┐
│ CLI / future │ ─────────────────> │ AgentRuntime      │
│ STT adapter  │                    │                   │
└──────────────┘                    │ - Pi AgentHarness │
                                    │ - session         │
                                    │ - model           │
┌──────────────┐   AgentEvent       │ - tools           │
│ CLI / future │ <───────────────── │ - cancellation    │
│ TTS adapter  │                    └─────────┬─────────┘
└──────────────┘                              │
                                              v
                                         OpenAI API
```

The core depends on text and agent events, not microphone, audio codec, browser, WebSocket, or playback types.

## 6. Public Contract

The initial API should stay small:

```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface AgentConfig {
  provider: "openai";
  model: string;
  apiKey: string;
  systemPrompt: string;
  tools?: AgentTool[];
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

export interface AgentRuntime {
  prompt(text: string): Promise<string>;
  abort(reason?: string): Promise<void>;
  reset(): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  readonly busy: boolean;
}

export function createAgent(config: AgentConfig): Promise<AgentRuntime>;
```

Contract rules:

- `prompt()` rejects blank input before calling the model.
- `prompt()` resolves with the final assistant plaintext.
- All events for one turn carry the same generated `turnId`.
- `assistant_delta` values contain only newly received text.
- `assistant_end` is emitted exactly once on success.
- `turn_error` is emitted exactly once for an unhandled failed turn.
- `abort()` is safe when idle.
- After cancellation or failure, the runtime can accept another prompt.
- Listener failures are isolated from the agent loop.
- `subscribe()` returns an unsubscribe function.

The exact Pi event shapes do not leak from this package. This keeps later upgrades localized to the adapter.

## 7. Internal Flow

### Startup

1. Read and validate configuration.
2. Confirm the configured OpenAI model exists in Pi AI's catalog.
3. Create `NodeExecutionEnv`.
4. Create an `InMemorySessionRepo` session.
5. Construct `AgentHarness` with the model, API-key resolver, system prompt, and tools.
6. Subscribe once to Pi lifecycle events and translate them to `AgentEvent`.

### User turn

1. Reject blank input or a second concurrent prompt.
2. Generate `turnId` and mark the runtime busy.
3. Emit `turn_start`.
4. Call `harness.prompt(text)`.
5. Translate Pi assistant and tool events while the loop runs.
6. Accumulate text deltas for the final plaintext.
7. Emit `assistant_end`.
8. Clear busy state in `finally`.

### Cancellation

1. Record the cancellation reason for the active `turnId`.
2. Call `harness.abort()`.
3. Ignore late non-terminal events from that turn.
4. Emit `turn_cancelled` once.
5. Clear busy state.

### Reset

Rebuild the harness with a new in-memory session. Model configuration, system prompt, tools, and subscribers remain unchanged.

## 8. Voice Provision

Layer 1 does not implement these ports, but its contract supports the following Layer 2/3 composition:

```ts
export interface SpeechInput {
  subscribe(
    listener: (
      event:
        | { type: "speech_start" }
        | { type: "interim"; text: string }
        | { type: "final"; text: string }
        | { type: "speech_end" },
    ) => void,
  ): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SpeechOutput {
  push(text: string): Promise<void>;
  flush(): Promise<void>;
  cancel(reason?: string): Promise<void>;
}
```

These are orchestration-facing ports, not additions to `AgentRuntime`.

Future Sarvam mapping:

| Voice responsibility  | Sarvam implementation                           |
| --------------------- | ----------------------------------------------- |
| Streaming recognition | Saaras v3 WebSocket                             |
| Final utterance       | STT `final` event calls `AgentRuntime.prompt()` |
| Speech boundaries     | Saaras VAD signals with `flush_signal=true`     |
| Low-latency synthesis | Bulbul v3 HTTP or WebSocket streaming           |
| TTS input             | Speakable chunks derived from `assistant_delta` |
| Barge-in              | Cancel TTS, then call `AgentRuntime.abort()`    |

Sarvam-specific constraints to preserve in later layers:

- Use `SARVAM_API_KEY` with the `api-subscription-key` header.
- Streaming STT accepts WAV/PCM, not MP3/AAC/OGG.
- Prefer 16 kHz PCM for web microphone input; use 8 kHz for telephony.
- Keep WebSocket TTS messages short, ideally below 500 characters, for low latency.
- Bulbul v3 uses `speaker`, supports `pace`, and does not support pitch or loudness.
- Native Indic script produces better speech than romanized Indic text.

## 9. System Prompt Requirements

The initial prompt should optimize responses for speech without coupling to a particular TTS provider:

```text
You are a helpful conversational voice assistant.
Answer clearly, naturally, and briefly.
Return plain text only.
Do not use Markdown, headings, tables, code fences, or emoji.
Write numbers and abbreviations so they sound natural when spoken.
Ask at most one question at a time.
```

This is a default passed by the app. The core package must not hardcode a product personality.

## 10. Proposed Package Layout

```text
packages/core/
├── src/
│   ├── agent.ts       # AgentRuntime and Pi adapter
│   ├── config.ts      # environment parsing and model validation
│   ├── errors.ts      # typed input, busy, configuration errors
│   ├── events.ts      # application-owned event types
│   └── index.ts       # public exports only
└── tests/
    ├── agent.test.ts
    └── config.test.ts
```

No `audio.ts`, server, WebSocket, browser UI, database, or generic plugin framework is needed in Layer 1.

## 11. Testing Strategy

Unit tests must not call OpenAI.

Use a fake or injectable Pi stream/model boundary to prove:

- model configuration validation;
- blank prompt rejection;
- prompt-to-final-text flow;
- ordered assistant delta forwarding;
- tool start/end forwarding;
- session context is retained across sequential turns;
- concurrent prompt rejection;
- active turn cancellation;
- recovery after failure or cancellation;
- listener errors do not fail the turn;
- reset creates a fresh session.

Add one opt-in smoke script for a real OpenAI request. It runs only when `OPENAI_API_KEY`, `PI_PROVIDER`, and `PI_MODEL` are present and must not be part of the normal test suite.

## 12. Observability

Emit or log the minimum fields needed to debug voice latency later:

- `sessionId`
- `turnId`
- event type
- provider and model at startup
- time to first assistant delta
- total turn duration
- tool name and duration
- cancellation reason
- normalized error name and message

Never log API keys. User and assistant text should be opt-in debug data, not a default production log.

## 13. Layer 1 Acceptance Criteria

Layer 1 is complete when:

- `createAgent()` creates a Pi-backed OpenAI runtime from explicit configuration.
- A terminal demo supports at least two sequential prompts in the same session.
- Assistant text appears incrementally.
- The final response returned by `prompt()` matches the emitted assistant text.
- The active turn can be aborted and a later prompt succeeds.
- Pi's tool lifecycle is represented by the application event contract.
- There are no Sarvam SDK, microphone, audio playback, browser, or server dependencies.
- Unit tests pass without network access.
- The opt-in OpenAI smoke test is documented.
- `vp check` and `vp run typecheck` pass.

## 14. Explicit Non-goals

- Sarvam STT/TTS implementation
- audio capture or playback
- VAD tuning
- sentence chunking
- barge-in detection
- telephony
- browser UI
- authentication
- multiple simultaneous users
- persistent memory or sessions
- retrieval or product-specific tools
- reconnect and retry policy
- metrics backend

## 15. Next Layer

Layer 2 should add a Sarvam Saaras v3 streaming STT adapter and a minimal voice coordinator:

```text
microphone PCM -> Saaras final transcript -> AgentRuntime.prompt()
```

It should not add TTS yet. That keeps recognition, session behavior, and interruption semantics independently testable before audio output enters the pipeline.
