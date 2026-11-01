---
name: bunwrite-mcp
description: "Use when connecting an AI agent to a Bunwrite project through the Bunwrite MCP server: install @bunwrite/mcp, configure stdio or HTTP for Claude Code, Cursor, Codex, OpenCode, VS Code or Zed, search and run catalog tools, and handle writes safely. Triggers: Bunwrite MCP, bunwrite-mcp, MCP server, Model Context Protocol, Claude Code Bunwrite, Cursor Bunwrite, AI agent backend."
metadata:
  author: bunwrite
  version: "0.1.0"
---

# Bunwrite MCP server

`@bunwrite/mcp` is the Model Context Protocol server for Bunwrite. It is the
self-hosted counterpart to Appwrite's local MCP server: it runs on the
developer's machine over stdio and talks to a project with an API key.

Use it when an agent should inspect or operate a live Bunwrite project: list
documents, create users, inspect schemas, read function executions, check
feature flags, and so on. Use the `bunwrite` skill for writing application code;
use this skill for configuring and driving the MCP server.

## Run it

From a Bunwrite checkout:

```bash
bun packages/mcp/src/index.ts --help

BUNWRITE_ENDPOINT=https://api.example.com/v1 \
BUNWRITE_PROJECT_ID=booking-app \
BUNWRITE_API_KEY=standard_... \
  bun packages/mcp/src/index.ts
```

Build the standalone bundle:

```bash
bun run mcp:build
node packages/mcp/dist/mcp.js --version
```

Run `npx -y @bunwrite/mcp` (or pin `@bunwrite/mcp@0.1.0`).

## Client configuration

Most clients accept the standard shape:

```json
{
  "mcpServers": {
    "bunwrite": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/mcp.js"],
      "env": {
        "BUNWRITE_ENDPOINT": "https://api.example.com/v1",
        "BUNWRITE_PROJECT_ID": "booking-app",
        "BUNWRITE_API_KEY": "standard_..."
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add bunwrite \
  --env BUNWRITE_ENDPOINT=https://api.example.com/v1 \
  --env BUNWRITE_PROJECT_ID=booking-app \
  --env BUNWRITE_API_KEY=standard_... \
  -- node /absolute/path/to/packages/mcp/dist/mcp.js
```

Common config locations: `~/.claude.json` (Claude Code),
`~/Library/Application Support/Claude/claude_desktop_config.json` (Claude
Desktop), `~/.cursor/mcp.json` (Cursor), `.vscode/mcp.json` (VS Code),
`opencode.json` (OpenCode), `~/.codex/config.toml` (Codex) and the
`context_servers` key in Zed's `settings.json`.

For an agent that cannot spawn a process:

```bash
BUNWRITE_ENDPOINT=https://api.example.com/v1 \
BUNWRITE_PROJECT_ID=booking-app \
BUNWRITE_API_KEY=standard_... \
  bunwrite-mcp --transport http --host 127.0.0.1 --port 7801
```

The endpoint is `POST http://127.0.0.1:7801/mcp`. On a non-loopback bind send
`Authorization: Bearer <BUNWRITE_API_KEY>`. The transport is stateless.

## Operator workflow

The model sees five tools, not the whole API:

| Tool | Use |
| --- | --- |
| `bunwrite_get_context` | Start here: endpoint, project, version, resource counts, catalog groups. |
| `bunwrite_search_tools` | Find an operation, for example `{"query":"list documents"}`. |
| `bunwrite_call_tool` | Run a read operation by name. |
| `bunwrite_call_write_tool` | Run a write operation with `confirm_write: true`. |
| `bunwrite_search_docs` | Search the Bunwrite docs and return GitHub links. |

Typical flow:

1. `bunwrite_get_context`
2. `bunwrite_search_tools` with a verb and a noun
3. `bunwrite_call_tool` with the returned name
4. For a change, ask the user, then `bunwrite_call_write_tool` with
   `confirm_write: true`

The catalog covers health, databases, collections, attributes, indexes,
documents, users, teams, storage, functions, sites, topics and feature flags.

## Queries are JSON

Bunwrite query strings are JSON, not Appwrite's legacy `limit(1)` form:

```json
{
  "name": "bunwrite_call_tool",
  "arguments": {
    "name": "documents_list",
    "arguments": {
      "databaseId": "booking_stress",
      "collectionId": "bookings",
      "queries": [
        "{\"method\":\"limit\",\"values\":[25]}",
        "{\"method\":\"orderDesc\",\"attribute\":\"$createdAt\"}"
      ]
    }
  }
}
```

Always bound lists. A context summary should use counts, not full collections.

## Writes and safety

- The write tool requires `confirm_write: true`. Ask the user before changing or
  deleting data; `bunwrite_search_tools` marks destructive operations.
- `BUNWRITE_MCP_READ_ONLY=true` or `--read-only` hides and refuses writes; use it
  for review and exploration agents.
- The API key is server-side only. Use a scoped key, never a browser key.
- Bind HTTP mode to loopback unless it is behind authentication and a private
  network.
- The MCP server sees the REST API only. It does not read browser state,
  sessions, request-log HTML pages or metric charts.

## Limits

- No hosted OAuth flow; use an API key.
- No MCP events or webhook subscriptions.
- No console-only data (request logs and metric charts are HTML pages).
- Results truncate at `BUNWRITE_MCP_MAX_RESULT` (default 200 KB).
- File downloads are base64 with a 1 MB default cap.
- The HTTP transport does not push server-initiated messages.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No project ID` / `No API key` | Set `BUNWRITE_PROJECT_ID` / `BUNWRITE_API_KEY`, or pass `--project` / `--key`. |
| `401 Invalid API key` | Key, project and endpoint belong to the same instance. |
| Writes return 401/403 | The key lacks write scopes, or the server is read-only. |
| `Invalid query: Syntax error` | Send JSON query strings, not `limit(1)`. |
| HTTP 401 | Send `Authorization: Bearer <key>` on a non-loopback bind. |
| Agent sees no tools | Restart the client; use an absolute command path. |
| Docs results are short | Set `BUNWRITE_DOCS_DIR` to a Bunwrite `docs/` folder. |

## Reference

- [MCP guide](https://github.com/ridhotamma/bunwrite/blob/main/docs/MCP.md)
- [MCP package](https://github.com/ridhotamma/bunwrite/tree/main/packages/mcp)
- [Configuration](https://github.com/ridhotamma/bunwrite/blob/main/docs/CONFIGURATION.md)
- [Bunwrite README](https://github.com/ridhotamma/bunwrite#readme)
