/**
 * The Project service: services, protocols, sign-in methods, policies and
 * mock phone numbers, which `appwrite pull/push settings` read and write.
 * API keys and console admins only.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { err } from '~/lib/errors'
import { json, list, noContent } from '~/lib/http'
import { page } from '~/lib/paging'
import type { Router } from '~/lib/router'
import type { ProjectInfo } from '~/projects/types'
import type { Services } from '~/services'
import type { MockPhone } from '~/settings/access'

/** Appwrite's Project model, with what this server has. */
export function projectModel(info: ProjectInfo, services: Services) {
  const smtp = services.config.smtp
  return {
    $id: info.id,
    $createdAt: info.createdAt,
    $updatedAt: info.updatedAt,
    name: info.name,
    description: '',
    teamId: info.orgId,
    region: 'default',
    logo: '',
    url: '',
    legalName: '',
    legalCountry: '',
    legalState: '',
    legalCity: '',
    legalAddress: '',
    legalTaxId: '',
    devKeys: [],
    smtpEnabled: Boolean(smtp),
    smtpSenderName: smtp?.senderName ?? '',
    smtpSenderEmail: smtp?.senderEmail ?? '',
    smtpReplyToName: '',
    smtpReplyToEmail: '',
    smtpHost: smtp?.host ?? '',
    smtpPort: smtp?.port ?? 0,
    smtpUsername: smtp?.user ?? '',
    smtpPassword: '',
    smtpSecure: smtp?.secure ? 'tls' : '',
    pingCount: 0,
    pingedAt: '',
    labels: [],
    status: 'active',
    onboarding: {},
    authDuration: services.config.sessionDuration,
    authLimit: services.access.policy('user-limit').total,
    authSessionsLimit: services.config.sessionsLimit,
    authMethods: services.access.authMethods(),
    services: services.access.services(),
    protocols: services.access.protocols(),
    blocks: [],
    consoleAccessedAt: '',
    platforms: [],
    webhooks: [],
    keys: [],
  }
}

const mockModel = (m: MockPhone) => ({ $id: m.number, number: m.number, otp: m.otp, $createdAt: m.createdAt, $updatedAt: m.updatedAt })

function enabledParam(params: Record<string, unknown>): boolean {
  if (typeof params.enabled !== 'boolean') throw err('general_argument_invalid', 'Invalid `enabled` param: Value must be a valid boolean')
  return params.enabled
}

const infoOf = (ctx: AppContext): ProjectInfo => ({
  id: ctx.config.projectId,
  name: ctx.config.projectName,
  orgId: ctx.config.orgId,
  createdAt: '',
  updatedAt: '',
})

export function projectRoutes(router: Router<AppContext>): void {
  router.get('/project', ({ ctx }) => {
    requireKey(ctx, 'project.read')
    return json(projectModel(infoOf(ctx), ctx))
  })

  router.patch('/project/services/:serviceId', ({ ctx, path, params }) => {
    requireKey(ctx, 'project.write')
    ctx.access.setService(path.serviceId!, enabledParam(params))
    return json(projectModel(infoOf(ctx), ctx))
  })

  router.patch('/project/protocols/:protocolId', ({ ctx, path, params }) => {
    requireKey(ctx, 'project.write')
    ctx.access.setProtocol(path.protocolId!, enabledParam(params))
    return json(projectModel(infoOf(ctx), ctx))
  })

  router.patch('/project/auth-methods/:methodId', ({ ctx, path, params }) => {
    requireKey(ctx, 'project.write')
    ctx.access.setAuthMethod(path.methodId!, enabledParam(params))
    return json(projectModel(infoOf(ctx), ctx))
  })

  router.get('/project/policies', ({ ctx, params }) => {
    requireKey(ctx, 'policies.read')
    const { total, items } = page(ctx.access.policies(), list(params.queries))
    return json({ total, policies: items })
  })

  router.get('/project/policies/:policyId', ({ ctx, path }) => {
    requireKey(ctx, 'policies.read')
    return json(ctx.access.policy(path.policyId!))
  })

  router.patch('/project/policies/:policyId', ({ ctx, path, params }) => {
    requireKey(ctx, 'policies.write')
    return json(ctx.access.updatePolicy(path.policyId!, params))
  })

  router.get('/project/mock-phones', ({ ctx, params }) => {
    requireKey(ctx, 'project.read')
    const { total, items } = page(ctx.access.mockPhones().map(mockModel), list(params.queries))
    return json({ total, mockNumbers: items.map(({ $id: _, ...m }) => m) })
  })

  router.post('/project/mock-phones', ({ ctx, params }) => {
    requireKey(ctx, 'project.write')
    const { $id: _, ...m } = mockModel(ctx.access.createMockPhone(params.number, params.otp))
    return json(m, 201)
  })

  router.get('/project/mock-phones/:number', ({ ctx, path }) => {
    requireKey(ctx, 'project.read')
    const { $id: _, ...m } = mockModel(ctx.access.mockPhone(path.number!))
    return json(m)
  })

  router.put('/project/mock-phones/:number', ({ ctx, path, params }) => {
    requireKey(ctx, 'project.write')
    const { $id: _, ...m } = mockModel(ctx.access.updateMockPhone(path.number!, params.otp))
    return json(m)
  })

  router.delete('/project/mock-phones/:number', ({ ctx, path }) => {
    requireKey(ctx, 'project.write')
    ctx.access.deleteMockPhone(path.number!)
    return noContent()
  })
}
