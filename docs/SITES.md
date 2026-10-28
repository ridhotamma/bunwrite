# Sites: static and server-rendered

Bunwrite serves sites from the same process as the API. Plain HTML, htmx pages
and the output of a framework build (Vite, React, Vue, Svelte, Astro, Angular)
are uploaded as they should be served and return instantly. With
`adapter: 'ssr'` the upload is the app's source instead: Bunwrite installs and
builds it here, then runs its start command behind the site's address.

For dynamic parts, give the site an **API function**: `/api/*` on the site's
own domain then runs that function. htmx pages can `hx-get="/api/..."` and
get HTML fragments back, with no CORS setup and no separate backend host. An
SSR site with no start command sends *every* path to that function, which is
the lightest way to render pages per request.

## Addresses

Each site answers on `<site-id>.<SITES_DOMAIN>`:

| Setting | Site URL |
| --- | --- |
| Local, no `DOMAIN` | `http://<site-id>.sites.localhost:8080` (browsers resolve `*.localhost` to this machine) |
| `DOMAIN=api.example.com` | `https://<site-id>.sites.api.example.com` |
| `SITES_PREFIX=web` | `https://<site-id>.web.api.example.com` |
| `SITES_DOMAIN=sites.example.com` | `https://<site-id>.sites.example.com` |

Site IDs are subdomains: lowercase letters, digits and hyphens, up to 36
characters. They are unique across all projects on the server.

A site can also have any number of **custom domains**, such as
`www.example.com` and `shop.example.com`. Point a CNAME at
`<site-id>.<SITES_DOMAIN>` (or an A record at the server) and add the domains in
**Console → Sites → Settings**, with the API (`domains` array), or as Appwrite
proxy rules (`proxy.createSiteRule`). The default site address always keeps
working when a custom domain is added or removed.

Functions use the same model: `<function-id>.<FUNCTIONS_DOMAIN>` by default
(`<function-id>.functions.example.com`), plus any number of custom domains.

### HTTPS with the bundled Caddy

The [Caddyfile](../Caddyfile) has a catch-all block with on-demand TLS: the first
visit to a site or function host gets its Let's Encrypt certificate. Caddy asks
Bunwrite (`/.well-known/bunwrite/host`) whether the host belongs here, so no one
can make it request certificates for other names. You only need DNS:

```
*.sites.example.com       A    203.0.113.10
*.functions.example.com   A    203.0.113.10
www.example.com           CNAME   landing.sites.example.com
```

Behind your own proxy, forward site and function hosts to Bunwrite with their
`Host` header (or `X-Forwarded-Host`).

## Deploy

### Console

**Console → Sites → Create site** (`/console/sites/new`). Pick the source
first; it decides what else the page asks for:

| Source | Then you choose | What happens |
| --- | --- | --- |
| **GitHub repository** | Account, repository, branch, folder. The framework, runtime and commands are detected from the repository and can be changed | Installed and built here on every push ([GIT.md](GIT.md)) |
| **Upload a folder** | A framework. A static one needs only the output folder; a server app also gets a runtime, install, build and start commands | Static: served as uploaded (build first). Server app: upload the source; it is installed, built and started here |
| **htmx starter** | Nothing | `index.html`, a fragment and `htmx.min.js`, live at once |
| **Write HTML** | Nothing | One `index.html`, live at once |

The starter and Write HTML are always plain static files, so they have no
framework or runtime. If everything in an upload sits inside one folder (as
when you zip a folder), that folder becomes the site.

The framework list has two groups:

- **Static site:** Plain HTML, Vite, React, Vue, Svelte, Solid, Angular, Astro,
  Next.js (static export), Nuxt (`nuxt generate`), SvelteKit (static adapter),
  Docusaurus, VitePress, Gatsby, Eleventy, and **Other static build**.
- **Server app (SSR):** Next.js, Nuxt, SvelteKit (Node adapter), Astro (Node
  adapter), TanStack Start, React Router 7, Remix, SolidStart, Analog, Hono,
  Node.js servers (Express, Fastify, Koa…), and **Other server**.

The adapter (`static` or `ssr`) follows from the group. The "Other" entries
take any commands.

**Deploy** on the site page uploads a new version. The old one keeps serving
until the new one is ready. **Make live** on an older deployment rolls back at
once. The live deployment and the last five ready ones are kept (the last two
for SSR sites, whose source trees may include installed packages).

### CLI

In `bunwrite.config.json` (or `appwrite.config.json`):

