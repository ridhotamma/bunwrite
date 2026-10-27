/** Small server-rendered SVG line chart for the overview. */
import { html, type Html } from './html'
import { formatBytes } from './ui'

export interface ChartSeries {
  label: string
  color: string
  values: number[]
}

export interface LineChartOptions {
  labels: string[]
  series: ChartSeries[]
  width?: number
  height?: number
}

export function lineChart({ labels, series, width = 720, height = 240 }: LineChartOptions): Html {
  const pad = { top: 16, right: 12, bottom: 28, left: 58 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const max = Math.max(1, ...series.flatMap((s) => s.values))
  const x = (index: number) => (labels.length <= 1 ? pad.left + innerW / 2 : pad.left + (index / (labels.length - 1)) * innerW)
  const y = (value: number) => pad.top + innerH - (value / max) * innerH
  const baseline = pad.top + innerH
  const steps = Math.max(1, Math.ceil((labels.length - 1) / 5))
  const labelIndexes = new Set<number>([0, labels.length - 1])
  for (let i = 0; i < labels.length; i += steps) labelIndexes.add(i)

  const grid = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
    html`<line x1="${pad.left}" y1="${y(max * fraction)}" x2="${width - pad.right}" y2="${y(max * fraction)}" stroke="#ececec" stroke-width="1"/>`,
  )

  const clampY = (value: number) => Math.max(pad.top, Math.min(baseline, value))
  const smooth = (points: { x: number; y: number }[]) => {
    if (!points.length) return ''
    if (points.length === 1) return `M ${points[0]!.x.toFixed(1)},${points[0]!.y.toFixed(1)}`
    let path = `M ${points[0]!.x.toFixed(1)},${points[0]!.y.toFixed(1)}`
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] ?? points[i]!
      const p1 = points[i]!
      const p2 = points[i + 1]!
      const p3 = points[i + 2] ?? p2
      const c1x = p1.x + (p2.x - p0.x) / 6
      const c1y = clampY(p1.y + (p2.y - p0.y) / 6)
      const c2x = p2.x - (p3.x - p1.x) / 6
      const c2y = clampY(p2.y - (p3.y - p1.y) / 6)
      path += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
    }
    return path
  }

  const lines = series.map((item) => {
    const points = item.values.map((value, index) => ({ x: x(index), y: y(value) }))
    const line = smooth(points)
    const area = points.length ? `${line} L ${points.at(-1)!.x.toFixed(1)},${baseline} L ${points[0]!.x.toFixed(1)},${baseline} Z` : ''
    return html`
      <path d="${area}" fill="${item.color}" opacity=".08" pointer-events="none"/>
      <path d="${line}" fill="none" stroke="${item.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" pointer-events="none"/>
      ${item.values.map((value, index) => (value > 0 ? html`<circle cx="${x(index)}" cy="${y(value)}" r="2.5" fill="${item.color}" pointer-events="none"><title>${labels[index]} · ${formatBytes(value)}</title></circle>` : ''))}
    `
  })

  const data = {
    width,
    height,
    pad,
    labels,
    series: series.map((item) => ({ label: item.label, color: item.color, values: item.values })),
  }

  return html`<div class="chart" data-chart="${JSON.stringify(data)}">
    <div class="chart-legend">${series.map((item) => html`<span class="chart-key"><span class="chart-dot" style="background:${item.color}"></span>${item.label}</span>`)}</div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Bandwidth over time">
      ${grid}
      <rect x="${pad.left}" y="${pad.top}" width="${innerW}" height="${innerH}" fill="none" pointer-events="all"/>
      ${[0, 0.5, 1].map((fraction) => html`<text x="${pad.left - 8}" y="${y(max * fraction) + 4}" text-anchor="end" font-size="11" fill="#616161">${formatBytes(max * fraction)}</text>`)}
      ${[...labelIndexes]
        .sort((a, b) => a - b)
        .map((index) => {
          const anchor = index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'
          return html`<text x="${x(index)}" y="${height - 8}" text-anchor="${anchor}" font-size="11" fill="#616161">${labels[index]}</text>`
        })}
      ${lines}
      <line data-chart-cursor x1="0" y1="${pad.top}" x2="0" y2="${height - pad.bottom}" stroke="#8a8a8a" stroke-width="1" stroke-dasharray="3 3" visibility="hidden" pointer-events="none"/>
      ${series.map((item, index) => html`<circle data-chart-cursor-dot="${index}" r="4" fill="${item.color}" stroke="#fff" stroke-width="1.5" visibility="hidden" pointer-events="none"/>`)}
    </svg>
    <div class="chart-tooltip" data-chart-tooltip hidden><div class="chart-tooltip-time" data-chart-time></div><div data-chart-rows></div></div>
  </div>`
}
