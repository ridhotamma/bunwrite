/**
 * The document events a project can raise, as checkboxes. The page reads the
 * schema and hands the catalog here, so this module only renders.
 */
import { html, type Html } from '~/console/html'
import { plural } from '~/console/ui'

export interface DatabaseChoice {
  id: string
  name: string
  collections: { id: string; name: string }[]
}

export interface EventChoice {
  value: string
  /** Short label: `Any change`, `Created`, ... */
  label: string
  /** The part that differs between the choices of a group, shown under the label. */
  short: string
}

export interface EventGroup {
  label: Html
  choices: EventChoice[]
  open?: boolean
}

const ACTIONS = ['create', 'update', 'delete'] as const

/** Any change plus one checkbox per document action, for a `databases.<db>.collections.<id>.documents` base. */
function choicesFor(base: string): EventChoice[] {
  return [
    { value: `${base}.*`, label: 'Any change', short: 'documents.*' },
    ...ACTIONS.map((action) => ({
      value: `${base}.*.${action}`,
      label: action === 'create' ? 'Created' : action === 'update' ? 'Updated' : 'Deleted',
      short: `documents.*.${action}`,
    })),
  ]
}

/**
 * Everything, each database and each collection. `*` matches any part, just as
 * it does in Appwrite, so the broad groups come first.
 */
export function eventGroups(databases: DatabaseChoice[]): EventGroup[] {
  const groups: EventGroup[] = [{ label: html`All databases and collections`, choices: choicesFor('databases.*.collections.*.documents'), open: true }]
  for (const database of databases) {
    groups.push({
      label: html`Database <span class="mono">${database.id}</span> <span class="subdued">${database.name}</span>`,
      choices: choicesFor(`databases.${database.id}.collections.*.documents`),
    })
    for (const collection of database.collections) {
      groups.push({
        label: html`<span class="mono">${database.id}/${collection.id}</span> <span class="subdued">${collection.name}</span>`,
        choices: choicesFor(`databases.${database.id}.collections.${collection.id}.documents`),
      })
    }
  }
  return groups
}

/** Checkboxes for the known events, plus a textarea for patterns the list cannot express. */
export function eventPicker(groups: EventGroup[], selected: Set<string>): Html {
  const known = new Set(groups.flatMap((group) => group.choices.map((choice) => choice.value)))
  const custom = [...selected].filter((event) => !known.has(event))
  return html`<p class="hint">Pick the document changes to receive. Appwrite sends one POST per change per matching event.</p>
    ${groups.map(
      (group) => html`<details class="disclosure" ${group.open ? html`open` : ''}>
        <summary>${group.label} <span class="subdued">${plural(group.choices.length, 'event')}</span></summary>
        <div class="event-grid">${group.choices.map(
          (choice) => html`<label class="check" title="${choice.value}"><input type="checkbox" name="events" value="${choice.value}" ${selected.has(choice.value) ? 'checked' : ''}>${choice.label}<small class="mono">${choice.short}</small></label>`,
        )}</div>
      </details>`,
    )}
    <label style="margin-top:16px">Other events<textarea name="customEvents" class="mono" rows="3" spellcheck="false" placeholder="databases.main.collections.notes.documents.*.update">${custom.join('\n')}</textarea><small>One per line, for patterns the list above does not cover. Comma-separated works too.</small></label>`
}
