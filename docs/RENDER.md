# HTML rendering: PDF and images

Two endpoints turn HTML into files with headless Chromium:

- `POST /v1/pdf`: invoices, receipts, reports.
- `POST /v1/image`: png, jpg, webp, avif or gif. Useful for social cards,
  receipt images for chat apps, and thumbnails.

These are Bunwrite extensions; Appwrite has no such endpoints, so call them
with `fetch` instead of an SDK. Bunwrite drives Chromium through `Bun.WebView`
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

Both endpoints need an API key (`X-Appwrite-Key`), so call them from your server
or a function, not from a browser.

## PDF

```bash
curl -X POST https://api.example.com/v1/pdf \
  -H "X-Appwrite-Project: $PROJECT_ID" \
  -H "X-Appwrite-Key: $API_KEY" \
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
  -H "X-Appwrite-Project: $PROJECT_ID" \
  -H "X-Appwrite-Key: $API_KEY" \
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
| `scale` | `1` | Device pixel ratio, 1–3. `2` gives sharp text on phones and retina screens |
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
    fetch(`${process.env.APPWRITE_FUNCTION_API_ENDPOINT}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-appwrite-project': process.env.APPWRITE_FUNCTION_PROJECT_ID,
        'x-appwrite-key': process.env.APPWRITE_API_KEY,
      },
      body: JSON.stringify(body),
    }).then((r) => r.json())

  const pdf = await call('/pdf', { html, bucketId: 'invoices', fileName: 'INV-001' })
  const preview = await call('/image', { html, bucketId: 'invoices', fileName: 'INV-001', output: 'webp', width: 800, scale: 2 })
  return res.json({ pdf: pdf.$id, preview: preview.$id })
}
```

## Remote assets and safety

By default every `http(s)`, `ws(s)`, `file` and `ftp` request from the page is
blocked, so a render never touches the network. Embed logos and fonts as
`data:` URLs, or tick **Allow remote images, fonts and stylesheets**. Even
then, Chromium refuses requests to `localhost` and private networks.

JavaScript in the page runs, so templates can format numbers or dates, but
it cannot reach the network while remote assets are blocked.

## Memory and limits

- One render at a time; up to 20 more wait in line, then requests get 429.
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
