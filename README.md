# sarvamhack

A pnpm and TypeScript monorepo powered by Vite Plus.

## Workspace

- `packages/core` — Pi-powered agent loop with OpenAI

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

## Commands

```sh
pnpm install
pnpm check
pnpm test
pnpm typecheck
pnpm build
pnpm ready
```
