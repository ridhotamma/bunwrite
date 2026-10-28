---
name: bunwrite
description: "Use when building, changing, or debugging an app on Bunwrite, the lightweight self-hosted Appwrite-compatible BaaS on Bun and SQLite. Covers setup, @bunwrite/sdk, appwrite and node-appwrite compatibility, account sessions, databases and documents, queries, permissions, storage, realtime, functions, sites, webhooks, and the Bunwrite CLI. Triggers: Bunwrite, BUNWRITE_*, bunwrite.config.json, self-hosted Appwrite, Appwrite-compatible backend."
metadata:
  author: bunwrite
  version: "0.1.0"
---

# Bunwrite

Bunwrite is a single-process, self-hosted backend that implements the part of the
Appwrite API most apps use: account sessions, databases and documents, storage,
teams, functions, static sites, realtime, webhooks and messaging topics. It runs
on Bun with SQLite and ships an admin console.

Existing apps can keep using `appwrite` or `node-appwrite`. They only need the
endpoint pointed at Bunwrite. `@bunwrite/sdk` is the same API with Bunwrite's
names and additions such as `Render`.

## Rules that prevent most mistakes

1. **The endpoint ends in `/v1`.** For example `https://api.example.com/v1` or
   `http://localhost:8080/v1`. Every request also needs a project ID.
2. **API keys are server-side only.** In the browser, use account sessions
   (cookies). Never ship `BUNWRITE_API_KEY` or an `X-Bunwrite-Key` header to a
   browser, a static site, or a function variable a client can read.
3. **Use `Databases` for documents.** `TablesDB` in `@bunwrite/sdk` has the
   schema methods only; Bunwrite stores and serves rows through the
   `Databases` collection/document endpoints. Appwrite's newer TablesDB row
   methods are not available.
4. **Schema lives in the database and in `bunwrite.config.json`.** Create or
   change collections with the console, `bunwrite push tables`, or
   `schema:push`. There is no SQL console for app data. A missing collection or
   column is usually a schema push that did not run.
5. **Permissions are evaluated on the server.** Set collection and document
   permissions deliberately. An API key bypasses user permissions; a browser
   session does not.
6. **Bunwrite is not Appwrite Cloud.** Check what the SDK and server expose
   before assuming an Appwrite feature exists. Avatars, Locale, MFA, phone
   sign-in, message delivery and SSR site builds are not implemented.
7. **Verify against the running server.** Health is `GET /v1/health` and the
   version is `GET /v1/health/version`. Error bodies use Appwrite's shape:
   `{ message, code, type, version }`.

## Setup

### Client and server

```ts
import { Account, Client, Databases, ID, InputFile, Permission, Query, Role, Storage } from '@bunwrite/sdk'

const client = new Client()
  .setEndpoint(process.env.BUNWRITE_ENDPOINT!) // https://api.example.com/v1
  .setProject(process.env.BUNWRITE_PROJECT_ID!)

// Server only:
client.setKey(process.env.BUNWRITE_API_KEY!)

const account = new Account(client)
const databases = new Databases(client)
const storage = new Storage(client)
```

With the official SDKs, the same code works by changing the import:

```ts
import { Client, Databases } from 'node-appwrite' // or 'appwrite' in a browser
```

`@bunwrite/sdk` speaks `X-Bunwrite-Project` / `X-Bunwrite-Key`; the Appwrite SDKs
speak `X-Appwrite-*`. The server reads both. CORS, cookies and error shapes follow
Appwrite. Set `API_COMPAT=appwrite` on the server when webhook headers and
function variables must keep Appwrite's names.

### Environment

```bash
BUNWRITE_ENDPOINT=https://api.example.com/v1
BUNWRITE_PROJECT_ID=your-project-id
BUNWRITE_API_KEY=standard_...   # server only
```

A project and its first API key are shown on the console's first-run setup page
or under **Console → Settings → API keys**. Local development defaults to
`http://localhost:8080/v1`.

## Account and sessions

```ts
// Register (does not sign in by itself).
await account.create({ userId: ID.unique(), email, password, name })

// Sign in; the browser keeps the session cookie.
await account.createEmailPasswordSession({ email, password })

const me = await account.get()
await account.updateName({ name: 'Ada Lovelace' })
await account.deleteSession({ sessionId: 'current' })
```

- Email OTP: `createEmailToken({ userId, email })`, then
  `createSession({ userId, secret })`.
- OAuth: enable the provider in the console, then call
  `createOAuth2Token({ provider: OAuthProvider.Google, success, failure })` and
  finish with `createSession({ userId, secret })` from the redirect parameters.
- JWTs for functions and realtime: `account.createJWT()`.
- Server-side impersonation: an API key can use `Users` to create users and
  sessions. Do not pass a user's cookie to a server if a key is enough.
