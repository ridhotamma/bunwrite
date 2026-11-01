# Bunwrite MCP server

The Bunwrite MCP server connects AI coding agents to a Bunwrite project. It is
the self-hosted counterpart to Appwrite's local MCP server: it runs on your
machine over stdio and authenticates with a project API key.

Like Appwrite's server, it exposes a **small operator surface** rather than every
API method. The full catalog is searched at runtime, so an agent does not spend
its context window on dozens of tool definitions.

```
bunwrite_get_context       project, version and resource counts
bunwrite_search_tools      find an operation in the internal catalog
bunwrite_call_tool         run a read operation
bunwrite_call_write_tool   run a write operation after confirm_write: true
bunwrite_search_docs       search the Bunwrite documentation
```

## Prerequisites

- A running Bunwrite instance and its API endpoint, for example
  `https://api.example.com/v1`.
- A project ID.
- A server-side API key with the scopes you want the agent to use. A read-only
  agent can use a key without write scopes, plus `--read-only` for defence in
  depth.

Never use a browser key or a user session cookie here. The MCP server is a
server-side process; keep the key in its environment.

## Run it

From a Bunwrite checkout:

```bash
bun packages/mcp/src/index.ts --help

BUNWRITE_ENDPOINT=https://api.example.com/v1 \
BUNWRITE_PROJECT_ID=booking-app \
BUNWRITE_API_KEY=standard_... \
  bun packages/mcp/src/index.ts
```

Build a standalone bundle:

```bash
bun run mcp:build
node packages/mcp/dist/mcp.js --version
```

The package is published as `@bunwrite/mcp`, and the binary is `bunwrite-mcp`.
Run the latest release without installing:

```bash
npx -y @bunwrite/mcp --help
npx -y @bunwrite/mcp@0.1.0 --version
```

Or install it in a project with `npm install @bunwrite/mcp`.

## Connect an agent

Most MCP clients accept the standard `mcpServers` shape. Use the absolute path to
the built binary (or `npx -y @bunwrite/mcp` after publishing):

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

Typical config locations:

| Client | Where |
| --- | --- |
| Claude Code | `claude mcp add ...`, or `~/.claude.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| VS Code | `.vscode/mcp.json` |
| OpenCode | the `mcp` section of `opencode.json` |
| Codex | `~/.codex/config.toml` (`[mcp_servers.bunwrite]`) |
| Zed | `settings.json` → `context_servers` |

The exact shape differs slightly per client; the command, args and env above are
the same.

## HTTP mode

For an agent that cannot spawn a process, run the stateless HTTP transport:

```bash
BUNWRITE_ENDPOINT=https://api.example.com/v1 \
BUNWRITE_PROJECT_ID=booking-app \
BUNWRITE_API_KEY=standard_... \
  bunwrite-mcp --transport http --host 127.0.0.1 --port 7801
```

The endpoint is `http://127.0.0.1:7801/mcp`; `GET /health` is a simple health
check. On a non-loopback bind, send `Authorization: Bearer <BUNWRITE_API_KEY>`.
The server is stateless: no session ID or server-initiated SSE stream. It also
answers `GET` with `405` and `DELETE` with `204`, as the transport expects.

This is not the hosted Appwrite model: there is no OAuth flow. Treat the HTTP
listener as an internal service and keep it behind your network boundary.

## Tools

The model sees only these five:

| Tool | Purpose |
| --- | --- |
| `bunwrite_get_context` | Endpoint, project, version, resource counts, catalog size and groups. Start here. |
| `bunwrite_search_tools` | Search names, titles, groups and descriptions. Returns operation names. |
| `bunwrite_call_tool` | Run a read operation. Refuses write operations. |
| `bunwrite_call_write_tool` | Run a write operation. Requires `confirm_write: true`. Hidden with `--read-only`. |
| `bunwrite_search_docs` | Search the Bunwrite docs, with GitHub links and snippets. |

The internal catalog covers:

- **health** — service health and version
- **databases** — databases, collections, attributes, indexes and documents
- **users** — users, sessions, email/name/status and deletion
- **teams** — teams and memberships
- **storage** — buckets, file metadata, upload, download (base64) and delete
- **functions** — functions, executions and triggering a run
- **sites** — sites and deployments
- **messaging** — topics
- **flags** — `/v1/flags` evaluation

Use `bunwrite_search_tools` for the exact list; it changes as the API grows.

### Queries

Bunwrite query strings are JSON, for example:

```json
{
  "queries": [
    "{\"method\":\"limit\",\"values\":[25]}",
    "{\"method\":\"orderDesc\",\"attribute\":\"$createdAt\"}"
  ]
}
```

