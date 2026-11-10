# Bunwrite SDK

One SDK for [Bunwrite](../../README.md) that runs in browsers, Bun, Node.js 18+
and edge runtimes. It has no dependencies.

The services, method names and parameters are copied from Appwrite's Web SDK
and SDK for Node.js, trimmed to the endpoints Bunwrite serves, and renamed to
Bunwrite's names. Code written for `appwrite` or `node-appwrite` ports by
changing the import, and `AppwriteException` to `BunwriteException`.

It sends Bunwrite's headers (`X-Bunwrite-Project`, `X-Bunwrite-Key`, …), so it
needs a Bunwrite server that reads them; version 0.2.0 and up needs one from
the same release. The server's `API_COMPAT` setting does not matter: it reads
both naming families.

```bash
npm install @bunwrite/sdk
```

## Use it

In a browser app, a user signs in and reads their documents:

```ts
import { Account, Client, Databases, Query } from '@bunwrite/sdk'

const client = new Client().setEndpoint('https://api.example.com/v1').setProject('your-project-id')

const account = new Account(client)
await account.createEmailPasswordSession({ email: 'me@example.com', password: '...' })

const databases = new Databases(client)
const { documents } = await databases.listDocuments({
  databaseId: 'main',
  collectionId: 'orders',
  queries: [Query.equal('status', 'open'), Query.orderDesc('$createdAt')],
})
```

On a server, use an API key:

```ts
import { Client, ID, InputFile, Storage, Users } from '@bunwrite/sdk'

const client = new Client().setEndpoint('https://api.example.com/v1').setProject('your-project-id').setKey(process.env.BUNWRITE_KEY!)

await new Users(client).create({ userId: ID.unique(), email: 'new@example.com', password: 'a long password' })
await new Storage(client).createFile({ bucketId: 'invoices', fileId: ID.unique(), file: InputFile.fromPath('./INV-001.pdf') })
```

Without a bundler, load `dist/bunwrite.iife.js` and use `window.Bunwrite`:

```html
<script src="https://cdn.jsdelivr.net/npm/@bunwrite/sdk@0.7.0/dist/bunwrite.iife.js"></script>
<script>
  const client = new Bunwrite.Client().setEndpoint('https://api.example.com/v1').setProject('your-project-id')
</script>
```

Every method takes one object of parameters. Appwrite's older positional style
(`databases.getDocument('main', 'orders', id)`) still works, but is
deprecated.

## Services

| Service | What it covers |
| --- | --- |
| `Account` | Sign-up, email + password, email OTP and magic URL sessions, token sessions, Google OAuth2 token flow, JWTs, recovery, email verification, name, email, password, prefs, sessions |
| `Databases` | Databases, collections, attributes, indexes, documents (one and bulk), increment/decrement, transactions |
| `TablesDB` | Databases, tables, columns and indexes (schema only, see below) |
| `Storage` | Buckets, files including chunked uploads, view/download/preview |
| `Vectors` | Bunwrite extension: vector collections, point ACLs, point upsert/list/get/delete, hybrid BM25 + vector search with optional reranking, external Qdrant index status/rebuild, re-indexing, audit rows, document upload/ingest (including OCR and table extraction) and document chunks |
| `RAG` | Bunwrite extension: chunk/embed/ingest text or files, async ingest jobs with OCR, hybrid retrieval, reranking, query planning, PII/injection guardrails, persisted retrieval-and-answer evaluation, context and optional answers |
| `Functions` | Functions, deployments, executions, variables |
| `Sites` | Static sites, deployments, custom domains and variables |
| `Teams` | Teams, prefs, memberships and invitations |
| `Users` | Users, labels, prefs, sessions, tokens, JWTs, identities, memberships (API key) |
| `Messaging` | Topics |
| `Webhooks` | Webhooks and their secrets |
| `Proxy` | Custom domains for sites and functions, as Appwrite proxy rules |
| `Project` | Services, protocols, sign-in methods, policies, per-language email templates, mock phone numbers and global variables (API key) |
| `Locale` | Countries, continents, currencies, languages, phone codes and locale codes, localized by `setLocale()` |
| `Organization` | Projects of the organization (console sign-in) |
| `Realtime` | Subscriptions over WebSocket in browsers and on servers: document events, `custom.*` channels and presence (`upsertPresence`); server-side publishing uses `POST /v1/realtime/publish` |
| `Health` | Is the server up, and which API version it speaks |
| `Render` | Bunwrite only: HTML to PDF or image (API key; see [docs/RENDER.md](../../docs/RENDER.md)) |

Helpers: `Query`, `ID`, `Permission`, `Role`, `Operator`, `Channel`,
`InputFile`, the enums, and the `Models` types.

