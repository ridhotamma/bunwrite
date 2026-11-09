/**
 * Localization data and request-locale resolution, matching Appwrite's Locale
 * service: countries, continents, currencies, languages and phone codes, with
 * names in the language the client asks for through `X-Appwrite-Locale` (or
 * `Accept-Language`).
 *
 * The static lists live in `data.ts`. Country, language and currency names are
 * localized with the runtime's `Intl` data where it exists, so no translation
 * table has to be maintained here.
 */
import { clientIpOf } from '~/lib/client-ip'
import { apiHeader } from '~/lib/compat'
import { COUNTRIES, CONTINENTS, CURRENCIES, EU_COUNTRY_CODES, LANGUAGES, LOCALE_CODES, PHONE_CODES } from './data'

export const DEFAULT_LOCALE = 'en'

/** A supported locale code, or the fallback when the value is unknown. */
export function normalizeLocale(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_LOCALE
  const code = value.trim().toLowerCase().replace(/_/g, '-')
  if (!code) return DEFAULT_LOCALE
  if (LOCALE_CODES.some((locale) => locale.code === code)) return code
  const base = code.split('-')[0]!
  return LOCALE_CODES.some((locale) => locale.code === base) ? base : DEFAULT_LOCALE
}

/** The first usable language tag in `Accept-Language`, for browsers that do not send the Appwrite header. */
function acceptedLanguage(request: Request): string | null {
  const header = request.headers.get('accept-language')
  if (!header) return null
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim()
    if (!tag) continue
    // `*` means "anything", and quality values were already stripped with the
    // parameters. Keep only tags that look like a locale.
    if (tag === '*') continue
    if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag)) return tag
  }
  return null
}

/** The locale this request asks for. An explicit Appwrite header wins over the browser's Accept-Language. */
export function requestLocale(request: Request): string {
  return normalizeLocale(apiHeader(request, 'locale') ?? acceptedLanguage(request) ?? DEFAULT_LOCALE)
}

/** The display name of a locale code, for console selectors and error messages. */
export function localeName(code: string): string {
  return LOCALE_CODES.find((locale) => locale.code === code)?.name ?? code
}

function displayNames(locale: string, type: 'region' | 'language' | 'currency'): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type, fallback: 'none' })
  } catch {
    return null
  }
}

function localized(display: Intl.DisplayNames | null, code: string, fallback: string): string {
  try {
    return display?.of(code) ?? fallback
  } catch {
    return fallback
  }
}

export function regionName(locale: string, code: string): string {
  const fallback = COUNTRIES[code]?.name ?? code
  return localized(displayNames(locale, 'region'), code, fallback)
}

export function languageName(locale: string, code: string): string {
  const fallback = LANGUAGES.find((language) => language.code === code)?.name ?? code
  return localized(displayNames(locale, 'language'), code, fallback)
}

const CONTINENT_NAMES: Record<string, Partial<Record<string, string>>> = {
  id: { AF: 'Afrika', AN: 'Antartika', AS: 'Asia', EU: 'Eropa', NA: 'Amerika Utara', OC: 'Oseania', SA: 'Amerika Selatan' },
  de: { AF: 'Afrika', AN: 'Antarktika', AS: 'Asien', EU: 'Europa', NA: 'Nordamerika', OC: 'Ozeanien', SA: 'Südamerika' },
  es: { AF: 'África', AN: 'Antártida', AS: 'Asia', EU: 'Europa', NA: 'América del Norte', OC: 'Oceanía', SA: 'América del Sur' },
  fr: { AF: 'Afrique', AN: 'Antarctique', AS: 'Asie', EU: 'Europe', NA: 'Amérique du Nord', OC: 'Océanie', SA: 'Amérique du Sud' },
  it: { AF: 'Africa', AN: 'Antartide', AS: 'Asia', EU: 'Europa', NA: 'America del Nord', OC: 'Oceania', SA: 'America del Sud' },
  ja: { AF: 'アフリカ', AN: '南極', AS: 'アジア', EU: 'ヨーロッパ', NA: '北アメリカ', OC: 'オセアニア', SA: '南アメリカ' },
  pt: { AF: 'África', AN: 'Antártida', AS: 'Ásia', EU: 'Europa', NA: 'América do Norte', OC: 'Oceania', SA: 'América do Sul' },
  ru: { AF: 'Африка', AN: 'Антарктида', AS: 'Азия', EU: 'Европа', NA: 'Северная Америка', OC: 'Океания', SA: 'Южная Америка' },
  tr: { AF: 'Afrika', AN: 'Antarktika', AS: 'Asya', EU: 'Avrupa', NA: 'Kuzey Amerika', OC: 'Okyanusya', SA: 'Güney Amerika' },
  zh: { AF: '非洲', AN: '南极洲', AS: '亚洲', EU: '欧洲', NA: '北美洲', OC: '大洋洲', SA: '南美洲' },
}

