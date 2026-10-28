# Sites: static hosting

Bunwrite serves static sites from the same process as the API: plain HTML,
htmx pages, or the output of a framework build (Vite, React, Vue, Svelte,
Astro, Angular). **Nothing is built on the server.** Files are served exactly
as you upload them, so a deploy takes as long as the upload.

For dynamic parts, give the site an **API function**: `/api/*` on the site's
own domain then runs that function. htmx pages can `hx-get="/api/..."` and
get HTML fragments back, with no CORS setup and no separate backend host.

## Addresses

Each site answers on `<site-id>.<SITES_DOMAIN>`:

| Setting | Site URL |
| --- | --- |
| Local, no `DOMAIN` | `http://<site-id>.localhost:8080` (browsers resolve `*.localhost` to this machine) |
| `DOMAIN=api.example.com` | `https://<site-id>.sites.api.example.com` |
| `SITES_DOMAIN=sites.example.com` | `https://<site-id>.sites.example.com` |

Site IDs are subdomains: lowercase letters, digits and hyphens, up to 36
characters. They are unique across all projects on the server.

A site can also have one **custom domain**, such as `www.example.com`. Point a
CNAME at `<site-id>.<SITES_DOMAIN>` (or an A record at the server) and set the
domain in **Console → Sites → Settings**, with the API (`domain`), or as an
Appwrite proxy rule (`proxy.createSiteRule`).

### HTTPS with the bundled Caddy

The [Caddyfile](../Caddyfile) has a catch-all block with on-demand TLS: the first
visit to a site host gets its Let's Encrypt certificate. Caddy first asks
Bunwrite (`/.well-known/bunwrite/site-domain`) whether the host is a site, so
no one can make it request certificates for other names. You only need DNS:

```
*.sites.example.com   A   203.0.113.10
www.example.com       CNAME   landing.sites.example.com
```

Behind your own proxy, forward site hosts to Bunwrite with their `Host` header
(or `X-Forwarded-Host`).

## Deploy

### Console

**Console → Sites → Create site**. Pick one of:

- **htmx starter**: `index.html`, a fragment and `htmx.min.js`, live at once.
- **Upload a folder**: a `.zip` or `.tar.gz`. If everything sits inside one
  folder (as when you zip a folder), that folder becomes the site.
- **Write HTML**: one `index.html`.

**Deploy** on the site page uploads a new version. The old one keeps serving
until the new one is ready. **Make live** on an older deployment rolls back at
once. The live deployment and the last five ready ones are kept.

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
      "apiFunctionId": "api"
    }
  ]
}
```

```bash
npm run build --prefix web
bunwrite push sites
```

Only `outputDirectory` inside `path` is uploaded, and `.gitignore` is not
applied there (build output is usually ignored by git). Add `"ignore": [...]`
to leave files out. `bunwrite pull sites` writes the live files back.

### SDK

`Sites` in `@bunwrite/sdk` and `node-appwrite` work the same way:

```ts
import { Client, Sites, InputFile, Framework, BuildRuntime } from '@bunwrite/sdk'

const sites = new Sites(new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey))
await sites.create({ siteId: 'landing', name: 'Landing', framework: Framework.Other, buildRuntime: BuildRuntime.Static1, apiFunctionId: 'api' })
await sites.createDeployment({ siteId: 'landing', code: InputFile.fromPath('site.tar.gz'), activate: true })
```

`apiFunctionId` and `domain` are Bunwrite extensions; with `node-appwrite`,
set them in the console or with a plain `PUT /v1/sites/<id>` call.

## Serving rules

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

- Build commands. `installCommand` and `buildCommand` are stored and returned
  for Appwrite compatibility, but never run; the deployment log says so.
- Server-side rendering (`adapter: ssr`), site variables, Git deployments and
  preview URLs per deployment.
