import type { BootstrapInfo } from '~/config'
import type { ConsoleAuth } from '~/console/auth'
import { html, page } from '~/console/html'
import { bare } from '~/console/layout'
import { alert } from '~/console/ui'

export interface SignInOptions {
  setup?: boolean
  email?: string
  error?: string
  /** A pending email MFA sign-in; renders the code form instead of the password form. */
  mfaChallenge?: string
  notice?: string
  projectName: string
  instance?: Pick<BootstrapInfo, 'orgId' | 'projectId' | 'apiKey'>
}

/** The sign-in page, the email-code step, and the first-admin setup page when no admin exists. */
export async function signInPage(auth: ConsoleAuth, options: SignInOptions): Promise<Response> {
  const setup = options.setup ?? false
  const email = options.email ?? ''
  const error = options.error
  const mfa = options.mfaChallenge
  return page(
    bare(
      setup ? 'Create admin' : mfa ? 'Verify sign-in' : 'Sign in',
      html`<div class="auth">
        <div class="brand"><img src="/images/logo-dark.png" alt="" width="28" height="28" /><span>${options.projectName} console</span></div>
        <div class="card">
          <h2>${setup ? 'Create the first admin' : mfa ? 'Check your email' : 'Sign in'}</h2>
          ${setup ? html`<p class="hint">Only shown on this machine while no admin exists.</p>` : ''}
          ${options.notice ? html`<p class="hint">${options.notice}</p>` : ''} ${error ? alert('critical', html`${error}`) : ''}
          ${
            mfa
              ? html`<form method="post" action="/console/login/mfa">
                    <input type="hidden" name="challenge" value="${mfa}" />
                    <label
                      >Email code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus
                    /></label>
                    <button class="primary" style="width:100%;justify-content:center">Verify and sign in</button>
                  </form>
                  <p class="hint" style="margin:12px 0 0"><a href="/console/login">Start over</a></p>`
              : html`<form method="post" action="${setup ? '/console/setup' : '/console/login'}">
                  <label>Email<input type="email" name="email" value="${email}" autocomplete="username" required autofocus /></label>
                  <label
                    >Password<input type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="8" required
                  /></label>
                  <button class="primary" style="width:100%;justify-content:center">${setup ? 'Create admin' : 'Sign in'}</button>
                </form>`
          }
        </div>
        ${
          setup && options.instance
            ? html`<div class="card">
                <h2>Instance credentials</h2>
                <p class="hint">Generated on first start and stored in the database. Manage the project and its keys from the console after setup.</p>
                <label>Organization ID<input class="mono" readonly value="${options.instance.orgId}" /></label>
                <label>Project ID<input class="mono" readonly value="${options.instance.projectId}" /></label>
                ${
                  options.instance.apiKey
                    ? html`<label
                          >Bootstrap API key<input
                            id="instance-api-key"
                            class="mono"
                            readonly
                            autocomplete="off"
                            spellcheck="false"
                            value="${options.instance.apiKey}"
                          /><small>Shown once. It is revoked when you create the admin; create a project API key in Console → API after signing in.</small></label
                        >
                        <button type="button" data-copy-target="#instance-api-key">Copy API key</button>`
                    : html`<p class="hint" style="margin:0">API keys are managed on the API page.</p>`
                }
              </div>`
            : ''
        }
        ${!setup && (await auth.count()) === 0 ? html`<p class="subdued" style="text-align:center">No admin yet. Run <code>bun run console:admin you@example.com</code> on the server.</p>` : ''}
      </div>`,
      options.projectName,
    ),
  )
}
