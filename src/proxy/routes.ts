/**
 * Appwrite's Proxy API: custom domains for sites and functions. A resource can
 * have any number of rules, which is how multiple custom domains are attached.
 */
import type { AppContext } from '~/app'
import { requireKey } from '~/auth/routes'
import { json, list, noContent, str } from '~/lib/http'
import type { Router } from '~/lib/router'
import type { ProxyRuleRow } from './service'

const ruleModel = (ctx: AppContext, rule: ProxyRuleRow) => {
  const deploymentId =
    rule.resource_type === 'site'
      ? ctx.sites.site(rule.resource_id).deployment_id
      : ctx.functions.fn(rule.resource_id).deployment_id
  return {
    $id: rule.id,
    $createdAt: rule.created_at,
    $updatedAt: rule.updated_at,
    domain: rule.domain,
    type: 'deployment',
    trigger: 'manual',
    redirectUrl: '',
    redirectStatusCode: 301,
    deploymentId,
    deploymentResourceType: rule.resource_type,
    deploymentResourceId: rule.resource_id,
    deploymentVcsProviderBranch: '',
    status: 'verified',
    logs: '',
    renewAt: '',
  }
}

export function proxyRoutes(router: Router<AppContext>): void {
  router.get('/proxy/rules', ({ ctx, params }) => {
    requireKey(ctx, 'rules.read')
    let rules = ctx.proxy.list()
    let limit = 25
    for (const raw of list(params.queries)) {
      const query = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { method?: string; attribute?: string; values?: unknown[] }
      if (query?.method === 'limit') limit = Number(query.values?.[0] ?? 25)
      if (query?.method === 'equal' && query.attribute) {
        const values = (query.values ?? []).map(String)
        if (query.attribute === 'deploymentResourceType') rules = rules.filter((rule) => values.includes(rule.resource_type))
        else if (query.attribute === 'deploymentResourceId') rules = rules.filter((rule) => values.includes(rule.resource_id))
        else rules = rules.filter((rule) => values.includes(String((rule as unknown as Record<string, unknown>)[query.attribute!])))
      }
    }
    return json({ total: rules.length, rules: rules.slice(0, limit).map((rule) => ruleModel(ctx, rule)) })
  })

  router.get('/proxy/rules/:ruleId', ({ ctx, path }) => {
    requireKey(ctx, 'rules.read')
    return json(ruleModel(ctx, ctx.proxy.get(path.ruleId!)))
  })

  router.post('/proxy/rules/site', ({ ctx, params }) => {
    requireKey(ctx, 'rules.write')
    const site = ctx.sites.site(str(params.siteId) ?? '')
    const rule = ctx.proxy.create('site', site.id, str(params.domain) ?? '')
    return json(ruleModel(ctx, rule), 201)
  })

  router.post('/proxy/rules/function', ({ ctx, params }) => {
    requireKey(ctx, 'rules.write')
    const fn = ctx.functions.fn(str(params.functionId) ?? '')
    const rule = ctx.proxy.create('function', fn.id, str(params.domain) ?? '')
    return json(ruleModel(ctx, rule), 201)
  })

  router.patch('/proxy/rules/:ruleId/status', ({ ctx, path }) => {
    requireKey(ctx, 'rules.write')
    return json(ruleModel(ctx, ctx.proxy.get(path.ruleId!)))
  })

  router.delete('/proxy/rules/:ruleId', ({ ctx, path }) => {
    requireKey(ctx, 'rules.write')
    ctx.proxy.remove(path.ruleId!)
    return noContent()
  })
}
