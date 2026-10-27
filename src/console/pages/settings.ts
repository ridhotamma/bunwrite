import { SmtpMailer } from '../../mail/mailer'
import { err } from '../../lib/errors'
import { go, type ConsoleContext, type ConsoleRouter } from '../app'
import { html, page, type Html } from '../html'
import { badge, destroy, header, when } from '../layout'
import type { SettingKey } from '../../settings/service'

const SETTINGS = '/console/settings'
const lines = (v: unknown) => String(v ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
const checked = (v: unknown) => v === 'on' || v === 'true'

function source(ctx: ConsoleContext, key: SettingKey): Html {
  return ctx.services.settings.overridden(key)
    ? html`${badge('Set here', 'info')} ${destroy(`${SETTINGS}/${key}/reset`, 'Use env value', 'Go back to the value from the server env?')}`
    : badge('From env')
}

function card(ctx: ConsoleContext, id: string, title: string, key: SettingKey | null, hint: string, body: Html): Html {
  return html`<div class="card" id="${id}"><div style="display:flex;gap:8px;align-items:center;margin-bottom:4px"><h2 style="margin:0">${title}</h2><span style="margin-left:auto;display:flex;gap:8px;align-items:center">${key ? source(ctx, key) : ''}</span></div>
    <p class="hint" style="margin:4px 0 12px">${hint}</p>${body}</div>`
}

export function settingsPages(router: ConsoleRouter): void {
  const view = (ctx: ConsoleContext, created?: string) => {
    const c = ctx.services.config
    const smtp = c.smtp
    const google = c.google
    const keys = ctx.services.settings.listKeys()
    const admins = ctx.auth.list()
    const fns = ctx.services.functions.list().filter((f) => f.schedule)
    return ctx.render(
      'Settings',
      'settings',
      html`${header('Settings')}
      ${created ? html`<div class="banner success"><b>Copy this key now.</b> It is not shown again.<pre style="margin-top:8px" class="mono">${created}</pre></div>` : ''}
      ${card(ctx, 'project', 'Project', 'project', 'Name in emails, allowed web origins and how long sign-ins last.', html`
        <form method="post" action="${SETTINGS}/project">
          <div class="fields"><label>Name<input name="projectName" value="${c.projectName}" required></label><label>Project ID<input value="${c.projectId}" class="mono" readonly><small>Set by PROJECT_ID; apps send it.</small></label></div>
          <label>Allowed origins<textarea name="allowedOrigins" class="mono">${c.allowedOrigins.join('\n')}</textarea><small>One per line. <code>*.pesanle.com</code> covers subdomains. Used for CORS and redirect links.</small></label>
          <div class="fields"><label>Session length (days)<input name="sessionDays" type="number" min="1" value="${Math.round(c.sessionDuration / 86400)}"></label><label>Sessions per user<input name="sessionsLimit" type="number" min="1" max="100" value="${c.sessionsLimit}"></label></div>
          <div class="foot"><button class="primary">Save</button></div>
        </form>`)}
      ${card(ctx, 'email', 'Email (SMTP)', 'smtp', 'Sends sign-in codes, password resets and team invitations.', html`
        <form method="post" action="${SETTINGS}/smtp">
          <div class="fields"><label>Host<input name="host" value="${smtp?.host ?? ''}" placeholder="smtp.example.com"></label><label>Port<input name="port" type="number" value="${smtp?.port ?? 587}"></label></div>
          <div class="fields"><label>Username<input name="user" value="${smtp?.user ?? ''}" autocomplete="off"></label><label>Password<input name="password" type="password" placeholder="${smtp?.password ? 'Unchanged' : ''}" autocomplete="new-password"></label></div>
          <div class="fields"><label>Sender email<input name="senderEmail" type="email" value="${smtp?.senderEmail ?? ''}"></label><label>Sender name<input name="senderName" value="${smtp?.senderName ?? ''}"></label></div>
          <label class="check"><input type="checkbox" name="secure" ${smtp?.secure ? 'checked' : ''}>Implicit TLS (port 465)</label>
          <div class="foot"><span id="smtp-test" class="subdued" style="margin-right:auto"></span>
            <button type="button" hx-post="${SETTINGS}/smtp/test" hx-target="#smtp-test" hx-swap="innerHTML" ${smtp ? '' : 'disabled'}>Send test email</button>
            ${smtp ? html`<button type="submit" name="disable" value="1" class="critical">Turn off</button>` : ''}<button class="primary">Save</button></div>
        </form>`)}
      ${card(ctx, 'google', 'Google sign-in', 'google', 'OAuth client from Google Cloud. Add the redirect URI below to it.', html`
        <form method="post" action="${SETTINGS}/google">
          <label>Redirect URI<input class="mono" readonly value="${c.publicEndpoint}/account/sessions/oauth2/callback/google/${c.projectId}"></label>
          <div class="fields"><label>Client ID<input name="clientId" value="${google?.clientId ?? ''}" class="mono"></label><label>Client secret<input name="clientSecret" type="password" placeholder="${google?.clientSecret ? 'Unchanged' : ''}" autocomplete="new-password"></label></div>
          <div class="foot">${google ? html`<button type="submit" name="disable" value="1" class="critical">Turn off</button>` : ''}<button class="primary">Save</button></div>
        </form>`)}
      ${card(ctx, 'keys', 'API keys', null, 'Server keys with full access. Keys from the API_KEYS env var also work and are not listed.', html`
        ${keys.length
          ? html`<div class="scroll"><table><thead><tr><th>Name</th><th class="hide-sm">Key</th><th>Last used</th><th class="hide-sm">Expires</th><th></th></tr></thead><tbody>
            ${keys.map((k) => html`<tr><td>${k.name}</td><td class="mono hide-sm">${k.hint}…</td><td>${when(k.accessed_at)}</td><td class="hide-sm">${k.expire ? when(k.expire) : 'Never'}</td>
              <td class="num">${destroy(`${SETTINGS}/keys/${k.id}/delete`, 'Revoke', `Revoke ${k.name}? Apps using it stop working.`)}</td></tr>`)}</tbody></table></div>`
          : ''}
        <form method="post" action="${SETTINGS}/keys" style="margin-top:12px" hx-push-url="false"><div class="fields"><label>Name<input name="name" required placeholder="Dashboard server"></label><label>Expires<input name="expire" type="date"><small>Optional.</small></label></div>
          <div class="foot"><button>Create key</button></div></form>`)}
      ${card(ctx, 'schedules', 'Function schedules', 'functions', 'Paused schedules do not fire. Running a function by hand still works.', html`
        <form method="post" action="${SETTINGS}/functions">
          ${fns.length ? fns.map((f) => html`<label class="check"><input type="checkbox" name="paused" value="${f.id}" ${c.skipSchedules.includes(f.id) ? 'checked' : ''}>Pause <span class="mono">${f.id}</span>&nbsp;<span class="subdued">${f.schedule}</span></label>`) : html`<p class="subdued">No scheduled functions.</p>`}
          <div class="foot"><button>Save</button></div>
        </form>`)}
      ${card(ctx, 'admins', 'Console admins', null, 'People who can sign in here. Separate from your app users.', html`
        <ul class="list">${admins.map((a) => html`<li><span>${a.email}${a.seq === ctx.admin.seq ? html` ${badge('You')}` : ''}</span><span>${admins.length > 1 ? destroy(`${SETTINGS}/admins/${a.seq}/delete`, 'Remove', `Remove ${a.email}?`) : ''}</span></li>`)}</ul>
        <form method="post" action="${SETTINGS}/admins" style="margin-top:12px"><div class="fields"><label>Email<input name="email" type="email" required></label><label>Password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label></div>
          <div class="foot"><button>Add admin</button></div></form>`)}`,
    )
  }

  router.get(SETTINGS, ({ ctx }) => view(ctx))

  router.post(`${SETTINGS}/project`, ({ ctx, request }) => {
    const f = ctx.form
    const days = Number(f.sessionDays)
    const limit = Number(f.sessionsLimit)
    if (!(days >= 1) || !(limit >= 1 && limit <= 100)) throw err('general_argument_invalid', 'Session length and sessions per user must be positive.')
    ctx.services.settings.set('project', {
      projectName: String(f.projectName ?? '').trim() || ctx.services.config.projectName,
      allowedOrigins: lines(f.allowedOrigins),
      sessionDuration: Math.round(days * 86400),
      sessionsLimit: Math.round(limit),
    })
    return go(request, `${SETTINGS}#project`, { tone: 'success', text: 'Project settings saved' })
  })

  router.post(`${SETTINGS}/smtp`, ({ ctx, request }) => {
    const f = ctx.form
    if (f.disable) {
      ctx.services.settings.set('smtp', { disabled: true })
      return go(request, `${SETTINGS}#email`, { tone: 'success', text: 'Email turned off' })
    }
    const host = String(f.host ?? '').trim()
    if (!host) throw err('general_argument_invalid', 'Enter the SMTP host.')
    ctx.services.settings.set('smtp', {
      host,
      port: Number(f.port || 587),
      user: String(f.user ?? '').trim() || undefined,
      password: String(f.password ?? '') || ctx.services.config.smtp?.password,
      secure: checked(f.secure),
      senderEmail: String(f.senderEmail ?? '').trim() || 'no-reply@pesanle.com',
      senderName: String(f.senderName ?? '').trim() || `${ctx.services.config.projectName} Team`,
    })
    return go(request, `${SETTINGS}#email`, { tone: 'success', text: 'Email settings saved' })
  })

  // Answers with a fragment for the inline result next to the button.
  router.post(`${SETTINGS}/smtp/test`, async ({ ctx }) => {
    const smtp = ctx.services.config.smtp
    if (!smtp) return page(html`<span style="color:var(--critical)">Save SMTP settings first.</span>`)
    try {
      await new SmtpMailer(smtp).send({
        to: ctx.admin.email,
        subject: `${ctx.services.config.projectName}: test email`,
        text: 'SMTP works. This message was sent from the console.',
        html: '<p>SMTP works. This message was sent from the console.</p>',
      })
      return page(html`<span style="color:var(--success)">Sent to ${ctx.admin.email}</span>`)
    } catch (error) {
      return page(html`<span style="color:var(--critical)">${error instanceof Error ? error.message : String(error)}</span>`)
    }
  })

  router.post(`${SETTINGS}/google`, ({ ctx, request }) => {
    const f = ctx.form
    if (f.disable) {
      ctx.services.settings.set('google', { disabled: true })
      return go(request, `${SETTINGS}#google`, { tone: 'success', text: 'Google sign-in turned off' })
    }
    const clientId = String(f.clientId ?? '').trim()
    const clientSecret = String(f.clientSecret ?? '') || ctx.services.config.google?.clientSecret || ''
    if (!clientId || !clientSecret) throw err('general_argument_invalid', 'Enter both the client ID and secret.')
    ctx.services.settings.set('google', { clientId, clientSecret })
    return go(request, `${SETTINGS}#google`, { tone: 'success', text: 'Google sign-in saved' })
  })

  router.post(`${SETTINGS}/functions`, ({ ctx, request }) => {
    ctx.services.settings.set('functions', { skipSchedules: ([] as unknown[]).concat(ctx.form.paused ?? []).map(String) })
    return go(request, `${SETTINGS}#schedules`, { tone: 'success', text: 'Schedules saved' })
  })

  router.post(`${SETTINGS}/:key/reset`, ({ ctx, path, request }) => {
    const key = path.key as SettingKey
    if (!['project', 'smtp', 'google', 'functions'].includes(key)) throw err('general_argument_invalid', 'Unknown setting.')
    ctx.services.settings.reset(key)
    return go(request, SETTINGS, { tone: 'success', text: 'Back to the env value' })
  })

  router.post(`${SETTINGS}/keys`, ({ ctx, request }) => {
    const expire = String(ctx.form.expire ?? '').trim()
    const { secret } = ctx.services.settings.createKey(String(ctx.form.name ?? ''), expire ? `${expire}T23:59:59.999+00:00` : null)
    // Shown once in this response; never put in a URL, where history would keep it.
    void request
    return view(ctx, secret)
  })

  router.post(`${SETTINGS}/keys/:id/delete`, ({ ctx, path, request }) => {
    ctx.services.settings.deleteKey(path.id!)
    return go(request, `${SETTINGS}#keys`, { tone: 'success', text: 'Key revoked' })
  })

  router.post(`${SETTINGS}/admins`, async ({ ctx, request }) => {
    await ctx.auth.upsert(String(ctx.form.email ?? ''), String(ctx.form.password ?? ''))
    return go(request, `${SETTINGS}#admins`, { tone: 'success', text: 'Admin saved' })
  })

  router.post(`${SETTINGS}/admins/:seq/delete`, ({ ctx, path, request }) => {
    ctx.auth.remove(Number(path.seq))
    return go(request, `${SETTINGS}#admins`, { tone: 'success', text: 'Admin removed' })
  })
}
