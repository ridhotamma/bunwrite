/** Constants and small helpers shared by the backups page and its setup wizard. */
import { parseCron } from '~/functions/cron'

export const BACKUPS = '/console/organization/backups'
export const BACKUP_SETUP = `${BACKUPS}/setup`

/** Common schedules offered as presets. Custom expressions stay available underneath. */
export const BACKUP_SCHEDULES = [
  { key: 'daily', label: 'Daily at 02:00', cron: '0 2 * * *' },
  { key: 'every-6-hours', label: 'Every 6 hours', cron: '0 */6 * * *' },
  { key: 'every-12-hours', label: 'Every 12 hours', cron: '0 */12 * * *' },
  { key: 'weekly', label: 'Weekly on Monday at 02:00', cron: '0 2 * * 1' },
  { key: 'monthly', label: 'Monthly on the 1st at 02:00', cron: '0 2 1 * *' },
  { key: 'hourly', label: 'Every hour', cron: '0 * * * *' },
] as const

export type SchedulePreset = 'custom' | (typeof BACKUP_SCHEDULES)[number]['key']

export function schedulePreset(expression: string): SchedulePreset {
  return BACKUP_SCHEDULES.find((preset) => preset.cron === expression.trim())?.key ?? 'custom'
}

export function scheduleLabel(expression: string): string {
  return BACKUP_SCHEDULES.find((preset) => preset.cron === expression.trim())?.label ?? expression
}

/** The next UTC minute that the expression matches, for the summary card. */
export function nextRun(expression: string): string {
  try {
    const cron = parseCron(expression)
    const at = new Date()
    at.setUTCSeconds(0, 0)
    at.setUTCMinutes(at.getUTCMinutes() + 1)
    for (let minute = 0; minute < 366 * 24 * 60; minute++) {
      if (cron.matches(at)) {
        return `${at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false })} UTC`
      }
      at.setUTCMinutes(at.getUTCMinutes() + 1)
    }
  } catch {
    // Invalid schedules are reported by the form when they are saved.
  }
  return '—'
}
