/** URL paging and Appwrite query helpers shared by list pages. */

export interface PageParams {
  page: number
  limit: number
  offset: number
}

export function pageParams(url: URL, limit = 25): PageParams {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
  return { page, limit, offset: (page - 1) * limit }
}

export const pageCount = (total: number, limit: number): number => Math.max(1, Math.ceil(total / limit))

/** orderDesc + limit + offset, the shape every console list uses. */
export function listQueries(page: number, limit: number, order = '$createdAt'): string[] {
  return [
    JSON.stringify({ method: 'orderDesc', attribute: order }),
    JSON.stringify({ method: 'limit', values: [limit] }),
    JSON.stringify({ method: 'offset', values: [(page - 1) * limit] }),
  ]
}
