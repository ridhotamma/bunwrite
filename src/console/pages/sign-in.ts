import type { ConsoleAuth } from '../auth'
import { html, page } from '../html'
import { bare } from '../layout'

export interface SignInOptions {
  setup?: boolean
  error?: string
}

/** The sign-in page, and the first-admin setup page when no admin exists. */
export function signInPage(auth: ConsoleAuth, options: SignInOptions = {}): Response {
  const setup = options.setup ?? false
  const error = options.error
  return page(
    bare(
      setup ? 'Create admin' : 'Sign in',
      html`<div class="auth">
        <div class="brand">Pesanle console</div>
        <div class="card">
          <h2>${setup ? 'Create the first admin' : 'Sign in'}</h2>
          ${setup ? html`<p class="hint">Only shown on this machine while no admin exists.</p>` : ''}
          ${error ? html`<div class="banner critical">${error}</div>` : ''}
          <form method="post" action="${setup ? '/console/setup' : '/console/login'}">
            <label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
            <label>Password<input type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="8" required></label>
            <button class="primary" style="width:100%;justify-content:center">${setup ? 'Create admin' : 'Sign in'}</button>
          </form>
        </div>
        ${!setup && auth.count() === 0 ? html`<p class="subdued" style="text-align:center">No admin yet. Run <code>bun run console:admin you@example.com</code> on the server.</p>` : ''}
      </div>`,
    ),
    error ? 401 : 200,
  )
}