- Sessions are stored as hashes, passwords use Argon2id, and Appwrite's imported
  bcrypt/sha/scrypt hashes still verify.

## Databases and documents

```ts
const { documents, total } = await databases.listDocuments({
  databaseId: 'main',
  collectionId: 'orders',
  queries: [
    Query.equal('status', 'open'),
    Query.orderDesc('$createdAt'),
    Query.limit(25),
  ],
})

const order = await databases.createDocument({
  databaseId: 'main',
  collectionId: 'orders',
  documentId: ID.unique(),
  data: { customerId: me.$id, total: 42, status: 'open' },
  permissions: [Permission.read(Role.user(me.$id)), Permission.update(Role.user(me.$id))],
})

await databases.updateDocument({
  databaseId: 'main',
  collectionId: 'orders',
  documentId: order.$id,
  data: { status: 'paid' },
})

await databases.deleteDocument({ databaseId: 'main', collectionId: 'orders', documentId: order.$id })
```

Useful helpers: `Query.equal`, `notEqual`, `lessThan`, `greaterThan`, `between`,
`contains`, `startsWith`, `search`, `isNull`, `select`, `orderAsc`, `orderDesc`,
`limit`, `offset`, `cursorAfter`, `cursorBefore`, `or`, `and`, `elemMatch`.
Bulk methods are `createDocuments`, `upsertDocuments`, `updateDocuments` and
`deleteDocuments`. Atomic changes use `Operator.increment`, `decrement`,
`arrayAppend` and friends as document values.

Transactions:

```ts
const tx = await databases.createTransaction({ ttl: 60 })
await databases.createDocument({ ..., transactionId: tx.$id })
await databases.updateTransaction({ transactionId: tx.$id, commit: true })
```

Permissions:

```ts
import { Permission, Role } from '@bunwrite/sdk'

Permission.read(Role.any())            // public read
Permission.read(Role.users())          // any signed-in user
Permission.read(Role.guests())         // signed-out visitors only
Permission.read(Role.user(userId))
Permission.read(Role.team(teamId))
Permission.read(Role.team(teamId, 'admin'))
Permission.read(Role.label('staff'))
```

Collection permissions are the default. Turn on **document security** to let a
document's own `$permissions` narrow access. `write` is a shorthand for
`create` + `update` + `delete`. Missing permissions produce a 401
`role: guests` or a 404-style denial; check permissions before changing code.

## Storage

```ts
await storage.createBucket({
  bucketId: 'photos',
  name: 'Photos',
  permissions: [Permission.read(Role.any())],
  fileSecurity: false,
  maximumFileSize: 5_000_000,
  allowedFileExtensions: ['jpg', 'jpeg', 'png', 'webp'],
})

const file = await storage.createFile({
  bucketId: 'photos',
  fileId: ID.unique(),
  file: InputFile.fromPath('./cover.png'), // browser: a File/Blob
  permissions: [Permission.read(Role.any())],
})

const viewUrl = storage.getFileView({ bucketId: 'photos', fileId: file.$id })
const previewUrl = storage.getFilePreview({ bucketId: 'photos', fileId: file.$id, width: 800, height: 600 })
```

On Node/Bun, `getFileView`, `getFileDownload` and `getFilePreview` return a URL;
use `getFileViewBytes`, `getFileDownloadBytes` or `getFilePreviewBytes` when you
need the bytes. Buckets may be backed by local disk or an S3-compatible bucket;
the API is the same. File tokens are for temporary access without a session.

## Realtime

```ts
import { Channel, Realtime } from '@bunwrite/sdk'

const realtime = new Realtime(client)
const subscription = await realtime.subscribe(
  'databases.main.collections.orders.documents',
  (event) => console.log(event.events, event.payload),
)

await subscription.unsubscribe()
```

Use `Channel.database('main').collection('orders').document(orderId).update()`
for one document and one action, or `Channel.files()`, `Channel.executions()` and
the other channel builders for the rest.

Channels include `documents`, `databases.<db>.collections.<collection>.documents`
and the row equivalents, `files`, `files.<id>`, `executions`, `teams`,
`memberships` and `account`. Events are only delivered to callers who may read
the document, so permissions apply to realtime too. In the browser the session
cookie authenticates the socket; on a server use `setKey` or pass a JWT.

## Functions

Functions run in child processes with Appwrite's `context` API. Node/Bun and
Python runtimes are available. Deploy from the console or with the CLI:

```json
{
  "functions": [
    {
      "$id": "send-invoice",
      "name": "Send invoice",
      "runtime": "node-22",
      "path": "functions/send-invoice",
      "entrypoint": "src/main.js",
      "execute": ["users"],
      "timeout": 30,
      "enabled": true
    }
  ]
}
```

