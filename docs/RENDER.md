# HTML rendering: PDF and images

Two endpoints turn HTML into files with headless Chromium:

- `POST /v1/pdf`: invoices, receipts, reports.
- `POST /v1/image`: png, jpg, webp, avif or gif. Useful for social cards,
  receipt images for chat apps, and thumbnails.

These are Bunwrite extensions, not part of Appwrite's API: call them with
`fetch`, or with `Render` in the Bunwrite SDK. Bunwrite drives Chromium through `Bun.WebView`
and the DevTools protocol (`Page.printToPDF`, `Page.captureScreenshot`), the
same thing Puppeteer and Playwright do, without either dependency.

## Turn it on

1. Install Chromium:
   - Docker: set `BUNWRITE_WITH_CHROMIUM=true` in `.env`, then
     `docker compose up -d --build`
   - Ubuntu/Debian: `sudo apt install chromium fonts-liberation`
   - Elsewhere: install Chrome or Chromium, or set `CHROME_PATH`.
2. Open **Console → Settings → HTML rendering**, tick **Enable HTML
   rendering** and save. `RENDER_ENABLED=true` in `.env` does the same. The
   page shows whether Chromium was found and has a **Try it** form that renders
   a sample invoice as PDF, PNG, JPG or WebP.

One switch covers both endpoints. Turning it off stops Chromium right away.

Both endpoints need an API key (`X-Bunwrite-Key`), so call them from your server
or a function, not from a browser.

## PDF

```bash
curl -X POST https://api.example.com/v1/pdf \
  -H "X-Bunwrite-Project: $PROJECT_ID" \
  -H "X-Bunwrite-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"html": "<h1>Invoice INV-001</h1>", "fileName": "INV-001"}' \
  -o INV-001.pdf
```

| Param | Default | |
| --- | --- | --- |
| `html` | required | Full HTML document, up to 5 MB |
| `format` | `A4` | `A3`, `A4`, `A5`, `Letter`, `Legal`, `Tabloid` |
| `landscape` | `false` | |
| `printBackground` | `true` | Print background colours and images |
| `margin` | `10` | Millimetres, or `{ "top", "right", "bottom", "left" }` |
| `scale` | `1` | 0.1 to 2 |
| `pageRanges` | all | e.g. `"1-2"` |
| `headerTemplate`, `footerTemplate` | none | Chromium templates; `<span class="pageNumber"></span> / <span class="totalPages"></span>` |
| `fileName` | `document` | `.pdf` is added when missing |

CSS `@page { size: A4; margin: 16mm }` wins over `format` and `margin`.

## Image

```bash
curl -X POST https://api.example.com/v1/image \
  -H "X-Bunwrite-Project: $PROJECT_ID" \
  -H "X-Bunwrite-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"html": "<div id=card>...</div>", "selector": "#card", "output": "webp", "scale": 2}' \
  -o card.webp
```

| Param | Default | |
| --- | --- | --- |
| `html` | required | Full HTML document, up to 5 MB |
| `output` | `png` | `png`, `jpg` (or `jpeg`), `webp`, `avif`, `gif` |
| `width` | `1200` | Viewport width in CSS pixels, 16–4000 |
| `height` | `800` | Viewport height in CSS pixels, 16–16384; the minimum height with `fullPage` |
| `fullPage` | `true` | Capture the whole page; `false` captures only the viewport |
| `selector` | none | Capture only the first element matching this CSS selector |
| `scale` | `1` | Device pixel ratio, 0.1–3. `2` gives sharp text on phones and retina screens; below `1` gives a smaller image of the same layout (thumbnails) |
| `quality` | encoder default | 1–100 for `jpg`, `webp` and `avif` |
| `transparent` | `false` | Transparent instead of white page background (not for `jpg`) |
| `fileName` | `image` | The extension for `output` is added when missing |

Examples:

- Social card: `{ "width": 1200, "height": 630, "fullPage": false }`
- Receipt image for chat: `{ "selector": "#receipt", "scale": 2, "output": "webp" }`
- Transparent badge: `{ "selector": ".badge", "transparent": true, "output": "png" }`

Pages always render in the light colour scheme on a white background, so the
result does not depend on the server's settings.

## Return it, or save it to a bucket

Both endpoints take the same extra params:

| Param | Default | |
| --- | --- | --- |
| `download` | `false` | `Content-Disposition: attachment` instead of `inline` |
| `bucketId` | none | Save to this bucket instead of returning the file |
| `fileId`, `permissions` | `unique()`, none | Used with `bucketId` |

