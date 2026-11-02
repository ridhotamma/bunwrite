/** Console email delivery for sign-in codes, MFA and organization invitations. */
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
    'Console email delivery',
    'Sends console sign-in codes, MFA codes and organization invitations. Each project has its own SMTP settings.',
    smtpForm({ action: ORGANIZATION_EMAIL, testAction: `${ORGANIZATION_EMAIL}/test`, smtp, recipient }),
    { id: 'email' },
  )
}
