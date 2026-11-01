/** Organization-level email delivery, used by the console and inherited by projects. */
import type { SmtpConfig } from '~/config'
import type { Html } from '~/console/html'
import { settingsSection } from '~/console/ui'
import { smtpForm } from './smtp'

export const ORGANIZATION_EMAIL = '/console/organization/email'

export interface OrganizationEmailOptions {
  smtp: SmtpConfig | null
  /** Address for the test-email button. */
  recipient: string
}

export function organizationEmailView({ smtp, recipient }: OrganizationEmailOptions): Html {
  return settingsSection(
    'Email delivery',
    'Sends console sign-in codes and invitations, and is the default SMTP for every project without its own email settings.',
    smtpForm({ action: ORGANIZATION_EMAIL, testAction: `${ORGANIZATION_EMAIL}/test`, smtp, recipient }),
    { id: 'email' },
  )
}
