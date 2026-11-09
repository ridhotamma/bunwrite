/**
 * The Locale API: Appwrite-compatible lists, localized names through the
 * `X-Appwrite-Locale` header, and the visitor lookup from proxy geo headers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client, Locale } from 'node-appwrite'

import { KEY, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer

beforeAll(() => {
  server = startServer()
})
afterAll(() => server.stop())

function locale() {
  return new Locale(new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY))
}

async function api(path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${server.endpoint}${path}`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY, ...headers } })
  return { status: response.status, body: (await response.json()) as any }
}

describe('lists', () => {
  test('countries, continents, currencies, languages, phone codes and locale codes have Appwrite shapes', async () => {
    const service = locale()
    const countries = await service.listCountries()
    expect(countries.total).toBeGreaterThan(190)
    expect(countries.countries.find((country: any) => country.code === 'ID')).toMatchObject({ name: 'Indonesia', code: 'ID' })

    const continents = await service.listContinents()
    expect(continents.total).toBe(7)
    expect(continents.continents.find((continent: any) => continent.code === 'EU')).toMatchObject({ name: 'Europe', code: 'EU' })

    const currencies = await service.listCurrencies()
    expect(currencies.total).toBeGreaterThan(100)
    expect(currencies.currencies.find((currency: any) => currency.code === 'USD')).toMatchObject({
      code: 'USD',
      symbol: '$',
      decimalDigits: 2,
      namePlural: 'US dollars',
    })

    const languages = await service.listLanguages()
    expect(languages.total).toBeGreaterThan(150)
    expect(languages.languages.find((language: any) => language.code === 'id')).toMatchObject({ name: 'Indonesian', nativeName: 'Bahasa Indonesia' })

    const phones = await service.listCountriesPhones()
    expect(phones.phones.find((phone: any) => phone.countryCode === 'ID')).toMatchObject({ code: '+62', countryName: 'Indonesia' })

    const codes = await service.listCodes()
    expect(codes.total).toBe(131)
    expect(codes.localeCodes.find((code: any) => code.code === 'id')).toMatchObject({ code: 'id', name: 'Indonesian' })
  })

  test('the EU list holds the 27 member states', async () => {
    const eu = await locale().listCountriesEU()
    expect(eu.total).toBe(27)
    expect(eu.countries.map((country: any) => country.code)).toContain('DE')
    expect(eu.countries.map((country: any) => country.code)).not.toContain('GB')
  })

  test('total=false skips the count', async () => {
    const { body } = await api('/locale/countries?total=false')
    expect(body.total).toBe(0)
    expect(body.countries.length).toBeGreaterThan(190)
  })
})

describe('localized names', () => {
  test('X-Appwrite-Locale translates countries, languages and currencies', async () => {
    const french = new Locale(new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY).setLocale('fr'))
    expect((await french.listCountries()).countries.find((country: any) => country.code === 'DE')!.name).toBe('Allemagne')
    expect((await french.listLanguages()).languages.find((language: any) => language.code === 'de')!.name).toBe('allemand')
    expect((await french.listCurrencies()).currencies.find((currency: any) => currency.code === 'USD')!.name.toLowerCase()).toContain('états-unis')

    const indonesian = new Locale(new Client().setEndpoint(server.endpoint).setProject(PROJECT).setKey(KEY).setLocale('id'))
    expect((await indonesian.listContinents()).continents.find((continent: any) => continent.code === 'AF')!.name).toBe('Afrika')
    expect((await indonesian.listCountries()).countries.find((country: any) => country.code === 'DE')!.name).toBe('Jerman')
  })

  test('a regional locale falls back to its base language, and Accept-Language is accepted', async () => {
    const { body } = await api('/locale/countries', { 'x-appwrite-locale': 'fr-CA' })
    expect(body.countries.find((country: any) => country.code === 'DE').name).toBe('Allemagne')

    const browser = await api('/locale/continents', { 'accept-language': 'id-ID,id;q=0.9,en;q=0.8' })
    expect(browser.body.continents.find((continent: any) => continent.code === 'AS').name).toBe('Asia')
  })
})

describe('visitor locale', () => {
  test('uses the proxy country header for country, continent and currency', async () => {
    const { body } = await api('/locale', { 'cf-ipcountry': 'ID', 'x-appwrite-locale': 'id' })
    expect(body).toMatchObject({
      countryCode: 'ID',
      country: 'Indonesia',
      continentCode: 'AS',
      continent: 'Asia',
      eu: false,
      currency: 'IDR',
    })
    expect(body.ip).toBeTruthy()

    const { body: de } = await api('/locale', { 'cf-ipcountry': 'DE', 'x-appwrite-locale': 'fr' })
    expect(de).toMatchObject({ countryCode: 'DE', country: 'Allemagne', continentCode: 'EU', continent: 'Europe', eu: true, currency: 'EUR' })
  })

  test('unknown and anonymized countries stay unknown', async () => {
    expect(await (await fetch(`${server.endpoint}/locale`, { headers: { 'x-appwrite-project': PROJECT, 'x-appwrite-key': KEY } })).json()).toMatchObject({
      countryCode: '--',
      country: 'Unknown',
      continentCode: '--',
      continent: 'Unknown',
      eu: false,
      currency: '',
    })
    const { body } = await api('/locale', { 'cf-ipcountry': 'XX' })
    expect(body.countryCode).toBe('--')
  })
})
