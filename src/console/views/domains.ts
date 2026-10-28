/**
 * The custom-domain card shared by site and function settings: DNS instructions,
 * a table of saved domains with their verification state, and a form that saves
 * the list. Keeping it in one place means both resources behave the same way.
 */
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { badge, destroy, hidden, settingsSection } from '~/console/ui'
import { functionHost, siteHost } from '~/lib/hosts'
import type { ProxyResourceType } from '~/proxy/service'
import { checkCustomDomains, type DomainCheck, type DomainStatus } from '~/proxy/verify'

export interface CustomDomainsSectionOptions {
  ctx: ConsoleContext
  type: ProxyResourceType
  id: string
  /** Where the add/remove forms POST, e.g. `/console/sites/landing/domains`. */
  action: string
  /** Anchor used by the settings search. */
  sectionId: string
  /** Extra note specific to the resource, such as the API host to avoid. */
  note?: Html
}

function statusBadge(status: DomainStatus): Html {
  return status === 'verified'
    ? html`<span title="The domain's DNS points at this server.">${badge('Verified', 'success')}</span>`
    : html`<span title="The domain's DNS does not point at this server yet.">${badge('Unverified', 'attention')}</span>`
}

/** A compact record table so a CNAME and an A record are easy to compare. */
function dnsRecords(target: string, ipv4: string | null): Html {
  return html`<div class="scroll">
    <table class="record-table">
      <thead><tr><th>Type</th><th>Host</th><th>Points to</th></tr></thead>
      <tbody>
        <tr><td class="mono">CNAME</td><td class="mono">&lt;domain&gt;</td><td class="mono">${target}</td></tr>
        <tr><td class="mono">A</td><td class="mono">&lt;domain&gt;</td><td class="${ipv4 ? 'mono' : 'subdued'}">${ipv4 ?? "This server's IPv4 address"}</td></tr>
      </tbody>
    </table>
  </div>`
}

function domainsTable(domains: DomainCheck[], action: string): Html {
  if (!domains.length) return html`<p class="subdued" style="margin:0 0 12px">No custom domains yet.</p>`
  return html`<div class="scroll">
    <table class="domain-table">
      <thead><tr><th>Domain</th><th>Status</th><th class="actions-col"><span class="visually-hidden">Actions</span></th></tr></thead>
      <tbody>
        ${domains.map(
          (entry) => html`<tr>
            <td class="mono">${entry.domain}</td>
            <td>${statusBadge(entry.status)}</td>
            <td class="actions-col">${destroy(`${action}/remove`, 'Remove', `Remove ${entry.domain}?`, { remove: entry.domain })}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`
}

export async function customDomainsSection(options: CustomDomainsSectionOptions): Promise<Html> {
  const { ctx, type, id, action, sectionId, note } = options
  const domains = ctx.services.proxy.domainsFor(type, id)
  const target = type === 'site' ? siteHost(ctx.services.config, id) : functionHost(ctx.services.config, id)
  const overview = await checkCustomDomains(domains, { target, publicEndpoint: ctx.services.config.publicEndpoint })
  const noun = type === 'site' ? 'site' : 'function'

  return settingsSection(
    'Custom domains',
    `Point a CNAME or an A record at this server, then add the domain here. The default ${noun} URL always keeps working.`,
    html`${dnsRecords(overview.cnameTarget, overview.ipv4)}
      <p class="help">Use the CNAME for a subdomain such as <code>www.example.com</code>, or the A record for a root domain such as <code>example.com</code>. Caddy gets the certificate on the first visit.${note ? html` ${note}` : ''}</p>
      ${domainsTable(overview.domains, action)}
      <form method="post" action="${action}">
        ${overview.domains.map((entry) => hidden({ domains: entry.domain }))}
        <label>Add a domain<input name="domains" class="mono" placeholder="www.example.com" autocomplete="off" spellcheck="false"><small>Without <code>https://</code> or a path. Separate several with commas.</small></label>
        <div class="foot"><button class="primary">Save domains</button></div>
      </form>`,
    { id: sectionId },
  )
}
