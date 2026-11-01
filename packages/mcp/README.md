# @bunwrite/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Bunwrite](https://github.com/ridhotamma/bunwrite). Connect Claude Code, Cursor,
Codex, OpenCode, VS Code, Zed and other MCP clients to a Bunwrite project.

The server exposes five operator tools and keeps the full API catalog internal:

```
bunwrite_get_context
bunwrite_search_tools
bunwrite_call_tool
bunwrite_call_write_tool
bunwrite_search_docs
```

That keeps the model's context small while covering databases, documents,
users, teams, storage, functions, sites, topics and feature flags.

## Install

From the repository:

```bash
bun run mcp:build
node packages/mcp/dist/mcp.js --version
```

Published as `@bunwrite/mcp`:

```bash
npx -y @bunwrite/mcp --help
npm install @bunwrite/mcp
```

## Configure

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

## Run

```bash
BUNWRITE_ENDPOINT=https://api.example.com/v1 \
BUNWRITE_PROJECT_ID=booking-app \
BUNWRITE_API_KEY=standard_... \
  bunwrite-mcp
```

Use `--read-only` to hide and refuse writes. Use `--transport http --port 7801`
for a stateless `POST /mcp` endpoint; send `Authorization: Bearer <key>` on a
non-loopback bind.

The API key is server-side only. Do not put it in a browser.

## Docs

- [MCP guide](https://github.com/ridhotamma/bunwrite/blob/main/docs/MCP.md)
- [Configuration](https://github.com/ridhotamma/bunwrite/blob/main/docs/CONFIGURATION.md)
- [Bunwrite README](https://github.com/ridhotamma/bunwrite#readme)