```json
{
  "projectId": "my-project",
  "sites": [
    {
      "$id": "landing",
      "name": "Landing",
      "framework": "vite",
      "path": "web",
      "outputDirectory": "dist",
      "fallbackFile": "index.html",
      "apiFunctionId": "api",
      "domains": ["www.example.com", "shop.example.com"]
    }
  ]
}
```

```bash
npm run build --prefix web
bunwrite push sites
```

For static sites only `outputDirectory` inside `path` is uploaded, and
`.gitignore` is not applied there (build output is usually ignored by git). An
SSR site uploads its whole source folder, without `node_modules`; the server
installs and builds it. Add `"ignore": [...]` to leave more files out.
`bunwrite push sites` follows an SSR build until it is ready, and
`bunwrite pull sites` writes the live files back.

### SDK

`Sites` in `@bunwrite/sdk` and `node-appwrite` work the same way:

```ts
import { Client, Sites, InputFile, Framework, BuildRuntime } from '@bunwrite/sdk'

const sites = new Sites(new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey))
await sites.create({ siteId: 'landing', name: 'Landing', framework: Framework.Other, buildRuntime: BuildRuntime.Static1, apiFunctionId: 'api' })
await sites.createDeployment({ siteId: 'landing', code: InputFile.fromPath('site.tar.gz'), activate: true })
```

`apiFunctionId`, `domains`, `adapter` and `startCommand` are Bunwrite
extensions; with `node-appwrite`, set them in the console or with a plain
`PUT /v1/sites/<id>` call.

## Runtimes

Builds and server apps run on the site's **runtime** (`buildRuntime`):

| Runtime | Versions |
| --- | --- |
| Node.js | `node-20`, `node-22` (default), `node-24`, `node-26`, or any `node-<major>` |
| Bun | `bun-1.1` to `bun-1.4`, or any `bun-<major>.<minor>` |