Without `bucketId` the response is the file itself. With it, the file is
stored like any upload (local disk or S3, whichever file storage uses) and the
response is the file object, status 201. The bucket must allow the extension
(`pdf`, `png`, `webp`, …) or allow all extensions.

### From a function

```js
export default async ({ req, res }) => {
  const html = renderInvoice(JSON.parse(req.body)) // your template
  const call = (path, body) =>
    fetch(`${process.env.BUNWRITE_FUNCTION_API_ENDPOINT}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bunwrite-project': process.env.BUNWRITE_FUNCTION_PROJECT_ID,
        'x-bunwrite-key': process.env.BUNWRITE_API_KEY,
      },
      body: JSON.stringify(body),
    }).then((r) => r.json())

  const pdf = await call('/pdf', { html, bucketId: 'invoices', fileName: 'INV-001' })
  const preview = await call('/image', { html, bucketId: 'invoices', fileName: 'INV-001', output: 'webp', width: 800, scale: 2 })
  return res.json({ pdf: pdf.$id, preview: preview.$id })
}
```

## Queue it: `async: true`

Renders run one at a time, so a burst of direct requests waits in line, and
past 20 waiting they get 429. For bursts (a batch of invoices, a webhook
storm), send `async: true` with a `bucketId` instead. The call returns at
once with a job (status 202); the server renders it when the line is free and
saves it to the bucket. Queued renders are never refused for being busy.

```bash
curl -X POST https://api.example.com/v1/pdf \
  -H "X-Bunwrite-Project: $PROJECT_ID" -H "X-Bunwrite-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"html": "<h1>INV-001</h1>", "async": true, "bucketId": "invoices", "fileId": "inv-001"}'
```

```json
{ "$id": "68f...", "type": "pdf", "status": "waiting", "attempts": 0, "maxAttempts": 3,
  "bucketId": "invoices", "fileId": "inv-001", "fileName": "document.pdf", "completedAt": null, "errors": "" }
```

`fileId` is fixed when the job is created (a unique one if you leave it out),
so you can store it right away. `GET /v1/render/jobs/:jobId` returns the job;
the file is in the bucket once `status` is `completed`. With the SDK:

```ts
const job = await render.pdfJob({ html, bucketId: 'invoices', fileId: 'inv-001' })
// later
const { status } = await render.getJob({ jobId: job.$id })
```

- Bad input (no bucket, a taken `fileId`, HTML too large, an image too big) is
  refused when the job is created, with the same 4xx as a direct render.
- Jobs are stored in SQLite (the `_render` system queue). A restart picks up
  where it left off: a job that was rendering is retried after its lease.
- A Chromium failure or timeout is retried with backoff, 3 attempts in all.
  An error another attempt cannot fix (a selector that matches nothing) fails
  the job on the first attempt, with `errors` saying why.
- While rendering is turned off, jobs wait; turning it on runs them.
- A finished job keeps its status for 30 days but drops its HTML.

## Remote assets and safety

By default every `http(s)`, `ws(s)`, `file` and `ftp` request from the page is
blocked, so a render never touches the network. Embed logos and fonts as
`data:` URLs, or tick **Allow remote images, fonts and stylesheets**. Even
then, Chromium refuses requests to `localhost` and private networks.

JavaScript in the page runs, so templates can format numbers or dates, but
it cannot reach the network while remote assets are blocked.

## Memory and limits

- One render at a time across all projects; up to 20 direct requests wait in
  line, then they get 429. Queued (`async: true`) renders wait in SQLite
  instead and are never refused for being busy.
- A render taking over 30 seconds is stopped and Chromium is restarted.
- Chromium starts on the first render and stops after one minute idle.
- Images are limited to 8 megapixels (width × height × scale²): a 1200 px
  wide full page up to about 6,600 CSS pixels tall at 1×, or 1,650 at 2×. A
  capture needs about 190 MB plus 17 MB per megapixel, so 8 MP peaks near
  300 MB and leaves room for image previews at the same time. Raise it with
  `RENDER_MAX_MEGAPIXELS` on a bigger host (about 1 GB per 30 MP). For long
  documents, use PDF.
- AVIF output is limited to 4 MP (`AVIF_MAX_MEGAPIXELS`): encoding needs about
  30 bytes per pixel, so a 15 MP AVIF takes about 460 MB on its own.
- Larger requests get a 400 error before anything is rendered.
- `CHROME_ARGS` adds Chromium flags; `CHROME_NO_SANDBOX=true` is needed in
  most containers (the compose file sets it).