### Vectors and RAG

```ts
import { Client, RAG, Vectors } from '@bunwrite/sdk'

const client = new Client().setEndpoint('https://api.example.com/v1').setProject('my-project').setKey(process.env.BUNWRITE_KEY!)
const vectors = new Vectors(client)
const rag = new RAG(client)

await vectors.createCollection({ collectionId: 'handbook', name: 'Handbook', dimension: 384 })
await vectors.upsertPoints({
    collectionId: 'handbook',
    points: [{ id: 'intro', content: 'Bunwrite runs on Bun.' }],
})
const matches = await vectors.search({ collectionId: 'handbook', text: 'what does it run on?', topK: 5 })

await rag.ingest({ collectionId: 'handbook', documentId: 'guide', text: 'Long document text...' })
const result = await rag.query({ collectionId: 'handbook', query: 'What does it run on?', generate: false })
```

### Realtime

```ts
import {
    Channel,
    Client,
    Realtime,
    listRealtimeEvents,
    publishRealtimeEvent,
} from '@bunwrite/sdk'

const client = new Client()
    .setEndpoint('https://api.example.com/v1')
    .setProject('my-project')

const realtime = new Realtime(client)
await realtime.subscribe('custom.public.news', (event) => console.log(event.payload))
await realtime.upsertPresence({ presenceId: 'tab-1', status: 'online' })
await realtime.subscribe(Channel.presences(), (event) => console.log(event.events, event.payload))

// Server only: the key needs the realtime.write scope.
await publishRealtimeEvent(client.setKey(process.env.BUNWRITE_KEY!), {
    channels: ['custom.public.news'],
    events: ['news.created'],
    payload: { title: 'Hello' },
})

// Replay after a reconnect; same channel ACL as a subscription.
const replay = await listRealtimeEvents(client, {
    channels: ['custom.public.news'],
    after: 0,
    limit: 100,
})
```

`subscribe` accepts document channels, `custom.public.*`, `custom.authenticated.*`,
`custom.user.<id>`, `custom.team.<id>` and `custom.label.<label>`. Presence uses
`presences` / `presences.<presenceId>`. Each custom event has a `seq`; store the
last one and pass it as `after` to resume.

## Differences from the Appwrite SDKs

- **One SDK for client and server.** `setKey` and the server-only services
  are there in the browser build too; they only work with an API key, so keep
  keys on servers.
- **File URLs and bytes.** As in the Web SDK, `getFileView`, `getFileDownload`
  and `getFilePreview` return a URL for `<img src>` and links. To get the bytes
  on a server, as the Node.js SDK does, call `getFileViewBytes`,
  `getFileDownloadBytes` or `getFilePreviewBytes`.
- **TablesDB has the schema only.** Bunwrite serves rows through the
  `Databases` document endpoints, so the TablesDB row methods are not
  included. The same data is reachable as collections and documents.
- **Only what Bunwrite serves.** Methods for endpoints Bunwrite does not have
  (Avatars, Locale, MFA, phone login, sending messages, …) are left out
  rather than failing at runtime.
- **Errors** are `BunwriteException`, with the same `code`, `type`, `message`
  and `response` as Appwrite's `AppwriteException`.
- **Large integers.** Numbers beyond 2^53 come back as `BigInt` where the
  runtime lets JSON.parse see the source text (Node 21+, current browsers);
  elsewhere they are numbers, as with plain JSON.
- `setSelfSigned(true)` works on Bun only.
- **Bunwrite's names on the wire:** `X-Bunwrite-*` headers, and the
  `bw_session_<project>` session cookie (an `a_session_<project>` cookie from
  older sign-ins is found too).

## Updating from Appwrite

The copied code is generated. From the Bunwrite repository:

```bash
bun scripts/sdk-sync.ts
```

It reads the original TypeScript from the `appwrite` and `node-appwrite`
devDependencies (it ships in their source maps), keeps each method whose HTTP
method and path Bunwrite routes, and rewrites `src/services`, the helpers,
`models.ts` and the enums. Upgrade those packages, or add routes to the
server, then run it again. `client.ts`, `json.ts`, `inputFile.ts`,
`index.ts`, `browser.ts`, `services/health.ts`, `services/render.ts`,
`services/vectors.ts` and `services/rag.ts` are written by hand.

## Build

```bash
bun run build      # dist/index.js (ESM), dist/index.cjs, dist/bunwrite.iife.js, .d.ts files
bun run typecheck
```

The tests run the SDK against a real server: `bun test test/sdk.test.ts` from
the repository root.

## License

MIT for the Bunwrite code, BSD 3-Clause for the code copied from Appwrite. See
[LICENSE](LICENSE). Bunwrite is not affiliated with Appwrite.
