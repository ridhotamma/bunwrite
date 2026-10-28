import { describe, expect, test } from 'bun:test'

import { COMBOBOX_SCRIPT } from '~/console/combobox'
import { FORM_SCRIPT } from '~/console/form-script'
import { html } from '~/console/html'
import { bare, projectShell } from '~/console/layout'
import { PROGRESS_SCRIPT } from '~/console/progress'
import { CONSOLE_CSS } from '~/console/styles'

describe('console loading state', () => {
  test('every shell loads the progress bar and submit-once scripts', () => {
    const pages = [
      String(bare('Sign in', html`<form method="post" action="/console/login"><button>Sign in</button></form>`)),
      String(projectShell('Projects', { admin: 'admin@example.com' }, html`<p>hi</p>`)),
    ]
    for (const page of pages) {
      expect(page).toContain('__bunwriteProgress')
      expect(page).toContain('__bunwriteForms')
      expect(page).toContain('.nav-progress{')
    }
  })

  test('POST forms are guarded by default; GET forms and data-busy="off" are not', () => {
    expect(FORM_SCRIPT).toContain('toLowerCase() === "post" && form.dataset.busy !== "off"')
    // A field named "id" must not hide the form's id from the button lookup.
    expect(FORM_SCRIPT).toContain('form.getAttribute("id")')
    expect(FORM_SCRIPT).not.toMatch(/CSS\.escape\(form\.id\)/)
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
