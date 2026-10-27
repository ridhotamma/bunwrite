/** Parse and validate a pasted .env block for bulk function variables. */

export interface EnvVariable {
  key: string
  value: string
}

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export class EnvParseError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(' '))
    this.name = 'EnvParseError'
  }
}

export function parseEnvVariables(text: string): EnvVariable[] {
  const vars: EnvVariable[] = []
  const issues: string[] = []

  text.split(/\r?\n/).forEach((line, index) => {
    const raw = line.trim()
    if (!raw || raw.startsWith('#')) return
    const body = raw.replace(/^export\s+/, '')
    const equals = body.indexOf('=')
    if (equals < 1) {
      issues.push(`Line ${index + 1}: expected KEY=value.`)
      return
    }
    const key = body.slice(0, equals).trim()
    if (!ENV_KEY_RE.test(key)) {
      issues.push(`Line ${index + 1}: "${key}" is not a valid variable name.`)
      return
    }
    let value = body.slice(equals + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    vars.push({ key, value })
  })

  if (!vars.length && !issues.length) issues.push('Enter at least one variable, one KEY=value per line.')
  if (issues.length) throw new EnvParseError(issues)
  return vars
}
