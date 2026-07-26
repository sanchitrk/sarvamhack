# Layer 3: Persistent Sessions and Files

**Status:** Implemented  
**Date:** 2026-07-26  
**Git commit:** `31aa7c8`

## Goal

Keep voice conversations across reconnects and restarts, expose previous
conversations in the browser, and let a user upload a text file that the agent
can inspect.

## Pi SDK Decision

Replace the custom `AgentHarness` integration with
`@earendil-works/pi-coding-agent`'s `createAgentSession()`.

The vendored examples used as reference are:

- `.repos/pi/packages/coding-agent/examples/sdk/05-tools.ts`
- `.repos/pi/packages/coding-agent/examples/sdk/11-sessions.ts`
- `.repos/pi/packages/coding-agent/examples/sdk/12-full-control.ts`

Pi coding-agent already supplies:

- append-only JSONL session persistence;
- session listing and reopening;
- restored model context;
- streaming agent and tool events;
- built-in file tools.

The application keeps its existing small `AgentRuntime` contract so the voice
coordinator remains independent of Pi SDK details.

## Data Layout

Runtime data is local and ignored by Git:

```text
apps/voice/.data/
├── sessions/              # Pi JSONL conversation sessions
├── workspaces/
│   └── <session-id>/      # Files uploaded for one conversation
└── agent/                 # Pi runtime configuration boundary
```

Each conversation has a Pi session ID. Its agent `cwd` is that session's
workspace.

## Tool Policy

Enable only:

- `read`
- `grep`
- `find`
- `ls`

Do not enable `bash`, `edit`, or `write` in Layer 3.

This gives uploaded-file inspection and search while avoiding agent-driven file
mutation or arbitrary command execution.

## Browser Flow

1. The WebSocket receives or creates a persistent Pi session.
2. The server sends the session ID and restored user/assistant history.
3. The browser stores the last session ID and offers a session selector.
4. **New conversation** creates a fresh Pi session and workspace.
5. Selecting an older conversation reopens its Pi JSONL session.
6. Upload uses `multipart/form-data` with the active session ID.
7. The server stores a sanitized filename inside that session workspace.
8. The browser sends a `file` control message.
9. The agent is prompted to inspect that relative path with its `read` tool.

## Initial File Scope

Support UTF-8 text and source files up to 5 MB:

- text, Markdown, CSV, JSON
- YAML and XML
- JavaScript and TypeScript
- Python, Java, Go, Rust, and SQL
- HTML and CSS

Binary documents and extraction for PDF, DOCX, audio, and video are separate
work because they require format-specific parsing.

Set `VOICE_DATA_DIR` to override the runtime data directory, which is useful for
isolated smoke tests.

## Acceptance

- A conversation survives browser reconnect and server restart.
- Previous conversations can be listed and reopened.
- Reopened sessions send their historical user/assistant messages to the UI.
- A new conversation gets an isolated workspace.
- A supported file uploads without exposing its absolute server path.
- The agent invokes Pi's read-only tools and answers from the uploaded file.
- Voice STT/TTS continues to work with the persistent runtime.
- Existing Layer 1 event tests remain valid.

## Verification

The live smoke flow:

1. created a conversation and stored a user preference;
2. disconnected and reopened the same Pi session;
3. restored two historical messages and correctly recalled the preference;
4. uploaded a text file;
5. observed Pi invoke the `read` tool;
6. received an answer containing facts that existed only in the uploaded file.