export function continentName(locale: string, code: string): string {
  const base = locale.split('-')[0]!
  return CONTINENT_NAMES[locale]?.[code] ?? CONTINENT_NAMES[base]?.[code] ?? CONTINENTS[code]?.name ?? 'Unknown'
}

export interface CountryModel {
  name: string
  code: string
}

export interface ContinentModel {
  name: string
  code: string
}

export interface CurrencyModel {
  symbol: string
  name: string
  symbolNative: string
  decimalDigits: number
  rounding: number
  code: string
  namePlural: string
}

export interface LanguageModel {
  name: string
  code: string
  nativeName: string
}

export interface PhoneModel {
  code: string
  countryCode: string
  countryName: string
}

export interface LocaleModel {
  ip: string
  countryCode: string
  country: string
  continentCode: string
  continent: string
  eu: boolean
  currency: string
}

export function listContinents(locale: string): ContinentModel[] {
  return Object.entries(CONTINENTS)
    .map(([code]) => ({ name: continentName(locale, code), code }))
    .sort((a, b) => a.name.localeCompare(b.name, locale))
}

export function listCountries(locale: string): CountryModel[] {
  return Object.keys(COUNTRIES)
    .map((code) => ({ name: regionName(locale, code), code }))
    .sort((a, b) => a.name.localeCompare(b.name, locale))
}

export function listCountriesEU(locale: string): CountryModel[] {
  return EU_COUNTRY_CODES.map((code) => ({ name: regionName(locale, code), code })).sort((a, b) => a.name.localeCompare(b.name, locale))
}

export function listCountriesPhones(locale: string): PhoneModel[] {
  return Object.entries(PHONE_CODES)
    .map(([countryCode, code]) => ({ code: `+${code}`, countryCode, countryName: regionName(locale, countryCode) }))
    .sort((a, b) => Number(a.code.slice(1)) - Number(b.code.slice(1)) || a.countryCode.localeCompare(b.countryCode))
}

function currencySymbol(locale: string, code: string, fallback: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(0)
    return parts.find((part) => part.type === 'currency')?.value ?? fallback
  } catch {
    return fallback
  }
}

export function listCurrencies(locale: string): CurrencyModel[] {
  const display = displayNames(locale, 'currency')
  return CURRENCIES.map((currency) => ({
    ...currency,
    name: localized(display, currency.code, currency.name),
    symbol: currencySymbol(locale, currency.code, currency.symbol),
  }))
}

export function listLanguages(locale: string): LanguageModel[] {
  return LANGUAGES.map((language) => ({ ...language, name: languageName(locale, language.code) }))
}

export function listCodes(): { code: string; name: string }[] {
  return LOCALE_CODES.map(({ code, name }) => ({ code, name }))
}

/** Country from Cloudflare, Vercel or the generic proxy header; empty for anonymized or unknown values. */
function requestCountry(request: Request): string {
  const raw = request.headers.get('cf-ipcountry') ?? request.headers.get('x-vercel-ip-country') ?? request.headers.get('x-country-code') ?? ''
  const code = raw.trim().toUpperCase()
  if (code === 'XX' || code === 'T1' || !/^[A-Z]{2}$/.test(code)) return ''
  return code
}

/** The Locale model for this request's IP and headers. */
export function localeInfo(request: Request, locale: string): LocaleModel {
  const code = requestCountry(request)
  const country = code ? COUNTRIES[code] : undefined
  return {
    ip: clientIpOf(request),
    countryCode: code || '--',
    country: code ? regionName(locale, code) : 'Unknown',
    continentCode: country?.continent || '--',
    continent: country?.continent ? continentName(locale, country.continent) : 'Unknown',
    eu: Boolean(code && EU_COUNTRY_CODES.includes(code)),
    currency: country?.currency ?? '',
  }
}
