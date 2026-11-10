/**
 * Small-screen helpers. Tables inside cards get `stacked` and a `data-label`
 * per cell (copied from the column header), so on phones the CSS can show each
 * row as a labelled block instead of a sideways-scrolling grid. Opt a table out
 * with `data-no-stack`. Escape also closes the slide-in sidebar.
 */
export const RESPONSIVE_SCRIPT = `
(() => {
  function stack(root) {
    for (const table of root.querySelectorAll('.card table:not([data-no-stack]):not(.perm-table)')) {
      const heads = [...table.querySelectorAll(':scope > thead th')].map((th) => th.textContent.trim())
      if (!heads.length) continue
      table.classList.add('stacked')
      const rows = [...table.tBodies].flatMap((body) => [...body.rows])
      // Right-align a header whose whole column holds numbers.
      table.querySelectorAll(':scope > thead th').forEach((th, i) => {
        if (rows.length && rows.every((row) => row.cells[i]?.classList.contains('num'))) th.classList.add('num')
      })
      for (const body of table.tBodies) {
        for (const row of body.rows) {
          let col = 0
          for (const cell of row.cells) {
            const label = heads[col]
            if (label && !cell.hasAttribute('data-label')) cell.setAttribute('data-label', label)
            col += cell.colSpan || 1
          }
        }
      }
    }
  }
  stack(document)
  if (window.__bunwriteResponsive) return
  window.__bunwriteResponsive = true
  document.addEventListener('htmx:afterSettle', (event) => stack(event.target instanceof Element ? event.target : document))
  document.addEventListener('keydown', (event) => {
    const toggle = document.getElementById('nav-toggle')
    if (event.key === 'Escape' && toggle instanceof HTMLInputElement) toggle.checked = false
  })
})()
`