```js
export default async ({ req, res, log, error }) => {
  log(`${req.method} ${req.path}`)
  if (req.method !== 'POST') return res.text('Method not allowed', 405)
  return res.json({ received: req.bodyJson })
}
```

Functions receive `BUNWRITE_FUNCTION_API_ENDPOINT`, `BUNWRITE_FUNCTION_PROJECT_ID`
and `BUNWRITE_API_KEY`, plus variables set in the console. Use them to call
Bunwrite from a function instead of hard-coding the endpoint. See the
`bunwrite-functions` skill for the full `req`/`res` surface, builds and
troubleshooting.

## Static sites

Sites host plain HTML, htmx pages or a pre-built SPA at
`<site-id>.<SITES_DOMAIN>`. Bunwrite never runs a build; upload the output folder
or deploy it:

```json
{
  "sites": [
    {
      "$id": "landing",
      "name": "Landing",
      "framework": "vite",
      "path": "web",
      "outputDirectory": "dist",
      "fallbackFile": "index.html",
      "apiFunctionId": "api"
    }
  ]
}
```

```bash
bunwrite push sites
```

With `apiFunctionId`, requests to `/api/*` on the site run that function on the
same origin. The `bunwrite-sites` skill covers routing, custom domains and
single-page fallbacks.

## Webhooks and topics

Webhooks are configured in the console or the CLI. Deliveries are signed; verify
the raw body with the webhook's secret and the
`X-Bunwrite-Webhook-Signature` header (or `X-Appwrite-Webhook-Signature` in
Appwrite mode). Messaging supports topics and subscribers; sending email/SMS/push
messages is not implemented.

## CLI and config

```bash
bunwrite client --endpoint https://api.example.com/v1 --project-id my-project --key <key>
bunwrite pull all
bunwrite push functions --function-id send-invoice
```

The project config is `bunwrite.config.json` or `bunwrite.json`; an existing
`appwrite.config.json` works too. See the `bunwrite-cli` skill.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `401 role: guests` | No session or API key on a request that needs one; sign in or set the key. |
| `401 Invalid API key` | Key, project ID and endpoint belong to the same Bunwrite instance. |
| `404` on a collection or document | Schema pushed? Collection ID correct? Permission may intentionally hide the resource. |
| `400 Invalid document structure` | Column key/type mismatch with the schema; push the schema after editing it. |
| CORS error in a browser | Add the exact origin under **Settings → Allowed origins**; sites' own hosts are trusted automatically. |
| Realtime receives nothing | Subscribe channel spelling, session/JWT, and read permissions. |
| Function returns 500 | Read the execution logs in the console; the stack is in `errors`. |
| Webhook signature fails | Verify the raw request body, not parsed JSON, and the matching webhook secret. |
| Changes disappear on restart | The database is the source of truth; export schema changes to `bunwrite.config.json`. |

## Security checklist

- Keep API keys out of browser bundles, static sites, `NEXT_PUBLIC_*` variables
  and public repositories.
- Give each server integration its own scoped key and rotate it when leaked.
- Use document/collection permissions; do not rely on a hidden `$id` or UI.
- For a function called by a browser, read the authenticated user from the
  function's verified headers/JWT. Bunwrite strips `x-*-user-id` headers that
  clients send themselves.
- Put the console behind access control or set `CONSOLE_ENABLED=false` on a
  public API host, and use HTTPS.
- Treat uploaded files as untrusted; limit extensions and size per bucket.
- Back up the SQLite database and uploaded files separately.

## Moving from Appwrite

1. Point `setEndpoint()` at Bunwrite and keep `appwrite`/`node-appwrite`, or
   switch imports to `@bunwrite/sdk`.
2. Create the project, API key and schema; `bunwrite pull all` / `push all` can
   move the config file format.
3. Replace TablesDB row calls with `Databases` document calls.
4. Remove features Bunwrite does not serve (Avatars, Locale, MFA, phone login,
   messaging sends, SSR site builds).
5. Set `API_COMPAT=appwrite` if existing webhook receivers or functions expect
   `X-Appwrite-*` and `APPWRITE_*` names.

## Reference

- [Bunwrite README](https://github.com/ridhotamma/bunwrite/blob/main/README.md)
- [`@bunwrite/sdk`](https://github.com/ridhotamma/bunwrite/blob/main/packages/sdk/README.md)
- [`@bunwrite/cli`](https://github.com/ridhotamma/bunwrite/blob/main/packages/cli/README.md)
- [Sites](https://github.com/ridhotamma/bunwrite/blob/main/docs/SITES.md) and
  [HTML rendering](https://github.com/ridhotamma/bunwrite/blob/main/docs/RENDER.md)
- [Appwrite API reference](https://appwrite.io/docs/references) for the shared
  resource and permission model
