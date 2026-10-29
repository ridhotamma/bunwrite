/** Settings routes and tab metadata shared by the page and its view. */
import type { SettingKey } from '~/settings/service'

export const SETTINGS = '/console/settings'

export const TABS = [
  { key: 'general', label: 'General', href: `${SETTINGS}/general` },
  { key: 'email', label: 'Email & sign-in', href: `${SETTINGS}/email` },
  { key: 'templates', label: 'Email templates', href: `${SETTINGS}/templates` },
  { key: 'storage', label: 'File storage', href: `${SETTINGS}/storage` },
  { key: 'cache', label: 'Caching', href: `${SETTINGS}/cache` },
  { key: 'backups', label: 'Backups', href: `${SETTINGS}/backups` },
  { key: 'functions', label: 'Functions', href: `${SETTINGS}/functions` },
  { key: 'variables', label: 'Variables', href: `${SETTINGS}/variables` },
  { key: 'git', label: 'Git', href: `${SETTINGS}/git` },
  { key: 'logs', label: 'Request logs', href: `${SETTINGS}/logs` },
  { key: 'render', label: 'HTML rendering', href: `${SETTINGS}/render` },
] as const

export type SettingsTab = (typeof TABS)[number]['key']

export const TAB_OF_SETTING: Record<SettingKey, SettingsTab> = {
  project: 'general',
  smtp: 'email',
  google: 'email',
  functions: 'functions',
  logs: 'logs',
  s3: 'storage',
  backups: 'backups',
  render: 'render',
  cache: 'cache',
}

export const tabPath = (tab: SettingsTab) => `${SETTINGS}/${tab}`

export const isTab = (key: string): key is SettingsTab => TABS.some((tab) => tab.key === key)
