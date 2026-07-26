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

## Layer 3 sessions and files

Conversations now use Pi coding-agent's persistent sessions and survive browser
reconnects and server restarts. Use the conversation selector in the UI to
reopen history or start a new conversation.

Upload a supported text or source file from the UI and Vaani will inspect it
with Pi's read-only `read`, `grep`, `find`, and `ls` tools. Uploads and session
JSONL files are stored locally under `apps/voice/.data/` and are not committed.

Supported uploads include text, Markdown, CSV, JSON, YAML, XML, HTML, CSS, and
common source-code files up to 5 MB.

## Commands

```sh
pnpm install
pnpm check
pnpm test
pnpm typecheck
pnpm build
pnpm ready
```
