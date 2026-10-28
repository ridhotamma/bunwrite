/**
 * Preview hosts for sites deployed from Git, one DNS label under SITES_DOMAIN:
 *
 * - `<siteId>--git-<branch>`: the newest ready build of a branch (or `pr-<n>`
 *   for a fork's pull request), kept in `_site_branches`;
 * - `<siteId>--<deploymentId>`: one deployment, for as long as it is kept.
 *
 * A host is split at its last `--`. Branch slugs never contain `--`, so site
 * IDs that do still resolve.
 */
import { sha256 } from '~/lib/ids'

/** Longest DNS label. */
const LABEL = 63
const BRANCH_MARK = 'git-'

/** `feature/Login_Page` → `feature-login-page`. */
export function slugify(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'branch'
}

/** The slug for a branch on a site, short enough that `<siteId>--git-<slug>` is one DNS label. */
export function branchSlug(siteId: string, branch: string): string {
  const slug = slugify(branch)
  const room = LABEL - siteId.length - 2 - BRANCH_MARK.length
  if (slug.length <= room) return slug
  const hash = sha256(branch).slice(0, 6)
  return `${slug.slice(0, Math.max(1, room - 7)).replace(/-+$/, '')}-${hash}`
}

export const branchLabel = (siteId: string, slug: string) => `${siteId}--${BRANCH_MARK}${slug}`

export const deploymentLabel = (siteId: string, deploymentId: string) => `${siteId}--${deploymentId}`

/** What a preview label points at, or null when it is not one. */
export function parsePreview(label: string): { siteId: string; branchSlug?: string; deploymentId?: string } | null {
  const at = label.lastIndexOf('--')
  if (at <= 0) return null
  const siteId = label.slice(0, at)
  const rest = label.slice(at + 2)
  if (!rest) return null
  if (rest.startsWith(BRANCH_MARK)) return rest.length > BRANCH_MARK.length ? { siteId, branchSlug: rest.slice(BRANCH_MARK.length) } : null
  return /^[a-z0-9]+$/.test(rest) ? { siteId, deploymentId: rest } : null
}
