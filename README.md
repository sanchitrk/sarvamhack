# sarvamhack

A pnpm and TypeScript monorepo powered by Vite Plus.

## Workspace

- `packages/core` — Pi-powered agent loop with OpenAI
- `apps/voice` — Hono server and browser voice client with Sarvam STT/TTS

## Layer 1 agent

Create `packages/core/.env.local`:

```sh
OPENAI_API_KEY=...
PI_PROVIDER=openai
PI_MODEL=gpt-5.4-mini
```

`PI_PROVIDER` and `PI_MODEL` are optional; the values above are the current
defaults.

Start an interactive, stateful terminal session:

```sh
pnpm --filter @sarvamhack/core chat
```

Run a one-turn OpenAI smoke test:

```sh
pnpm --filter @sarvamhack/core smoke
```

## Layer 2 voice agent

Add both keys to `packages/core/.env.local`:

```sh
OPENAI_API_KEY=...
SARVAM_API_KEY=...
```

Start the Hono server and Vite client:

```sh
pnpm dev
```

Open `http://127.0.0.1:5173`, press **Start conversation**, and grant microphone
access. The production-style path runs both from Hono on port 3000:

```sh
pnpm --filter @sarvamhack/voice build
pnpm --filter @sarvamhack/voice start
```

The browser sends 16 kHz mono PCM to Sarvam Saaras v3 over the Hono WebSocket.
Final transcripts enter the Layer 1 Pi/OpenAI loop. Assistant deltas are split
into speakable sentences and synthesized with Sarvam Bulbul v3.

## Commands

```sh
pnpm install
pnpm check
pnpm test
pnpm typecheck
pnpm build
pnpm ready
```