- **Download:** the first build that needs a version downloads the official
  build (from nodejs.org, or Bun's GitHub releases), checks it against the
  published SHA-256 sums, and keeps it in `<data>/.runtimes/<id>/<version>/`.
  The build log says so. Later builds and app starts reuse it, offline too.
- **This server's Bun** (the Bun line the server itself runs on, marked "this
  server" in the console) needs no download. Its `node`, `npm` and `npx` run
  through Bun.
- **Rollbacks:** each deployment remembers its runtime, so a rollback runs on
  the runtime it was built with.
- **No network:** set `RUNTIMES_DOWNLOAD=false` to run every Node.js and Bun
  runtime on this server's Bun, with a line in the build log.
  `RUNTIMES_NODE_MIRROR` points at another Node.js mirror.
- **Older deployments:** those made before runtimes were real have none, and
  keep running as before.

Functions use the same runtimes; see the functions guide.

## Server-side rendering

An SSR site is still a site deployment; only the adapter changes:

```json
{
  "sites": [
    {
      "$id": "app",
      "name": "App",
      "framework": "nuxt",
      "path": "web",
      "adapter": "ssr",
      "installCommand": "npm install",
      "buildCommand": "npm run build",
      "startCommand": "node .output/server/index.mjs"
    }
  ]
}
```

On deploy, the source is unpacked, `installCommand` then `buildCommand` run in
the deployment folder, and the result becomes ready. The start command is
saved **with the deployment**, so rolling back runs the app that belonged to
that version, not the current settings.

Requests are proxied to the app's process:

- it starts on the first request and listens on `127.0.0.1:$PORT`;
- it is stopped after `SITES_SSR_IDLE_MS` without a request;
- at most `SITES_SSR_MAX_PROCESSES` apps run per project (least recently used
  first out);
- a crash answers `502` once, then the next request starts it again after a
  short backoff;
- activating another deployment, deleting the site or project, and shutting
  down stop it.

The app receives `PORT`, `HOST`/`HOSTNAME=127.0.0.1` and
`NODE_ENV=production`, plus `X-Forwarded-Host` and `X-Forwarded-Proto` on every
request. It does not receive the public request's `Host` header. Set `ORIGIN`
in the framework's own config when it builds absolute URLs; the server already
passes `PROTOCOL_HEADER` and `HOST_HEADER` through for adapters that read them.

Only SSR frameworks that produce a normal HTTP server work: Next.js
(`.next/standalone/server.js`, with `output: 'standalone'` in `next.config`),
Nuxt, SvelteKit, Astro, Remix, or a Bun/Hono app. Any HTTP method and request body is proxied; WebSocket
upgrades and background workers that outlive a request are not.

### Cleanup after the build

The install step puts the whole development toolchain in `node_modules`
(often 400–700 MB). The running app needs much less, so after a successful
build the server removes what it does not need. The site's `pruneMode` picks
how:

| `pruneMode` | What it does | Use it for |
| --- | --- | --- |
| `auto` (default) | `standalone` when the start command runs `.next/standalone/…` or `.output/server/…` and that folder exists; `production` otherwise | Every framework |
| `standalone` | Deletes `node_modules`. For Next.js it first copies `public` and `.next/static` into `.next/standalone` | Builds that carry their own dependencies: Next.js standalone, Nuxt and other Nitro apps, a bundled Bun/Node server |
| `production` | Removes dev dependencies and keeps runtime ones: `npm prune --omit=dev`, `pnpm prune --prod`, `yarn` production install, or `bun install --production` | SvelteKit, Astro, Remix and any app that loads packages at runtime |
| `none` | Keeps everything | An app that needs a package listed under `devDependencies` |

The package manager comes from the install command, or from the lockfile when
the command names none. Every mode except `none` also removes `.next/cache` and
`node_modules/.cache`. The build log shows the deployment's size before and
after. If the cleanup fails, the deployment still goes ahead with whatever is
left, and the log says so.

A runtime package listed under `devDependencies` is the usual reason an app
stops starting after `production`; move it to `dependencies`, or set
`pruneMode` to `none`. The cleanup only runs after this server's own install or
build, so `SITES_BUILD_COMMANDS=false` leaves the upload as it is.

`SITES_SSR_KEEP_PREVIOUS` (default `2`) sets how many earlier SSR deployments
are kept for rollback.

The console shows the app's recent output on the live deployment page. Builds
run under the site's own user when `FUNCTIONS_SANDBOX` is on, with the same
trust model as functions: the uploaded commands run on the server. Keep
`SITES_SSR_MAX_PROCESSES` small on a 1 GB machine; memory, not CPU, is the
limit.

## Serving rules

These rules apply to static sites. An SSR site sends every path and method to
its app, or to its API function when it has no start command.

| Request | Served |
| --- | --- |
| `/` | `index.html` |
| `/about` | `about`, else `about.html`, else a redirect to `/about/` when `about/index.html` exists |
| No file, fallback file set, no extension in the path | The fallback file, with 200 (single-page apps) |
| No file | `404.html` with 404, else a small 404 page |
| `/api`, `/api/*` with an API function | The function (see below) |
| Anything but GET or HEAD | 405 |

- Pages and files without a content hash revalidate on every visit (ETag, 304).
  Files whose name has a hash (`app.3f9a1c2b.js`) are cached for a year.
- A file with a `.br` or `.gz` copy next to it gets the copy when the browser
  accepts it; other text is compressed on the fly.
- `X-Content-Type-Options: nosniff` and `Referrer-Policy:
  strict-origin-when-cross-origin` are set on every file.

## Sites and functions

With an API function, `/api/<rest>` runs that function with `req.path` set to
`/<rest>` and the query string kept. Method, headers and body are passed
through, and the function's response is sent back as it is.

```js
// functions/api/src/main.js
module.exports = async ({ req, res }) => {
  if (req.path === '/todos' && req.method === 'POST') {
    // save req.bodyJson ...
    return res.text('<li>New todo</li>', 200, { 'content-type': 'text/html' })
  }
  return res.json({ path: req.path })
}
```

```html
<form hx-post="/api/todos" hx-target="#list" hx-swap="beforeend">…</form>
```

The function's **Who may run it** setting still applies. A signed-in user
reaches it when the request carries a JWT (`X-Appwrite-JWT`, from
`account.createJWT()`); the function then sees `x-appwrite-user-id`. Bunwrite
drops any `x-*-user-id` a client sends itself, so the header can be trusted.

### The browser SDK on a site

A site's own addresses are trusted origins for its server. The browser SDK on
`https://landing.sites.example.com` can call the API without adding the origin
under **Settings → Allowed origins**. They also work as OAuth and email
redirect targets.

## Not supported

- Site variables. (Git deployments and branch previews: see [GIT.md](GIT.md).)
- WebSockets or HTTP upgrades into an SSR app, and background workers that
  outlive a request.
- Uploading a `.zip` of an SSR app with `node_modules`: packages are installed
  on the server instead. `SITES_BUILD_COMMANDS=false` runs no install or build,
  so the upload must already be complete.
