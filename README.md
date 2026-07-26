# sarvamhack

A pnpm and TypeScript monorepo powered by Vite Plus.

## Workspace

- `packages/core` — Agent loop
- `apps/voice` — Hono server and browser voice client with Sarvam STT/TTS

## Layer 1 agent

Create `packages/core/.env.local`:

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

While Sia is thinking, using a tool, or speaking, **Interrupt response**
immediately stops browser playback, cancels pending Sarvam TTS, and aborts the
active Pi turn without clearing the conversation.

## Layer 3 sessions and files

Conversations now use Pi coding-agent's persistent sessions and survive browser
reconnects and server restarts. Use the conversation selector in the UI to
reopen history or start a new conversation.

Upload a file from the UI and Sia will inspect it with Pi's read-only file
tools. PDFs, scans, JPEG/PNG document images, and ZIP archives of page images
are digitized with Sarvam Document Intelligence into layout-preserving
Markdown before the agent answers. Uploads and session JSONL files are stored
locally under `apps/voice/.data/` and are not committed.

The UI accepts any file type up to 5 MB. Sarvam Document Intelligence supports
documents up to 10 pages in PDF, PNG, JPEG, or ZIP form; other readable text and
source files continue through Pi's local file tools. Oversized PDFs are split
into ordered, 10-page parts with Poppler and each part is submitted to Document
Intelligence before Sia combines the results. Sia can also use Poppler through
its Bash tool to inspect, split, merge, render, or extract text from workspace
PDFs.

## Commands

```sh
pnpm install
pnpm check
pnpm test
pnpm typecheck
pnpm build
pnpm ready
```
