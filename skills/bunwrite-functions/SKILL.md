---
name: bunwrite-functions
description: "Use when writing, deploying, invoking, scheduling, or debugging Bunwrite functions (Appwrite-compatible serverless functions running on Node/Bun or Python). Covers the context.req and context.res API, entrypoints, build commands, environment variables, executions, cron schedules, logs and permissions. Triggers: Bunwrite function, functions.main.js, context.req, context.res, BUNWRITE_FUNCTION_*, function deployment, function execution."
metadata:
  author: bunwrite
  version: "0.1.0"
---

# Bunwrite functions

Functions are Appwrite-compatible serverless handlers. Each run is a child
process with Appwrite's `context` API (`req`, `res`, `log`, `error`). Bunwrite
runs Node/Bun functions with its own Bun binary and Python functions with
`python3`.

## Layout

The entrypoint defaults to `src/main.js` for Node/Bun and `src/main.py` for
Python.

```text
functions/
  send-invoice/
    src/
      main.js
    package.json
```

## Handlers

### Node / Bun

```js
export default async ({ req, res, log, error }) => {
  log(`${req.method} ${req.path}`)

  if (req.method !== 'POST') {
    return res.text('Method not allowed', 405)
  }

  const body = req.bodyJson
  if (!body.email) {
    return res.json({ error: 'email is required' }, 400)
  }

  error('something worth seeing in the execution logs')
  return res.json({ ok: true, email: body.email })
}
```

CommonJS (`module.exports = async (context) => ...`) also works. The handler may
be the default export or `main`.

### Python

```python
def main(context):
    context.log(f"{context.req.method} {context.req.path}")
    if context.req.method != "POST":
        return context.res.text("Method not allowed", 405)

    body = context.req.body_json
    if "email" not in body:
        return context.res.json({"error": "email is required"}, 400)

    return context.res.json({"ok": True, "email": body["email"]})
```

The handler must be named `main`. Async handlers are awaited.

## Request object

| Field | Meaning |
| --- | --- |
| `req.method` | HTTP method. |
| `req.path` | Path only, without the query string. |
| `req.query` | Query parameters as an object. |
| `req.queryString` | Raw query string. |
| `req.headers` | Lowercase header names. |
| `req.url`, `req.scheme`, `req.host`, `req.port` | Request origin. |
| `req.bodyRaw`, `req.bodyText` | Raw UTF-8 body. |
| `req.bodyBinary` | Raw bytes. |
| `req.bodyJson` | Parsed JSON, `{}` when empty. |
| `req.body` | Parsed object for `application/json`, otherwise text. |

Python uses snake_case: `body_raw`, `body_text`, `body_binary`, `body_json`,
`query_string`.

## Response object

| Method | Result |
| --- | --- |
| `res.json(value, status?, headers?)` | JSON body with `content-type: application/json`. |
| `res.text(value, status?, headers?)` | Text body with `content-type: text/plain`. |
| `res.send(value, status?, headers?)` | String body and your headers. |
| `res.binary(bytes, status?, headers?)` | Binary body. |
| `res.empty()` | Empty 204. |
| `res.redirect(url, status?, headers?)` | Redirect, default 301. |

Always return a response. Returning nothing logs "Return statement missing" and
sends an empty response. An uncaught exception becomes a 500 with the stack in
the execution's `errors`.

## Environment

Every run receives:

```bash
BUNWRITE_FUNCTION_ID=send-invoice
BUNWRITE_FUNCTION_NAME=Send invoice
BUNWRITE_FUNCTION_PROJECT_ID=my-project
BUNWRITE_FUNCTION_API_ENDPOINT=http://127.0.0.1:8080/v1
BUNWRITE_FUNCTION_DEPLOYMENT=<deployment-id>
BUNWRITE_FUNCTION_RUNTIME_NAME=node
BUNWRITE_FUNCTION_RUNTIME_VERSION=22
BUNWRITE_FUNCTION_TRIGGER=http   # or schedule
BUNWRITE_ENDPOINT=<the same API endpoint, unless a function variable overrides it>
BUNWRITE_PROJECT_ID=my-project
BUNWRITE_API_KEY=<internal key>
```

In `API_COMPAT=appwrite`, the same values are also available with the
`APPWRITE_FUNCTION_*`, `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` and
`APPWRITE_API_KEY` names. Variables set in the console are merged on top, so a
function-specific `BUNWRITE_API_KEY` overrides the internal key.

Call Bunwrite from a function with the provided key:

```js
const response = await fetch(`${process.env.BUNWRITE_FUNCTION_API_ENDPOINT}/databases/main/collections/orders/documents`, {
  headers: {
    'x-bunwrite-project': process.env.BUNWRITE_FUNCTION_PROJECT_ID,
    'x-bunwrite-key': process.env.BUNWRITE_API_KEY,
  },
})
```

