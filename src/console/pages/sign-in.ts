import type { BootstrapInfo } from '~/config'
import type { ConsoleAuth } from '~/console/auth'
import { html, page } from '~/console/html'
import { bare } from '~/console/layout'
import { alert } from '~/console/ui'

export interface SignInOptions {
  setup?: boolean
  email?: string
  error?: string
  projectName: string
  instance?: Pick<BootstrapInfo, 'orgId' | 'projectId' | 'apiKey'>
}

/** The sign-in page, and the first-admin setup page when no admin exists. */
export function signInPage(auth: ConsoleAuth, options: SignInOptions): Response {
  const setup = options.setup ?? false
  const email = options.email ?? ''
  const error = options.error
  return page(
    bare(
      setup ? 'Create admin' : 'Sign in',
      html`<div class="auth">
        <div class="brand">${options.projectName} console</div>
        <div class="card">
          <h2>${setup ? 'Create the first admin' : 'Sign in'}</h2>
          ${setup ? html`<p class="hint">Only shown on this machine while no admin exists.</p>` : ''}
          ${error ? alert('critical', html`${error}`) : ''}
          <form method="post" action="${setup ? '/console/setup' : '/console/login'}">
            <label>Email<input type="email" name="email" value="${email}" autocomplete="username" required autofocus></label>
            <label>Password<input type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="8" required></label>
            <button class="primary" style="width:100%;justify-content:center">${setup ? 'Create admin' : 'Sign in'}</button>
          </form>
        </div>
        ${setup && options.instance
          ? html`<div class="card">
              <h2>Instance credentials</h2>
              <p class="hint">Generated on first start when not set in the environment, and stored in the database. Set <code>ORG_ID</code>, <code>PROJECT_ID</code>, <code>SECRET</code> or <code>API_KEYS</code> in the environment to override them.</p>
              <label>Organization ID<input class="mono" readonly value="${options.instance.orgId}"></label>
              <label>Project ID<input class="mono" readonly value="${options.instance.projectId}"></label>
              ${options.instance.apiKey
                ? html`<label>API key<input id="instance-api-key" class="mono" readonly autocomplete="off" spellcheck="false" value="${options.instance.apiKey}"><small>Copy it now; it is not shown after you create the admin.</small></label>
                  <button type="button" data-copy-target="#instance-api-key">Copy API key</button>`
                : html`<p class="hint" style="margin:0">Using <code>API_KEYS</code> from the environment.</p>`}
            </div>`
          : ''}
        ${!setup && auth.count() === 0 ? html`<p class="subdued" style="text-align:center">No admin yet. Run <code>bun run console:admin you@example.com</code> on the server.</p>` : ''}
      </div>`,
      options.projectName,
    ),
  )
}
