/** What `bunwrite env push` would change: the .env files against the project's variables. */
import type { EnvFile, EnvValue } from './envfiles'

/** A project variable as the API returns it; a secret's value is always empty. */
export interface Variable {
  $id: string
  key: string
  value: string
  secret: boolean
}

export interface Plan {
  create: { key: string; value: string; secret: boolean }[]
  update: { variable: Variable; value: string; secret: boolean; becomesSecret: boolean }[]
  /** Secrets with a local value: the server's cannot be read to compare, so they are sent again. */
  resend: { variable: Variable; value: string }[]
  /** On the server but in no file. */
  remove: Variable[]
  /** Empty in a .local file and not on the server: nothing to send. */
  missing: { key: string; file: EnvFile }[]
  unchanged: number
}

export const changeCount = (plan: Plan, prune: boolean) =>
  plan.create.length + plan.update.length + plan.resend.length + (prune ? plan.remove.length : 0)

/** Compare the files with the server. An empty value in a .local file is a placeholder, never sent. */
export function planPush(local: Map<string, EnvValue>, server: Variable[]): Plan {
  const plan: Plan = { create: [], update: [], resend: [], remove: [], missing: [], unchanged: 0 }
  const byKey = new Map(server.map((v) => [v.key, v]))
  for (const [key, { value, secret, file }] of local) {
    const current = byKey.get(key)
    if (secret && value === '') {
      if (current) plan.unchanged++
      else plan.missing.push({ key, file })
      continue
    }
    if (!current) plan.create.push({ key, value, secret })
    else if (current.secret) plan.resend.push({ variable: current, value })
    else if (secret || current.value !== value) plan.update.push({ variable: current, value, secret, becomesSecret: secret })
    else plan.unchanged++
  }
  for (const variable of server) if (!local.has(variable.key)) plan.remove.push(variable)
  return plan
}