Use the internal key for privileged work only. For a user-scoped action, verify
the caller first (for example the JWT or the trusted `x-appwrite-user-id` header
set by Bunwrite) and enforce authorization yourself.

## Deployment

### Console

**Console → Functions → Create function**, choose a runtime, paste or upload the
code, set **Who may run it**, variables and an optional schedule, then deploy.

### CLI config

```json
{
  "functions": [
    {
      "$id": "send-invoice",
      "name": "Send invoice",
      "runtime": "node-22",
      "path": "functions/send-invoice",
      "entrypoint": "src/main.js",
      "commands": "npm install",
      "execute": ["users"],
      "events": [],
      "schedule": "",
      "timeout": 30,
      "enabled": true,
      "logging": true,
      "scopes": []
    }
  ]
}
```

```bash
bunwrite push functions --function-id send-invoice
bunwrite pull functions --no-code
```

`commands` runs with `sh -c` during the build. The build PATH ends with a
Bun-provided `bun`, `bunx`, `npm` and `npx`, so `npm install`, `npm ci`,
`npm run build`, `bun install` and `pip install -r requirements.txt` work in the
Docker image. Python builds install into the deployment's `.python_packages`;
`BUNWRITE_WITH_PYTHON=true` is required in Docker.

A failed build keeps the previous active deployment. The CLI prints the build
logs and exits non-zero.

## Runtimes

Node.js (`node-20`, `node-22`, `node-24`, `node-26`) and Bun (`bun-1.1` …
`bun-1.4`) are real: the server downloads that version the first time a
deployment needs it and runs the function on it. The Bun line the server runs
on needs no download. Code that uses Bun-only APIs (`Bun.*`) needs a `bun-*`
runtime. Deployments made before this, and functions run from the code folder,
keep running on the server's Bun. `RUNTIMES_DOWNLOAD=false` runs every Node.js
and Bun runtime on the server's Bun. Python (`python-*`) uses the server's
`python3` and needs the Python runtime enabled on the server.

## Function domains

A function answers on `<function-id>.<FUNCTIONS_DOMAIN>` (for example
`hello.functions.example.com`) and on any number of custom domains added in the
console or through `POST /v1/proxy/rules/function`. The default address keeps
working when custom domains change.

## Executions

- Synchronous: `functions.createExecution({ functionId, body, method, headers })`.
- Asynchronous: `functions.createExecution({ functionId, async: true, ... })`.
- Deferred: add `scheduledAt` to run once at a future time.
- HTTP endpoint: `POST /v1/functions/<function-id>/http` (or `/api/*` on a site
  with `apiFunctionId`).
- Cron: set `schedule` with a five-field cron expression in UTC. A function is
  never started while its previous schedule run is still going.
- Timeout: 1–900 seconds (default depends on the function; set it explicitly).

Read the execution with `functions.getExecution({ functionId, executionId })`
and inspect `status`, `responseBody`, `logs`, `errors`, `duration` and the
trigger.

## Permissions

`execute` accepts `any`, `users`, `guests`, user IDs, team IDs/roles and labels,
using the same role strings as document permissions. Bunwrite still passes the
caller's identity to the function; the function must enforce anything finer.

For a browser calling a function directly, send the session cookie or JWT in the
usual header. Bunwrite drops client-supplied `x-*-user-id` headers and sets the
trusted one itself.

## Debugging checklist

1. Read the execution's `logs` and `errors` in the console; uncaught exceptions
   are there with the stack.
2. Check the build logs when the deployment status is `failed`.
3. Confirm the entrypoint path matches the file (`src/main.js` / `src/main.py`).
4. Verify the runtime label and that Python is enabled for Python functions.
5. Check the function's **Who may run it** setting and the caller's session/JWT.
6. Confirm variables were set on the right function or globally; function-level
   values win.
7. Look for missing dependencies: they must be installed during the build, not
   assumed on the host.

## Security

- Never return `BUNWRITE_API_KEY` or other secrets in a response or log.
- Validate and authorize every input; the internal key is powerful.
- Do not trust headers a client can send (`x-*-user-id`, `x-*-jwt`); use the
  values Bunwrite sets after verification.
- Keep function dependencies pinned and the build reproducible.
- Treat the function's filesystem as shared with its deployment, not as a
  durable database. Store state in Bunwrite databases or storage.
- In Docker, each function builds and runs as its own Linux user when the
  sandbox helper is available; do not disable it.

## Reference

- [Bunwrite README](https://github.com/ridhotamma/bunwrite/blob/main/README.md)
- [Architecture: functions](https://github.com/ridhotamma/bunwrite/blob/main/docs/ARCHITECTURE.md)
- [Appwrite Functions docs](https://appwrite.io/docs/products/functions)
