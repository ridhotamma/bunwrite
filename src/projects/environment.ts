/**
 * A project's environment label (production, staging, ...): shown as a badge
 * in the console so nobody edits the wrong project. Set in Settings → General,
 * or by `bunwrite env add` through the console API.
 */
import { err } from '~/lib/errors'

const LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/

export const SUGGESTED_ENVIRONMENTS = ['production', 'staging', 'preview', 'development']

/** A clean label, or '' for none. Refuses anything else. */
export function environmentLabel(value: unknown): string {
  const label = String(value ?? '').trim().toLowerCase()
  if (label && !LABEL.test(label)) {
    throw err('general_argument_invalid', 'An environment is up to 32 letters, digits, - or _, starting with a letter or digit.')
  }
  return label
}

/** Badge tone: red for production, amber for staging-like, blue for development-like. */
export function environmentTone(label: string | undefined): '' | 'critical' | 'attention' | 'info' {
  if (!label) return ''
  if (/^(prod|production|live|main)$/.test(label)) return 'critical'
  if (/^(stag|staging|stage|preview|qa|test|uat)/.test(label)) return 'attention'
  if (/^(dev|development|local|sandbox)/.test(label)) return 'info'
  return ''
}
