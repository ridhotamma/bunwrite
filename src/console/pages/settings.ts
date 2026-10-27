import { existsSync } from 'node:fs'

import { err } from '../../lib/errors'
import { SmtpMailer } from '../../mail/mailer'
import type { SettingKey } from '../../settings/service'
import type { ConsoleContext, ConsoleRouter } from '../context'
import { arrayOf, checked, lines, value } from '../forms'
import { html, page, type Html } from '../html'
import { badge, destroy, header, when } from '../ui'

const SETTINGS = '/console/settings'

function codeFound(ctx: ConsoleContext): Html {
  const fns = ctx.services.functions.list()
  if (!fns.length) return html``
  const found = fns.filter((f) => ctx.services.functions.codeDir(f).dir).length
  return found === fns.length ? html`Code found for all ${found} functions.` : html`<b style="color:var(--critical)">Code found for ${found} of ${fns.length} functions.</b>`
}

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
      ${card(ctx, 'schedules', 'Functions', 'functions', 'Where function code lives, and which schedules are paused.', html`
        <form method="post" action="${SETTINGS}/functions">
          <label>Code folder<input name="functionsDir" class="mono" value="${c.functionsDir}"><small>The folder with appwrite.config.json; function paths are read from it. ${codeFound(ctx)}</small></label>
          <div class="subdued" style="margin:4px 0 8px">Paused schedules do not fire. Running a function by hand still works.</div>
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

  router.post(`${SETTINGS}/project`, ({ ctx }) => {
    const f = ctx.form
    const days = Number(f.sessionDays)
    const limit = Number(f.sessionsLimit)
    if (!(days >= 1) || !(limit >= 1 && limit <= 100)) throw err('general_argument_invalid', 'Session length and sessions per user must be positive.')
    ctx.services.settings.set('project', {
      projectName: value(f, 'projectName') || ctx.services.config.projectName,
      allowedOrigins: lines(f.allowedOrigins),
      sessionDuration: Math.round(days * 86400),
      sessionsLimit: Math.round(limit),
    })
    return ctx.go(`${SETTINGS}#project`, { tone: 'success', text: 'Project settings saved' })
  })

  router.post(`${SETTINGS}/smtp`, ({ ctx }) => {
    const f = ctx.form
    if (f.disable) {
      ctx.services.settings.set('smtp', { disabled: true })
      return ctx.go(`${SETTINGS}#email`, { tone: 'success', text: 'Email turned off' })
    }
    const host = value(f, 'host')
    if (!host) throw err('general_argument_invalid', 'Enter the SMTP host.')
    ctx.services.settings.set('smtp', {
      host,
      port: Number(f.port || 587),
      user: value(f, 'user') || undefined,
      password: String(f.password ?? '') || ctx.services.config.smtp?.password,
      secure: checked(f.secure),
      senderEmail: value(f, 'senderEmail') || 'no-reply@pesanle.com',
      senderName: value(f, 'senderName') || `${ctx.services.config.projectName} Team`,
    })
    return ctx.go(`${SETTINGS}#email`, { tone: 'success', text: 'Email settings saved' })
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

  router.post(`${SETTINGS}/google`, ({ ctx }) => {
    const f = ctx.form
    if (f.disable) {
      ctx.services.settings.set('google', { disabled: true })
      return ctx.go(`${SETTINGS}#google`, { tone: 'success', text: 'Google sign-in turned off' })
    }
    const clientId = value(f, 'clientId')
    const clientSecret = String(f.clientSecret ?? '') || ctx.services.config.google?.clientSecret || ''
    if (!clientId || !clientSecret) throw err('general_argument_invalid', 'Enter both the client ID and secret.')
    ctx.services.settings.set('google', { clientId, clientSecret })
    return ctx.go(`${SETTINGS}#google`, { tone: 'success', text: 'Google sign-in saved' })
  })

  router.post(`${SETTINGS}/functions`, ({ ctx }) => {
    const functionsDir = value(ctx.form, 'functionsDir')
    if (functionsDir && !existsSync(functionsDir)) throw err('general_argument_invalid', `No folder at ${functionsDir}.`)
    ctx.services.settings.set('functions', { skipSchedules: arrayOf(ctx.form.paused), functionsDir: functionsDir || undefined })
    return ctx.go(`${SETTINGS}#schedules`, { tone: 'success', text: 'Schedules saved' })
  })

  router.post(`${SETTINGS}/:key/reset`, ({ ctx, path }) => {
    const key = path.key as SettingKey
    if (!['project', 'smtp', 'google', 'functions'].includes(key)) throw err('general_argument_invalid', 'Unknown setting.')
    ctx.services.settings.reset(key)
    return ctx.go(SETTINGS, { tone: 'success', text: 'Back to the env value' })
  })

  router.post(`${SETTINGS}/keys`, ({ ctx }) => {
    const expire = value(ctx.form, 'expire')
    const { secret } = ctx.services.settings.createKey(value(ctx.form, 'name'), expire ? `${expire}T23:59:59.999+00:00` : null)
    // Shown once in this response; never put in a URL, where history would keep it.
    return view(ctx, secret)
  })

  router.post(`${SETTINGS}/keys/:id/delete`, ({ ctx, path }) => {
    ctx.services.settings.deleteKey(path.id!)
    return ctx.go(`${SETTINGS}#keys`, { tone: 'success', text: 'Key revoked' })
  })

  router.post(`${SETTINGS}/admins`, async ({ ctx }) => {
    await ctx.auth.upsert(String(ctx.form.email ?? ''), String(ctx.form.password ?? ''))
    return ctx.go(`${SETTINGS}#admins`, { tone: 'success', text: 'Admin saved' })
  })

  router.post(`${SETTINGS}/admins/:seq/delete`, ({ ctx, path }) => {
    ctx.auth.remove(Number(path.seq))
    return ctx.go(`${SETTINGS}#admins`, { tone: 'success', text: 'Admin removed' })
  })
}
