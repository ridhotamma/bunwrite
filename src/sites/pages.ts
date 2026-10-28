/** Small HTML pages for site states: paused, missing, failed to start. */

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
}

export function sitePage(status: number, title: string, text: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#333}main{text-align:center;padding:16px}h1{font-size:20px;margin:0 0 4px}p{margin:0;color:#777}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS } },
  )
}
