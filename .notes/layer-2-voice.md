# Layer 2: Browser Voice Agent

**Status:** Implemented  
**Date:** 2026-07-26  
**Git commit:** `31aa7c8`

## Purpose

Layer 2 adds the shortest complete voice path around Layer 1:

```text
browser microphone
  -> 16 kHz mono PCM
  -> Hono WebSocket
  -> Sarvam Saaras v3 streaming STT
  -> Pi/OpenAI AgentRuntime
  -> sentence chunks
  -> Sarvam Bulbul v3 streaming TTS
  -> browser audio queue
```

For hackathon speed, STT and TTS are combined into this layer rather than split
across two milestones.

## Client and Server Decision

Use a normal browser as the client. It gives us microphone permission,
`getUserMedia`, an AudioWorklet, WebSocket transport, and audio playback without
a native application.

Use Hono on Node as the server because the existing Pi runtime is Node-based and
Hono supports HTTP, static files, and WebSocket upgrades with a small amount of
code.

The browser never receives either API key. Hono owns both upstream provider
connections.

## Components

- `apps/voice/client/public/pcm-worklet.js` downsamples microphone frames to
  16 kHz signed 16-bit mono PCM.
- `apps/voice/client/src/main.ts` manages microphone capture, UI state,
  WebSocket messages, interruption, and sequential MP3 playback.
- `apps/voice/src/server.ts` owns one Pi agent and one Sarvam STT socket per
  browser connection.
- `apps/voice/src/sentence.ts` converts model deltas into bounded, speakable
  chunks so synthesis can begin before the full response exists.
- `packages/core/src/agent.ts` remains unaware of browsers and audio.

## Turn Flow

1. The user presses **Start conversation** and grants microphone permission.
2. The browser sends `{ "type": "start" }`, then binary PCM frames.
3. Hono opens a Sarvam Saaras v3 WebSocket and forwards base64 PCM envelopes.
4. Sarvam VAD emits speech boundaries and a finalized transcript.
5. The voice session cancels any active response and calls
   `AgentRuntime.prompt(transcript)`.
6. Pi streams OpenAI assistant deltas.
7. Completed sentences are queued for Bulbul v3 synthesis.
8. Each returned MP3 chunk is sent to the browser and played in order.
9. New speech cancels the Pi turn, active TTS request, pending chunks, and
   browser playback.

The text input in the page is a deliberate diagnostic seam. It skips only
microphone capture and STT while exercising the real Pi/OpenAI and Sarvam TTS
path.

## Protocol

Browser-to-server control messages:

- `start` with the selected input language
- `stop` to flush recognition
- `cancel` to interrupt the active response
- `text` for the diagnostic text path
- `playback_done` after the browser drains its audio queue

Binary browser-to-server messages are raw PCM frames.

Important server-to-browser messages:

- `state`
- `speech_start` and `speech_end`
- `transcript`
- `assistant_start`, `assistant_delta`, and `assistant_end`
- `tts_start`, ordered `tts_audio`, and `tts_end`
- `cancel_audio`
- `error`

## Configuration

Required in `packages/core/.env.local`:

```sh
OPENAI_API_KEY=...
SARVAM_API_KEY=...
```

Optional:

```sh
PI_PROVIDER=openai
PI_MODEL=gpt-5.4-mini
SARVAM_TTS_SPEAKER=shubh
PORT=3000
```

## Run

Development:

```sh
pnpm dev
```

Open `http://127.0.0.1:5173`.

Production-style local run:

```sh
pnpm --filter @sarvamhack/voice build
pnpm --filter @sarvamhack/voice start
```

Open `http://127.0.0.1:3000`.

Microphone access works on localhost. A deployed version must use HTTPS.

## Acceptance

- Browser can request microphone access and emit 16 kHz PCM.
- Hono proxies audio to Sarvam without exposing API keys.
- Final STT text enters a stateful Pi/OpenAI session.
- Assistant text appears incrementally.
- TTS starts from sentence chunks rather than waiting for the full answer.
- Browser plays synthesized chunks in order.
- Speech-start supports barge-in cancellation.
- Typed text exercises the agent and TTS path.
- Health endpoint, typecheck, unit tests, build, and live STT-to-TTS smoke pass.

## Deliberate Gaps

- No authentication or multi-device session recovery
- No persistent chat history
- No retry/backoff policy for provider outages
- No echo test or acoustic tuning across physical devices
- No production metrics
- No telephony transport

Those can wait until the demo path has been tested with real speakers and
microphones.
