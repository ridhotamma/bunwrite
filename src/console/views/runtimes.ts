/** The runtime picker, shared by sites and functions. */
import { html, type Html } from '~/console/html'
import type { RuntimeOption } from '~/runtimes/catalog'

const GROUPS: [RuntimeOption['kind'], string][] = [
  ['node', 'Node.js'],
  ['bun', 'Bun'],
  ['python', 'Python'],
]

/** A select of runtimes grouped by kind; `attrs` go on the select (for data-follow and similar). */
export function runtimeSelect(name: string, current: string, options: RuntimeOption[], hint: Html | string, attrs: Html = html``): Html {
  return html`<label>Runtime<select name="${name}" ${attrs}>
      ${GROUPS.filter(([kind]) => options.some((o) => o.kind === kind)).map(
        ([kind, label]) => html`<optgroup label="${label}">${options
          .filter((o) => o.kind === kind)
          .map((o) => html`<option value="${o.id}" ${o.id === current ? 'selected' : ''}>${o.label}${o.note ? ` — ${o.note}` : ''}</option>`)}</optgroup>`,
      )}
    </select><small>${hint}</small></label>`
}
