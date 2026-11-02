/** Email is handed to the mailer without holding up the request or console form. */
import { describe, expect, test } from 'bun:test'

import { openDb } from '~/db/connection'
import { flushBackgroundMail, sendMailLater, type Mail, type Mailer } from '~/mail/mailer'
import { OrganizationService } from '~/organizations/service'

const mail: Mail = { to: 'person@example.com', subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' }

function gatedMailer() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const sent: Mail[] = []
  const mailer: Mailer = {
    enabled: true,
    async send(message) {
      sent.push(message)
      await gate
    },
  }
  return { mailer, sent, release }
}

describe('background mail', () => {
  test('sendMailLater starts delivery and returns without waiting', async () => {
    const { mailer, sent, release } = gatedMailer()
    sendMailLater(mailer, mail, 'test message')
    expect(sent).toHaveLength(1)
    const state = await Promise.race([flushBackgroundMail().then(() => 'sent'), Bun.sleep(25).then(() => 'pending')])
    expect(state).toBe('pending')
    release()
    await flushBackgroundMail()
  })

  test('organization invitations are persisted and queued without blocking the form', async () => {
    const db = openDb(':memory:')
    try {
      const organizations = new OrganizationService(db)
      await organizations.ensure('org_test', 'Test')
      const { mailer, sent, release } = gatedMailer()
      const pending = organizations.invite('org_test', [{ email: 'async@example.com', role: 'developer' }], {
        baseUrl: 'http://localhost',
        orgName: 'Test',
        inviter: 'owner@example.com',
        mailer,
      })
      const state = await Promise.race([pending.then(() => 'returned'), Bun.sleep(50).then(() => 'blocked')])
      expect(state).toBe('returned')
      release()
      const [result] = await pending
      expect(result).toMatchObject({ sent: true })
      expect(result!.member.email).toBe('async@example.com')
      expect(sent).toHaveLength(1)
      expect(sent[0]!.to).toBe('async@example.com')
      expect(await organizations.findByEmail('org_test', 'async@example.com')).toMatchObject({ status: 'invited' })
      await flushBackgroundMail()
    } finally {
      db.sqlite.close()
    }
  })
})
