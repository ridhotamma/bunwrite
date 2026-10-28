---
name: bunwrite-sites
description: "Use when deploying or debugging a static site on Bunwrite: configuring a site in bunwrite.config.json, pushing a built Vite/React/Vue/Svelte/Astro/Angular output folder, custom domains, single-page fallbacks, htmx, or an /api/* function on the site's own origin. Triggers: Bunwrite Sites, bunwrite push sites, SITES_DOMAIN, outputDirectory, fallbackFile, apiFunctionId, static hosting on Bunwrite."
metadata:
  author: bunwrite
  version: "0.1.0"
---

# Bunwrite Sites

Bunwrite serves static sites from the same process as the API. Plain HTML, htmx
pages and the output of a framework build all work. **Nothing is built on the
server**: files are uploaded and served exactly as they are.

## Addresses

A site answers on `<site-id>.<SITES_DOMAIN>`:

| Setup | URL |
| --- | --- |
| Local, no `DOMAIN` | `http://<site-id>.localhost:8080` |
| `DOMAIN=api.example.com` | `https://<site-id>.sites.api.example.com` |
| `SITES_DOMAIN=sites.example.com` | `https://<site-id>.sites.example.com` |

Site IDs are lowercase letters, digits and hyphens, up to 36 characters, and
unique across the server. A site can also have one custom domain. Point a CNAME
at `<site-id>.<SITES_DOMAIN>` (or an A record at the server), then set the domain
in the console, the API (`domain`), or an Appwrite proxy rule.

Behind the bundled Caddy, on-demand TLS asks Bunwrite
(`/.well-known/bunwrite/site-domain`) whether a host is a site before requesting
a certificate.

## Deploy

### Console

**Console → Sites → Create site** offers an htmx starter, a folder upload
(`.zip` or `.tar.gz`) and pasted HTML. **Deploy** uploads a new version; the old
one keeps serving until the new one is ready. **Make live** rolls back. The live
deployment and the last five ready ones are kept.

### CLI

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
      "ignore": ["**/*.map"]
    }
  ]
}
```

```bash
npm run build --prefix web
bunwrite push sites
bunwrite pull sites
```

Only `outputDirectory` inside `path` is uploaded. `.gitignore` is not applied
there because build output is usually ignored by git; use `ignore` for patterns
to leave out. A missing output folder fails with "Run the build first".

### SDK

```ts
import { BuildRuntime, Client, Framework, InputFile, Sites } from '@bunwrite/sdk'

const sites = new Sites(new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey))
await sites.create({
  siteId: 'landing',
  name: 'Landing',
  framework: Framework.Other,
  buildRuntime: BuildRuntime.Static1,
  apiFunctionId: 'api',
})
await sites.createDeployment({ siteId: 'landing', code: InputFile.fromPath('site.tar.gz'), activate: true })
```

`apiFunctionId` and `domain` are Bunwrite extensions. With `node-appwrite`, set
them in the console or with a plain `PUT /v1/sites/<id>`.

## Routing

| Request | Served |
| --- | --- |
| `/` | `index.html` |
| `/about` | `about`, else `about.html`, else redirect to `/about/` when `about/index.html` exists |
| Missing file with `fallbackFile` and no extension | The fallback file with 200 (single-page apps) |
| Missing file otherwise | `404.html` with 404, else a small 404 page |
| `/api`, `/api/*` with `apiFunctionId` | The API function |
| Anything but GET or HEAD | 405 |

- Files without a content hash revalidate on every visit (ETag/304). Hashed
  names such as `app.3f9a1c2b.js` are cached for a year.
- A `.br` or `.gz` copy next to a file is served when the browser accepts it;
  other text is compressed on the fly.
- `X-Content-Type-Options: nosniff` and `Referrer-Policy:
  strict-origin-when-cross-origin` are set on every file.

## API functions on a site

With `apiFunctionId`, `/api/<rest>` runs that function on the site's own origin.
`req.path` is `/<rest>`, the query string is kept, and method, headers and body
pass through.

```js
// functions/api/src/main.js
module.exports = async ({ req, res }) => {
  if (req.path === '/todos' && req.method === 'POST') {
    return res.text('<li>New todo</li>', 200, { 'content-type': 'text/html' })
  }
  return res.json({ path: req.path })
}
```

```html
<form hx-post="/api/todos" hx-target="#list" hx-swap="beforeend">...</form>
```

The function's **Who may run it** setting still applies. A signed-in browser can
send a JWT (`X-Appwrite-JWT`, from `account.createJWT()`); the function then sees
the trusted `x-appwrite-user-id` header. Bunwrite drops any `x-*-user-id` header
the client sends itself.

A site's own addresses are trusted origins for its server, so the browser SDK on
`https://landing.sites.example.com` can call the API without adding the origin
under **Settings → Allowed origins**. They also work as OAuth and email redirect
targets.

## Not supported

- Build commands. `installCommand` and `buildCommand` are stored for Appwrite
  compatibility but never run; the deployment log says so.
- Server-side rendering (`adapter: ssr`), site variables, Git deployments and
  per-deployment preview URLs.

Build locally in CI or before `bunwrite push sites`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Run the build first" | Build so `path/outputDirectory` exists, then push. |
| Old content after push | The new deployment may not be active; make it live or push with activation. |
| SPA route returns 404 | Set `fallbackFile` (usually `index.html`); fallback only applies to paths without an extension. |
| Custom domain shows the wrong site | Check the CNAME/A record and the site's `domain` setting. |
| `/api/*` returns 404 | Set `apiFunctionId`, deploy the function, and check its execute permission. |
| Uploads include source maps | Add `ignore` patterns; `.gitignore` is not applied to the output folder. |

## Reference

- [Sites documentation](https://github.com/ridhotamma/bunwrite/blob/main/docs/SITES.md)
- [Bunwrite README](https://github.com/ridhotamma/bunwrite/blob/main/README.md)
- [Appwrite Sites docs](https://appwrite.io/docs/products/sites)
