/**
 * The Locale API: the Appwrite-compatible endpoints under `/locale`.
 *
 * Lists use the request's `X-Appwrite-Locale` (or `Accept-Language`) for names,
 * and `total=false` skips counting like Appwrite. `GET /locale` resolves the
 * visitor from the proxy's country header and the caller's IP.
 */
import type { AppContext } from '~/app'
import { requireScope } from '~/auth/routes'
import { bool, json } from '~/lib/http'
import type { Router } from '~/lib/router'
import {
  listCodes,
  listContinents,
  listCountries,
  listCountriesEU,
  listCountriesPhones,
  listCurrencies,
  listLanguages,
  localeInfo,
  requestLocale,
} from './service'

type ListContext = { ctx: AppContext; params: Record<string, unknown>; request: Request }

function total(route: ListContext, count: number): number {
  return bool(route.params.total, true) ? count : 0
}

export function localeRoutes(router: Router<AppContext>): void {
  router.get('/locale', ({ ctx, request }) => {
    requireScope(ctx, 'locale.read')
    return json(localeInfo(request, requestLocale(request)))
  })

  router.get('/locale/codes', (route) => {
    requireScope(route.ctx, 'locale.read')
    const localeCodes = listCodes()
    return json({ total: total(route, localeCodes.length), localeCodes })
  })

  router.get('/locale/continents', (route) => {
    requireScope(route.ctx, 'locale.read')
    const continents = listContinents(requestLocale(route.request))
    return json({ total: total(route, continents.length), continents })
  })

  router.get('/locale/countries', (route) => {
    requireScope(route.ctx, 'locale.read')
    const countries = listCountries(requestLocale(route.request))
    return json({ total: total(route, countries.length), countries })
  })

  router.get('/locale/countries/eu', (route) => {
    requireScope(route.ctx, 'locale.read')
    const countries = listCountriesEU(requestLocale(route.request))
    return json({ total: total(route, countries.length), countries })
  })

  router.get('/locale/countries/phones', (route) => {
    requireScope(route.ctx, 'locale.read')
    const phones = listCountriesPhones(requestLocale(route.request))
    return json({ total: total(route, phones.length), phones })
  })

  router.get('/locale/currencies', (route) => {
    requireScope(route.ctx, 'locale.read')
    const currencies = listCurrencies(requestLocale(route.request))
    return json({ total: total(route, currencies.length), currencies })
  })

  router.get('/locale/languages', (route) => {
    requireScope(route.ctx, 'locale.read')
    const languages = listLanguages(requestLocale(route.request))
    return json({ total: total(route, languages.length), languages })
  })
}
