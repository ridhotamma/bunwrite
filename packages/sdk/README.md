# Bunwrite SDK

One SDK for [Bunwrite](../../README.md) that runs in browsers, Bun, Node.js 18+
and edge runtimes. It has no dependencies.

The API is Appwrite's: the services, method names and parameters are copied
from Appwrite's Web SDK and SDK for Node.js, trimmed to the endpoints Bunwrite
serves. Code written for `appwrite` or `node-appwrite` usually only needs its
import changed.

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
<script src="https://cdn.jsdelivr.net/npm/@bunwrite/sdk@0.1.0/dist/bunwrite.iife.js"></script>
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
| `Account` | Sign-up, email + password and email OTP sessions, token sessions, Google OAuth2 token flow, JWTs, recovery, email verification, name, email, password, prefs, sessions |
| `Databases` | Databases, collections, attributes, indexes, documents (one and bulk), increment/decrement, transactions |
| `TablesDB` | Databases, tables, columns and indexes (schema only, see below) |
| `Storage` | Buckets, files including chunked uploads, view/download/preview |
| `Functions` | Functions, deployments, executions, variables |
| `Teams` | Teams, prefs, memberships and invitations |
| `Users` | Users, labels, prefs, sessions, tokens, JWTs, identities, memberships (API key) |
| `Messaging` | Topics |
| `Webhooks` | Webhooks and their secrets |
| `Project` | Services, protocols, sign-in methods, policies, email templates, mock phone numbers (API key) |
| `Organization` | Projects of the organization (console sign-in) |
| `Realtime` | Subscriptions over WebSocket, in browsers and on servers |
| `Health` | Is the server up, and which API version it speaks |
| `Render` | Bunwrite only: HTML to PDF or image (API key; see [docs/RENDER.md](../../docs/RENDER.md)) |

Helpers: `Query`, `ID`, `Permission`, `Role`, `Operator`, `Channel`,
`InputFile`, the enums, and the `Models` types.

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
  (Avatars, Locale, Sites, MFA, phone login, sending messages, …) are left out
  rather than failing at runtime.
- **Errors** are `BunwriteException` with the same `code`, `type`, `message`
  and `response`. `AppwriteException` is exported as the same class.
- **Large integers.** Numbers beyond 2^53 come back as `BigInt` where the
  runtime lets JSON.parse see the source text (Node 21+, current browsers);
  elsewhere they are numbers, as with plain JSON.
- `setSelfSigned(true)` works on Bun only.
- Headers stay `X-Appwrite-*`, since that is what the server reads.

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
`index.ts`, `browser.ts`, `services/health.ts` and `services/render.ts` are
written by hand.

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
