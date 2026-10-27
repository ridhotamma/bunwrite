/** Five-field cron (minute hour day-of-month month day-of-week), evaluated in UTC like Appwrite. */

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const

function field(spec: string, [min, max]: readonly [number, number]): Set<number> | null {
  if (spec === '*') return null
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [range, stepText] = part.split('/') as [string, string?]
    const step = stepText ? Number(stepText) : 1
    let [from, to] = range === '*' ? [min, max] : (range.split('-').map(Number) as [number, number?]) as [number, number]
    if (to === undefined || Number.isNaN(to)) to = stepText ? max : from
    if ([from, to, step].some((n) => !Number.isInteger(n)) || step < 1 || from < min || to > max || from > to) {
      throw new Error(`Invalid cron field "${spec}"`)
    }
    for (let v = from; v <= to; v += step) out.add(max === 6 && v === 7 ? 0 : v)
  }
  return out
}

export interface Cron {
  matches(date: Date): boolean
}

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`Cron "${expression}" must have five fields`)
  const [min, hour, dom, mon, dow] = parts.map((p, i) => field(p, RANGES[i]!))
  return {
    matches(date: Date) {
      const ok = (set: Set<number> | null | undefined, v: number) => !set || set.has(v)
      if (!ok(min, date.getUTCMinutes()) || !ok(hour, date.getUTCHours()) || !ok(mon, date.getUTCMonth() + 1)) return false
      // Like classic cron: when both day fields are restricted, either may match.
      if (dom && dow) return dom.has(date.getUTCDate()) || dow.has(date.getUTCDay())
      return ok(dom, date.getUTCDate()) && ok(dow, date.getUTCDay())
    },
  }
}
