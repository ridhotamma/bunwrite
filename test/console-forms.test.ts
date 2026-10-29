import { describe, expect, test } from 'bun:test'

import { COMBOBOX_SCRIPT } from '~/console/combobox'
import { FORM_SCRIPT } from '~/console/form-script'
import { FORM_STATE_SCRIPT } from '~/console/form-state'
import { html } from '~/console/html'
import { bare, projectShell, shell } from '~/console/layout'
import { PROGRESS_SCRIPT } from '~/console/progress'
import { CONSOLE_CSS } from '~/console/styles'

describe('console loading state', () => {
  test('every shell loads the progress bar, form-state and submit-once scripts', () => {
    const pages = [
      String(bare('Sign in', html`<form method="post" action="/console/login"><button>Sign in</button></form>`)),
      String(projectShell('Projects', { admin: 'admin@example.com' }, html`<p>hi</p>`)),
      String(
        shell(
          'Home',
          { section: 'overview', admin: 'admin@example.com', projectName: 'Demo', orgName: 'Demo', projects: [{ id: 'demo', name: 'Demo' }], currentProject: 'demo' },
          html`<p>hi</p>`,
        ),
      ),
    ]
    for (const page of pages) {
      expect(page).toContain('__bunwriteProgress')
      expect(page).toContain('__bunwriteFormState')
      expect(page).toContain('__bunwriteForms')
      expect(page).toContain('.nav-progress{')
    }
  })

  test('POST forms are guarded by default; GET forms and data-busy="off" are not', () => {
    expect(FORM_SCRIPT).toContain('(form.getAttribute("method") || "").toLowerCase() === "post"')
    expect(FORM_SCRIPT).toContain('form.dataset.busy !== "off"')
    // A field named "id" must not hide the form's id from the button lookup.
    expect(FORM_SCRIPT).toContain('form.getAttribute("id")')
    expect(FORM_SCRIPT).not.toMatch(/CSS\.escape\(form\.id\)/)
  })

  test('the busy state covers htmx forms and their own buttons, and keeps disabled buttons disabled', () => {
    // A form sends with an htmx verb even when it has no method="post".
    expect(FORM_SCRIPT).toContain('VERBS.some((name) => form.hasAttribute(name))')
    // A standalone button (test email, template preview) shows the same spinner.
    expect(FORM_SCRIPT).toContain('__busyElement')
    // Releasing the buttons must not enable one the server rendered disabled.
    expect(FORM_SCRIPT).toContain('button.__idleDisabled === undefined')
    expect(FORM_SCRIPT).toContain('button.disabled = Boolean(button.__idleDisabled)')
  })

  test('an error page tells the form-state script to put the values back', () => {
    // The redirect carries the message in `err`; the flash script marks <html>
    // before it cleans the URL, because the form-state script runs later.
    const page = String(
      shell(
        'Sites',
        { section: 'sites', admin: 'admin@example.com', projectName: 'Demo', orgName: 'Demo', projects: [{ id: 'demo', name: 'Demo' }], currentProject: 'demo' },
        html`<p>hi</p>`,
        { tone: 'critical', text: 'A site with this name or ID already exists.' },
      ),
    )
    expect(page).toContain("u.searchParams.has('err')")
    expect(page).toContain("document.documentElement.dataset.formError='1'")
    expect(page).toContain('__bunwriteFormState')

    // Passwords and files cannot (or should not) be restored; the rest is.
    expect(FORM_STATE_SCRIPT).toContain('el.type !== "password" && el.type !== "file"')
    expect(FORM_STATE_SCRIPT).toContain('root.dataset.formError === "1"')
    expect(FORM_STATE_SCRIPT).toContain('document.addEventListener("htmx:afterSwap", restore)')
  })

  test('the bar starts on send, so a cancelled request cannot leave it running', () => {
    expect(PROGRESS_SCRIPT).toContain('"htmx:beforeSend"')
    expect(PROGRESS_SCRIPT).not.toContain('"htmx:beforeRequest"')
    expect(CONSOLE_CSS).toContain('button[aria-busy="true"]::before')
  })

  test('long selects become filterable comboboxes that still submit their value', () => {
    // The select stays in the form and keeps its htmx attributes; the input is
    // only the visible part, and a pick is dispatched as a normal change event.
    const page = String(projectShell('Projects', { admin: 'admin@example.com' }, html`<p>hi</p>`))
    expect(page).toContain('__bunwriteCombobox')
    expect(COMBOBOX_SCRIPT).toContain('dispatchEvent(new Event("change", { bubbles: true }))')
    expect(COMBOBOX_SCRIPT).toContain('select.dataset.comboboxReady')
    expect(COMBOBOX_SCRIPT).toContain('"htmx:afterSwap"')
    // Pinned to the viewport and re-anchored on scroll and every frame while
    // open, so it stays under the field even when the layout moves it.
    expect(COMBOBOX_SCRIPT).toContain('addEventListener("scroll", reposition')
    expect(COMBOBOX_SCRIPT).toContain('requestAnimationFrame(track)')
    expect(CONSOLE_CSS).toContain('.combobox-list{position:fixed')
    expect(CONSOLE_CSS).toContain('.combobox-list.is-open{')
    expect(CONSOLE_CSS).toContain('.combobox-native{')
  })

  test('a followed select re-runs the conditional blocks it controls', () => {
    // Choosing an SSR framework sets the adapter select, which must show the SSR fields.
    expect(FORM_SCRIPT).toContain('if (toggled) { showFor(form); disableWhen(form) }')
    expect(CONSOLE_CSS).toContain('dialog.dialog-wide')
  })
})