Pass them in the `queries` array. Always bound document, user and execution
lists; the catalog does not fetch unbounded data on its own.

### Writes

A write is refused unless the tool call includes `confirm_write: true`:

```json
{
  "name": "bunwrite_call_write_tool",
  "arguments": {
    "name": "documents_create",
    "arguments": {
      "databaseId": "booking_stress",
      "collectionId": "bookings",
      "documentId": "unique()",
      "data": { "status": "confirmed" }
    },
    "confirm_write": true
  }
}
```

Ask the user before changing or deleting data. Destructive operations are marked
with `destructive: true` in `bunwrite_search_tools` output.

A read-only server hides the write tool entirely:

```env
BUNWRITE_MCP_READ_ONLY=true
```

## Configuration

| Variable | CLI flag | Default | Meaning |
| --- | --- | --- | --- |
| `BUNWRITE_ENDPOINT` | `--endpoint` | `http://localhost:8080/v1` | API endpoint; `/v1` is appended when missing. |
| `BUNWRITE_PROJECT_ID` | `--project` | — | Project ID (required). |
| `BUNWRITE_API_KEY` | `--key` | — | Server-side API key (required). |
| `BUNWRITE_MCP_TRANSPORT` | `--transport` | `stdio` | `stdio` or `http`. |
| `BUNWRITE_MCP_HOST` | `--host` | `127.0.0.1` | HTTP bind address. |
| `BUNWRITE_MCP_PORT` | `--port` | `7801` | HTTP port. |
| `BUNWRITE_MCP_READ_ONLY` | `--read-only` | `false` | Hide and refuse writes. |
| `BUNWRITE_MCP_MAX_RESULT` | — | `200000` | Maximum characters in one tool result. |
| `BUNWRITE_SELF_SIGNED` | `--self-signed` | `false` | Accept a self-signed certificate. |
| `BUNWRITE_DOCS_DIR` | `--docs-dir` | auto | Docs folder to search; otherwise the checkout or the built-in index. |

`APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` and `APPWRITE_API_KEY` are accepted as
aliases for existing Appwrite setups.

## Examples

```text
List the collections in the booking_stress database.
```

```text
Show the five most recent bookings, then summarize the statuses.
```

```text
Create a user ada@example.com and add them to the staff team as a member.
Ask before making the change.
```

```text
Search the Bunwrite docs for how to run Postgres with four workers.
```

```text
What feature flags are enabled for this project?
```

## Security

- The API key is sent only to the configured endpoint. Do not commit it.
- Use a scoped key; the MCP server exposes every operation the key can call.
- Bind HTTP mode to loopback unless it is behind authentication and a private
  network. Use a bearer token on any non-loopback bind.
- Prefer `--read-only` for exploration and review agents.
- Write tools require explicit confirmation, but the model can still be wrong:
  review destructive calls before approving them.
- The server does not read browser state, session cookies or console pages. It
  sees the REST API only.

## Limits

- No hosted OAuth flow; use a project API key.
- No MCP events / webhook subscriptions (Appwrite's hosted extension).
- No console-only data: request-log pages and metric charts are HTML pages, not
  REST resources, so they are not in the catalog. `flags_get` is available
  because `/v1/flags` is a REST endpoint.
- Tool results are truncated at `BUNWRITE_MCP_MAX_RESULT`.
- File downloads are base64 and default to a 1 MB cap.
- The HTTP transport is stateless and does not push server-initiated messages.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `No project ID` / `No API key` | Set `BUNWRITE_PROJECT_ID` and `BUNWRITE_API_KEY`, or pass `--project` / `--key`. |
| `401 Invalid API key` | The key, project and endpoint belong to the same Bunwrite instance. |
| Tools work but writes return 401/403 | The key is scoped without write permission, or the server is read-only. |
| `Invalid query: Syntax error` | Pass JSON query strings, not `limit(1)`. |
| HTTP `401 Unauthorized` | Send `Authorization: Bearer <BUNWRITE_API_KEY>` on a non-loopback bind. |
| The agent does not see the tools | Restart the client after changing its MCP config; check the command path is absolute. |
| Docs search returns only summaries | Point `BUNWRITE_DOCS_DIR` at a Bunwrite `docs/` folder. |

## Reference

- [MCP specification](https://modelcontextprotocol.io)
- [Observability](OBSERVABILITY.md)
- [Configuration](CONFIGURATION.md)
- [`packages/mcp`](../packages/mcp/README.md)
