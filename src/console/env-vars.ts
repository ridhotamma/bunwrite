import { EnvParseError, parseEnvVariables, type EnvVariable } from '~/functions/env'
import type { ConsoleContext } from './context'
import { dialog } from './dialog'
import { checked } from './forms'
import { html, page, type Html } from './html'
import { isHtmx } from './htmx'
import { alert } from './ui'

export function envBulkDialog(options: { id: string; title: string; action: string }): Html {
  const { id, title, action } = options
  const formId = `${id}-form`
  return dialog({
    id,
    title,
    body: html`<form id="${formId}" method="post" action="${action}" hx-post="${action}" hx-target="#${id}-error" hx-swap="innerHTML">
      <label style="margin-bottom:12px">Variables<textarea name="env" class="mono" rows="10" style="min-height:220px" spellcheck="false" autocomplete="off" required placeholder="${'KEY=value\nANOTHER_KEY=value'}"></textarea><small>One KEY=value per line. Blank lines and lines starting with # are ignored; quotes are stripped from fully quoted values.</small></label>
      <div id="${id}-error"></div>
      <label class="check"><input type="checkbox" name="secret" checked>Hide values</label>
    </form>`,
    actions: html`<button type="button" data-dialog-close>Cancel</button><button type="submit" form="${formId}" class="primary">Import</button>`,
  })
}

export function importEnvVariables(
  ctx: ConsoleContext,
  save: (vars: EnvVariable[], secret: boolean) => void,
  redirect: string,
): Response {
  let vars: EnvVariable[]
  try {
    vars = parseEnvVariables(String(ctx.form.env ?? ''))
  } catch (error) {
    const issues = error instanceof EnvParseError ? error.issues : [error instanceof Error ? error.message : String(error)]
    if (isHtmx(ctx.request)) {
      return page(html`${alert('critical', html`${issues.map((issue) => html`<div>${issue}</div>`)}`, { style: 'margin:0 0 4px' })}`)
    }
    return ctx.back({ tone: 'critical', text: issues.join(' ') })
  }
  save(vars, checked(ctx.form.secret))
  return ctx.go(redirect, { tone: 'success', text: `Imported ${vars.length} variable${vars.length === 1 ? '' : 's'}` })
}
