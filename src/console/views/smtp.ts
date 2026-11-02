/** Shared SMTP form used by project email settings and organization email delivery. */
import type { SmtpConfig } from '~/config'
import { html, type Html } from '~/console/html'

export interface SmtpFormOptions {
  action: string
  testAction: string
  smtp: SmtpConfig | null
  /** Address the test email goes to, usually the signed-in admin. */
  recipient: string
}

export function smtpForm({ action, testAction, smtp, recipient }: SmtpFormOptions): Html {
  return html`<form method="post" action="${action}">
    <div class="fields">
      <label>Host<input name="host" value="${smtp?.host ?? ''}" placeholder="smtp.example.com" /></label
      ><label>Port<input name="port" type="number" value="${smtp?.port ?? 587}" /></label>
    </div>
    <div class="fields">
      <label>Username<input name="user" value="${smtp?.user ?? ''}" autocomplete="off" /></label
      ><label>Password<input name="password" type="password" placeholder="${smtp?.password ? 'Unchanged' : ''}" autocomplete="new-password" /></label>
    </div>
    <div class="fields">
      <label>Sender email<input name="senderEmail" type="email" value="${smtp?.senderEmail ?? ''}" /></label
      ><label>Sender name<input name="senderName" value="${smtp?.senderName ?? ''}" /></label>
    </div>
    <label class="check"><input type="checkbox" name="secure" ${smtp?.secure ? 'checked' : ''} />Implicit TLS (port 465)</label>
    <div class="foot">
      ${smtp
        ? html`<span id="smtp-test" class="subdued" style="margin-right:auto">Sends to ${recipient}</span>
          <button type="button" hx-post="${testAction}" hx-target="#smtp-test" hx-swap="innerHTML" title="Send a test email to ${recipient}">Send test email</button>`
        : ''}
      ${smtp ? html`<button type="submit" name="disable" value="1" class="critical">Turn off</button>` : ''}<button class="primary">Save</button>
    </div>
  </form>`
}
