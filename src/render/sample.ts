/** A small invoice used by the console's "Try it" form and the docs. */
export const SAMPLE_INVOICE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: "Liberation Sans", Arial, sans-serif; color: #1f2328; font-size: 12px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
  h1 { margin: 0; font-size: 26px; letter-spacing: .5px; }
  .muted { color: #656d76; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { text-align: left; background: #f6f8fa; }
  th, td { padding: 8px; border-bottom: 1px solid #d0d7de; }
  td.num, th.num { text-align: right; }
  tfoot td { font-weight: bold; border-bottom: none; }
</style>
</head>
<body>
  <header>
    <div><h1>INVOICE</h1><div class="muted">INV-2026-0001 · 27 Oct 2026</div></div>
    <div style="text-align:right"><b>Your Company</b><br>Jl. Contoh No. 1<br>Jakarta</div>
  </header>
  <div><span class="muted">Billed to</span><br><b>PT Pelanggan</b><br>billing@example.com</div>
  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
    <tbody>
      <tr><td>Hosting (monthly)</td><td class="num">1</td><td class="num">Rp 150.000</td><td class="num">Rp 150.000</td></tr>
      <tr><td>Domain renewal</td><td class="num">1</td><td class="num">Rp 200.000</td><td class="num">Rp 200.000</td></tr>
    </tbody>
    <tfoot><tr><td colspan="3" class="num">Total</td><td class="num">Rp 350.000</td></tr></tfoot>
  </table>
</body>
</html>
`
