# HTML to PDF

`POST /v1/pdf` renders HTML to a PDF with headless Chromium. It is meant for
invoices, receipts and similar documents. This is a Bunwrite extension;
Appwrite has no such endpoint, so call it with `fetch` instead of an SDK.

Bunwrite drives Chromium through `Bun.WebView` and the DevTools protocol
(`Page.printToPDF`), the same thing Puppeteer and Playwright do, without
either dependency.

## Turn it on

1. Install Chromium:
   - Docker: `BUNWRITE_WITH_PDF=true docker compose up -d --build`
   - Ubuntu/Debian: `sudo apt install chromium fonts-liberation`
   - Elsewhere: install Chrome or Chromium, or set `CHROME_PATH`.
2. Open **Console → Settings → PDF**, tick **Enable PDF rendering** and save.
   `PDF_ENABLED=true` in `.env` does the same. The page shows whether Chromium
   was found and has a **Try it** form with a sample invoice.

Turning it off stops Chromium right away.

## Request

Needs an API key (`X-Appwrite-Key`), so call it from your server or a function,
not from a browser.

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
| `fileName` | `document.pdf` | `.pdf` is added when missing |
| `download` | `false` | `Content-Disposition: attachment` instead of `inline` |
| `bucketId` | none | Save to this bucket instead of returning the PDF |
| `fileId`, `permissions` | `unique()`, none | Used with `bucketId` |

CSS `@page { size: A4; margin: 16mm }` wins over `format` and `margin`.

Without `bucketId` the response is the PDF (`application/pdf`). With it, the
PDF is stored like any upload (local disk or S3, whichever file storage uses)
and the response is the file object, status 201. The bucket must allow the
`pdf` extension, or allow all extensions.

### From a function

```js
export default async ({ req, res }) => {
  const html = renderInvoice(JSON.parse(req.body)) // your template
  const r = await fetch(`${process.env.APPWRITE_FUNCTION_API_ENDPOINT}/pdf`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-appwrite-project': process.env.APPWRITE_FUNCTION_PROJECT_ID,
      'x-appwrite-key': process.env.APPWRITE_API_KEY,
    },
    body: JSON.stringify({ html, bucketId: 'invoices', fileName: 'INV-001' }),
  })
  return res.json(await r.json())
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
- Measured in a 1 vCPU / 512 MB container: a one-page invoice takes about
  0.6 s, a large invoice about 0.65 s per document once Chromium is running,
  and Bun plus Chromium peak around 175–330 MB depending on the document.
- `CHROME_ARGS` adds Chromium flags; `CHROME_NO_SANDBOX=true` is needed in
  most containers (the compose file sets it).
