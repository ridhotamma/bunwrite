import { describe, expect, test } from 'bun:test'

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
})
