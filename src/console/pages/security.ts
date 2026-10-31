/** Account security: email MFA for the signed-in console admin. */
import type { ConsoleContext, ConsoleRouter } from '~/console/context'
import { checked, value } from '~/console/forms'
import { html } from '~/console/html'
import { settingsSection } from '~/console/ui'
import { organizationHeader } from '~/console/views/organization'

export const SECURITY = '/console/security'

/** The organization chrome, so Security sits beside Members and Settings instead of inside a project. */
function securityHeader(ctx: ConsoleContext) {
  const org = ctx.organizations.ensure(ctx.projects.control.config.orgId, ctx.projects.control.config.projectName)
  const members = ctx.organizations.members(org.id)
  return organizationHeader(
    org,
    { projects: ctx.projects.list().length, members: members.filter((member) => member.status === 'active').length },
    'security',
    ctx.organizations.roleOf(org.id, ctx.admin.email) === 'owner',
  )
}

function securityView(ctx: ConsoleContext) {
  const admin = ctx.auth.find(ctx.admin.email)!
  const smtp = ctx.projects.control.mailer.enabled
  return html`${securityHeader(ctx)}
    ${settingsSection(
      'Email MFA',
      'When this is on, signing in asks for a six-digit code sent to your admin email after the password. The code expires in 10 minutes and is single use.',
      html`<p style="margin:0 0 12px">Status: <span class="badge">${admin.mfa ? 'Email MFA on' : 'Password only'}</span></p>
        ${smtp
          ? html`<p class="hint" style="margin:0 0 12px">A working SMTP setup is required. If mail delivery stops, an operator can clear MFA with <code>bunwrite console:admin you@example.com --no-mfa</code>.</p>`
          : html`<p class="hint" style="margin:0 0 12px">SMTP is not configured. Configure it in <a href="/console/settings/general">Settings</a> before turning MFA on, or the emailed code cannot be sent.</p>`}
        <form method="post" action="${SECURITY}/mfa">
          <label class="check"><input type="checkbox" name="enabled" ${admin.mfa ? 'checked' : ''} ${smtp || admin.mfa ? '' : 'disabled'}>Require an emailed code at sign-in</label>
          <label>Current password<input type="password" name="password" autocomplete="current-password" required><small>Confirms the change.</small></label>
          <div class="foot"><button class="primary">Save</button></div>
        </form>`,
      { id: 'mfa' },
    )}`
}

export function securityPages(router: ConsoleRouter): void {
  router.get(SECURITY, ({ ctx }) => ctx.render('Security', 'security', securityView(ctx)))

  router.post(`${SECURITY}/mfa`, async ({ ctx }) => {
    const admin = ctx.auth.find(ctx.admin.email)
    if (!admin) return ctx.go('/console/login')
    if (!(await ctx.auth.verifyPassword(admin.seq, value(ctx.form, 'password')))) {
      return ctx.go(SECURITY, { tone: 'critical', text: 'That password is not correct.' })
    }
    const enabled = checked(ctx.form.enabled)
    if (enabled && !ctx.projects.control.mailer.enabled) {
      return ctx.go(SECURITY, { tone: 'critical', text: 'Configure SMTP before turning on email MFA; otherwise you would be locked out.' })
    }
    ctx.auth.setMfa(admin.seq, enabled)
    return ctx.go(SECURITY, {
      tone: 'success',
      text: enabled ? 'Email MFA is on. Sign-in now asks for an emailed code.' : 'Email MFA is off.',
    })
  })
}
