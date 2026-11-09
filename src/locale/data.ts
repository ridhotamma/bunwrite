/**
 * Static localization data served by the Locale API.
 *
 * Countries, continents, currencies, languages, locale codes and phone codes
 * follow Appwrite's app/config/locale data (BSD-3-Clause). Continent and
 * currency membership come from the ISO 3166 dataset at
 * https://github.com/mledoze/countries. Names are served in the request's
 * locale through Intl.DisplayNames where the runtime has data for it.
 */

export interface CountryData {
  name: string
  /** ISO 3166-1 two-letter continent code: AF, AN, AS, EU, NA, OC or SA. */
  continent: string
  /** ISO 4217 currency code used in the country, or '' when unknown. */
  currency: string
  latitude: number
  longitude: number
}

export interface ContinentData {
  name: string
  latitude: number
  longitude: number
}

export interface CurrencyData {
  symbol: string
  name: string
  symbolNative: string
  decimalDigits: number
  rounding: number
  code: string
  namePlural: string
}

export interface LanguageData {
  code: string
  name: string
  nativeName: string
}

export interface LocaleCodeData {
  code: string
  name: string
}

/** ISO 3166-1 alpha-2 countries, in code order. */
export const COUNTRIES: Record<string, CountryData> = {
  "AD": {
    "name": "Andorra",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 42.5,
    "longitude": 1.6
  },
  "AE": {
    "name": "United Arab Emirates",
    "continent": "AS",
    "currency": "AED",
    "latitude": 24,
    "longitude": 54
  },
  "AF": {
    "name": "Afghanistan",
    "continent": "AS",
    "currency": "AFN",
    "latitude": 33,
    "longitude": 66
  },
  "AG": {
    "name": "Antigua and Barbuda",
    "continent": "NA",
    "currency": "XCD",
    "latitude": 17.05,
    "longitude": -61.8
  },
  "AL": {
    "name": "Albania",
    "continent": "EU",
    "currency": "ALL",
    "latitude": 41,
    "longitude": 20
  },
  "AM": {
    "name": "Armenia",
    "continent": "AS",
    "currency": "AMD",
    "latitude": 40,
    "longitude": 45
  },
  "AO": {
    "name": "Angola",
    "continent": "AF",
    "currency": "AOA",
    "latitude": -12.5,
    "longitude": 18.5
  },
  "AR": {
    "name": "Argentina",
    "continent": "SA",
    "currency": "ARS",
    "latitude": -34,
    "longitude": -64
  },
  "AT": {
    "name": "Austria",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 47.3,
    "longitude": 13.3
  },
  "AU": {
    "name": "Australia",
    "continent": "OC",
    "currency": "AUD",
    "latitude": -25,
    "longitude": 135
  },
  "AZ": {
    "name": "Azerbaijan",
    "continent": "AS",
    "currency": "AZN",
    "latitude": 40.5,
    "longitude": 47.5
  },
  "BA": {
    "name": "Bosnia and Herzegovina",
    "continent": "EU",
    "currency": "BAM",
    "latitude": 44,
    "longitude": 18
  },
  "BB": {
    "name": "Barbados",
    "continent": "NA",
    "currency": "BBD",
    "latitude": 13.17,
    "longitude": -59.53
  },
  "BD": {
    "name": "Bangladesh",
    "continent": "AS",
    "currency": "BDT",
    "latitude": 24,
    "longitude": 90
  },
  "BE": {
    "name": "Belgium",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 50.8,
    "longitude": 4
  },
  "BF": {
    "name": "Burkina Faso",
    "continent": "AF",
    "currency": "XOF",
    "latitude": 13,
    "longitude": -2
  },
  "BG": {
    "name": "Bulgaria",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 43,
    "longitude": 25
  },
  "BH": {
    "name": "Bahrain",
    "continent": "AS",
    "currency": "BHD",
    "latitude": 26,
    "longitude": 50.5
  },
  "BI": {
    "name": "Burundi",
    "continent": "AF",
    "currency": "BIF",
    "latitude": -3.5,
    "longitude": 30
  },
  "BJ": {
    "name": "Benin",
    "continent": "AF",
    "currency": "XOF",
    "latitude": 9.5,
    "longitude": 2.25
  },
  "BN": {
    "name": "Brunei",
    "continent": "AS",
    "currency": "BND",
    "latitude": 4.5,
    "longitude": 114.67
  },
  "BO": {
    "name": "Bolivia",
    "continent": "SA",
    "currency": "BOB",
    "latitude": -17,
    "longitude": -65
  },
  "BR": {
    "name": "Brazil",
    "continent": "SA",
    "currency": "BRL",
    "latitude": -10,
    "longitude": -55
  },
  "BS": {
    "name": "Bahamas",
    "continent": "NA",
    "currency": "BSD",
    "latitude": 24.25,
    "longitude": -76
  },
  "BT": {
    "name": "Bhutan",
    "continent": "AS",
    "currency": "BTN",
    "latitude": 27.5,
    "longitude": 90.5
  },
  "BW": {
    "name": "Botswana",
    "continent": "AF",
    "currency": "BWP",
    "latitude": -22,
    "longitude": 24
  },
  "BY": {
    "name": "Belarus",
    "continent": "EU",
    "currency": "BYN",
    "latitude": 53,
    "longitude": 28
  },
  "BZ": {
    "name": "Belize",
    "continent": "NA",
    "currency": "BZD",
    "latitude": 17.25,
    "longitude": -88.75
  },
  "CA": {
    "name": "Canada",
    "continent": "NA",
    "currency": "CAD",
    "latitude": 60,
    "longitude": -95
  },
  "CD": {
    "name": "Democratic Republic of the Congo",
    "continent": "AF",
    "currency": "CDF",
    "latitude": -2.5,
    "longitude": 23.5
  },
  "CF": {
    "name": "Central African Republic",
    "continent": "AF",
    "currency": "XAF",
    "latitude": 7,
    "longitude": 21
  },
  "CG": {
    "name": "Republic of the Congo",
    "continent": "AF",
    "currency": "XAF",
    "latitude": -1,
    "longitude": 15
  },
  "CH": {
    "name": "Switzerland",
    "continent": "EU",
    "currency": "CHF",
    "latitude": 47,
    "longitude": 8
  },
  "CI": {
    "name": "Côte d'Ivoire",
    "continent": "AF",
    "currency": "XOF",
    "latitude": 8,
    "longitude": -5
  },
  "CL": {
    "name": "Chile",
    "continent": "SA",
    "currency": "CLP",
    "latitude": -30,
    "longitude": -71
  },
  "CM": {
    "name": "Cameroon",
    "continent": "AF",
    "currency": "XAF",
    "latitude": 6,
    "longitude": 12
  },
  "CN": {
    "name": "China",
    "continent": "AS",
    "currency": "CNY",
    "latitude": 35,
    "longitude": 105
  },
  "CO": {
    "name": "Colombia",
    "continent": "SA",
    "currency": "COP",
    "latitude": 4,
    "longitude": -72
  },
  "CR": {
    "name": "Costa Rica",
    "continent": "NA",
    "currency": "CRC",
    "latitude": 10,
    "longitude": -84
  },
  "CU": {
    "name": "Cuba",
    "continent": "NA",
    "currency": "CUP",
    "latitude": 21.5,
    "longitude": -80
  },
  "CV": {
    "name": "Cape Verde",
    "continent": "AF",
    "currency": "CVE",
    "latitude": 16,
    "longitude": -24
  },
  "CY": {
    "name": "Cyprus",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 35,
    "longitude": 33
  },
  "CZ": {
    "name": "Czech Republic",
    "continent": "EU",
    "currency": "CZK",
    "latitude": 49.75,
    "longitude": 15.5
  },
  "DE": {
    "name": "Germany",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 51,
    "longitude": 9
  },
  "DJ": {
    "name": "Djibouti",
    "continent": "AF",
    "currency": "DJF",
    "latitude": 11.5,
    "longitude": 43
  },
  "DK": {
    "name": "Denmark",
    "continent": "EU",
    "currency": "DKK",
    "latitude": 56,
    "longitude": 10
  },
  "DM": {
    "name": "Dominica",
    "continent": "NA",
    "currency": "XCD",
    "latitude": 15.42,
    "longitude": -61.33
  },
  "DO": {
    "name": "Dominican Republic",
    "continent": "NA",
    "currency": "DOP",
    "latitude": 19,
    "longitude": -70.67
  },
  "DZ": {
    "name": "Algeria",
    "continent": "AF",
    "currency": "DZD",
    "latitude": 28,
    "longitude": 3
  },
  "EC": {
    "name": "Ecuador",
    "continent": "SA",
    "currency": "USD",
    "latitude": -2,
    "longitude": -77.5
  },
  "EE": {
    "name": "Estonia",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 59,
    "longitude": 26
  },
  "EG": {
    "name": "Egypt",
    "continent": "AF",
    "currency": "EGP",
    "latitude": 27,
    "longitude": 30
  },
  "ER": {
    "name": "Eritrea",
    "continent": "AF",
    "currency": "ERN",
    "latitude": 15,
    "longitude": 39
  },
  "ES": {
    "name": "Spain",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 40,
    "longitude": -4
  },
  "ET": {
    "name": "Ethiopia",
    "continent": "AF",
    "currency": "ETB",
    "latitude": 8,
    "longitude": 38
  },
  "FI": {
    "name": "Finland",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 64,
    "longitude": 26
  },
  "FJ": {
    "name": "Fiji",
    "continent": "OC",
    "currency": "FJD",
    "latitude": -18,
    "longitude": 175
  },
  "FM": {
    "name": "Micronesia",
    "continent": "OC",
    "currency": "",
    "latitude": 6.92,
    "longitude": 158.25
  },
  "FR": {
    "name": "France",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 46,
    "longitude": 2
  },
  "GA": {
    "name": "Gabon",
    "continent": "AF",
    "currency": "XAF",
    "latitude": -1,
    "longitude": 11.75
  },
  "GB": {
    "name": "United Kingdom",
    "continent": "EU",
    "currency": "GBP",
    "latitude": 54,
    "longitude": -2
  },
  "GD": {
    "name": "Grenada",
    "continent": "NA",
    "currency": "XCD",
    "latitude": 12.12,
    "longitude": -61.67
  },
  "GE": {
    "name": "Georgia",
    "continent": "AS",
    "currency": "GEL",
    "latitude": 42,
    "longitude": 43.5
  },
  "GH": {
    "name": "Ghana",
    "continent": "AF",
    "currency": "GHS",
    "latitude": 8,
    "longitude": -2
  },
  "GM": {
    "name": "Gambia",
    "continent": "AF",
    "currency": "GMD",
    "latitude": 13.47,
    "longitude": -16.57
  },
  "GN": {
    "name": "Guinea",
    "continent": "AF",
    "currency": "GNF",
    "latitude": 11,
    "longitude": -10
  },
  "GQ": {
    "name": "Equatorial Guinea",
    "continent": "AF",
    "currency": "XAF",
    "latitude": 2,
    "longitude": 10
  },
  "GR": {
    "name": "Greece",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 39,
    "longitude": 22
  },
  "GT": {
    "name": "Guatemala",
    "continent": "NA",
    "currency": "GTQ",
    "latitude": 15.5,
    "longitude": -90.25
  },
  "GW": {
    "name": "Guinea-Bissau",
    "continent": "AF",
    "currency": "XOF",
    "latitude": 12,
    "longitude": -15
  },
  "GY": {
    "name": "Guyana",
    "continent": "SA",
    "currency": "GYD",
    "latitude": 5,
    "longitude": -59
  },
  "HK": {
    "name": "Hong Kong",
    "continent": "AS",
    "currency": "HKD",
    "latitude": 22.25,
    "longitude": 114.17
  },
  "HN": {
    "name": "Honduras",
    "continent": "NA",
    "currency": "HNL",
    "latitude": 15,
    "longitude": -86.5
  },
  "HR": {
    "name": "Croatia",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 45.17,
    "longitude": 15.5
  },
  "HT": {
    "name": "Haiti",
    "continent": "NA",
    "currency": "HTG",
    "latitude": 19,
    "longitude": -72.42
  },
  "HU": {
    "name": "Hungary",
    "continent": "EU",
    "currency": "HUF",
    "latitude": 47,
    "longitude": 20
  },
  "ID": {
    "name": "Indonesia",
    "continent": "AS",
    "currency": "IDR",
    "latitude": -5,
    "longitude": 120
  },
  "IE": {
    "name": "Ireland",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 53,
    "longitude": -8
  },
  "IL": {
    "name": "Israel",
    "continent": "AS",
    "currency": "ILS",
    "latitude": 31.5,
    "longitude": 34.75
  },
  "IN": {
    "name": "India",
    "continent": "AS",
    "currency": "INR",
    "latitude": 20,
    "longitude": 77
  },
  "IQ": {
    "name": "Iraq",
    "continent": "AS",
    "currency": "IQD",
    "latitude": 33,
    "longitude": 44
  },
  "IR": {
    "name": "Iran",
    "continent": "AS",
    "currency": "IRR",
    "latitude": 32,
    "longitude": 53
  },
  "IS": {
    "name": "Iceland",
    "continent": "EU",
    "currency": "ISK",
    "latitude": 65,
    "longitude": -18
  },
  "IT": {
    "name": "Italy",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 42.83,
    "longitude": 12.83
  },
  "JM": {
    "name": "Jamaica",
    "continent": "NA",
    "currency": "JMD",
    "latitude": 18.25,
    "longitude": -77.5
  },
  "JO": {
    "name": "Jordan",
    "continent": "AS",
    "currency": "JOD",
    "latitude": 31,
    "longitude": 36
  },
  "JP": {
    "name": "Japan",
    "continent": "AS",
    "currency": "JPY",
    "latitude": 36,
    "longitude": 138
  },
  "KE": {
    "name": "Kenya",
    "continent": "AF",
    "currency": "KES",
    "latitude": 1,
    "longitude": 38
  },
  "KG": {
    "name": "Kyrgyzstan",
    "continent": "AS",
    "currency": "KGS",
    "latitude": 41,
    "longitude": 75
  },
  "KH": {
    "name": "Cambodia",
    "continent": "AS",
    "currency": "KHR",
    "latitude": 13,
    "longitude": 105
  },
  "KI": {
    "name": "Kiribati",
    "continent": "OC",
    "currency": "AUD",
    "latitude": 1.42,
    "longitude": 173
  },
  "KM": {
    "name": "Comoros",
    "continent": "AF",
    "currency": "KMF",
    "latitude": -12.17,
    "longitude": 44.25
  },
  "KN": {
    "name": "Saint Kitts and Nevis",
    "continent": "NA",
    "currency": "XCD",
    "latitude": 17.33,
    "longitude": -62.75
  },
  "KP": {
    "name": "North Korea",
    "continent": "AS",
    "currency": "KPW",
    "latitude": 40,
    "longitude": 127
  },
  "KR": {
    "name": "South Korea",
    "continent": "AS",
    "currency": "KRW",
    "latitude": 37,
    "longitude": 127.5
  },
  "KW": {
    "name": "Kuwait",
    "continent": "AS",
    "currency": "KWD",
    "latitude": 29.34,
    "longitude": 47.66
  },
  "KZ": {
    "name": "Kazakhstan",
    "continent": "AS",
    "currency": "KZT",
    "latitude": 48,
    "longitude": 68
  },
  "LA": {
    "name": "Laos",
    "continent": "AS",
    "currency": "LAK",
    "latitude": 18,
    "longitude": 105
  },
  "LB": {
    "name": "Lebanon",
    "continent": "AS",
    "currency": "LBP",
    "latitude": 33.83,
    "longitude": 35.83
  },
  "LC": {
    "name": "Saint Lucia",
    "continent": "NA",
    "currency": "XCD",
    "latitude": 13.88,
    "longitude": -61.13
  },
  "LI": {
    "name": "Liechtenstein",
    "continent": "EU",
    "currency": "CHF",
    "latitude": 47.17,
    "longitude": 9.53
  },
  "LK": {
    "name": "Sri Lanka",
    "continent": "AS",
    "currency": "LKR",
    "latitude": 7,
    "longitude": 81
  },
  "LR": {
    "name": "Liberia",
    "continent": "AF",
    "currency": "LRD",
    "latitude": 6.5,
    "longitude": -9.5
  },
  "LS": {
    "name": "Lesotho",
    "continent": "AF",
    "currency": "LSL",
    "latitude": -29.5,
    "longitude": 28.5
  },
  "LT": {
    "name": "Lithuania",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 56,
    "longitude": 24
  },
  "LU": {
    "name": "Luxembourg",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 49.75,
    "longitude": 6.17
  },
  "LV": {
    "name": "latitudevia",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 57,
    "longitude": 25
  },
  "LY": {
    "name": "Libya",
    "continent": "AF",
    "currency": "LYD",
    "latitude": 25,
    "longitude": 17
  },
  "MA": {
    "name": "Morocco",
    "continent": "AF",
    "currency": "MAD",
    "latitude": 32,
    "longitude": -5
  },
  "MC": {
    "name": "Monaco",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 43.73,
    "longitude": 7.4
  },
  "MD": {
    "name": "Moldova",
    "continent": "EU",
    "currency": "MDL",
    "latitude": 47,
    "longitude": 29
  },
  "ME": {
    "name": "Montenegro",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 42.5,
    "longitude": 19.3
  },
  "MG": {
    "name": "Madagascar",
    "continent": "AF",
    "currency": "MGA",
    "latitude": -20,
    "longitude": 47
  },
  "MH": {
    "name": "Marshall Islands",
    "continent": "OC",
    "currency": "USD",
    "latitude": 9,
    "longitude": 168
  },
  "MK": {
    "name": "North Macedonia",
    "continent": "EU",
    "currency": "MKD",
    "latitude": 41.83,
    "longitude": 22
  },
  "ML": {
    "name": "Mali",
    "continent": "AF",
    "currency": "XOF",
    "latitude": 17,
    "longitude": -4
  },
  "MM": {
    "name": "Myanmar",
    "continent": "AS",
    "currency": "MMK",
    "latitude": 22,
    "longitude": 98
  },
  "MN": {
    "name": "Mongolia",
    "continent": "AS",
    "currency": "MNT",
    "latitude": 46,
    "longitude": 105
  },
  "MR": {
    "name": "Mauritania",
    "continent": "AF",
    "currency": "MRU",
    "latitude": 20,
    "longitude": -12
  },
  "MT": {
    "name": "Malta",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 35.83,
    "longitude": 14.58
  },
  "MU": {
    "name": "Mauritius",
    "continent": "AF",
    "currency": "MUR",
    "latitude": -20.28,
    "longitude": 57.55
  },
  "MV": {
    "name": "Maldives",
    "continent": "AS",
    "currency": "MVR",
    "latitude": 3.25,
    "longitude": 73
  },
  "MW": {
    "name": "Malawi",
    "continent": "AF",
    "currency": "MWK",
    "latitude": -13.5,
    "longitude": 34
  },
  "MX": {
    "name": "Mexico",
    "continent": "NA",
    "currency": "MXN",
    "latitude": 23,
    "longitude": -102
  },
  "MY": {
    "name": "Malaysia",
    "continent": "AS",
    "currency": "MYR",
    "latitude": 2.5,
    "longitude": 112.5
  },
  "MZ": {
    "name": "Mozambique",
    "continent": "AF",
    "currency": "MZN",
    "latitude": -18.25,
    "longitude": 35
  },
  "NA": {
    "name": "Namibia",
    "continent": "AF",
    "currency": "NAD",
    "latitude": -22,
    "longitude": 17
  },
  "NE": {
    "name": "Niger",
    "continent": "AF",
    "currency": "XOF",
    "latitude": 16,
    "longitude": 8
  },
  "NG": {
    "name": "Nigeria",
    "continent": "AF",
    "currency": "NGN",
    "latitude": 10,
    "longitude": 8
  },
  "NI": {
    "name": "Nicaragua",
    "continent": "NA",
    "currency": "NIO",
    "latitude": 13,
    "longitude": -85
  },
  "NL": {
    "name": "Netherlands",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 52.5,
    "longitude": 5.75
  },
  "NO": {
    "name": "Norway",
    "continent": "EU",
    "currency": "NOK",
    "latitude": 62,
    "longitude": 10
  },
  "NP": {
    "name": "Nepal",
    "continent": "AS",
    "currency": "NPR",
    "latitude": 28,
    "longitude": 84
  },
  "NR": {
    "name": "Nauru",
    "continent": "OC",
    "currency": "AUD",
    "latitude": -0.53,
    "longitude": 166.92
  },
  "NZ": {
    "name": "New Zealand",
    "continent": "OC",
    "currency": "NZD",
    "latitude": -41,
    "longitude": 174
  },
  "OM": {
    "name": "Oman",
    "continent": "AS",
    "currency": "OMR",
    "latitude": 21,
    "longitude": 57
  },
  "PA": {
    "name": "Panama",
    "continent": "NA",
    "currency": "PAB",
    "latitude": 9,
    "longitude": -80
  },
  "PE": {
    "name": "Peru",
    "continent": "SA",
    "currency": "PEN",
    "latitude": -10,
    "longitude": -76
  },
  "PG": {
    "name": "Papua New Guinea",
    "continent": "OC",
    "currency": "PGK",
    "latitude": -6,
    "longitude": 147
  },
  "PH": {
    "name": "Philippines",
    "continent": "AS",
    "currency": "PHP",
    "latitude": 13,
    "longitude": 122
  },
  "PK": {
    "name": "Pakistan",
    "continent": "AS",
    "currency": "PKR",
    "latitude": 30,
    "longitude": 70
  },
  "PL": {
    "name": "Poland",
    "continent": "EU",
    "currency": "PLN",
    "latitude": 52,
    "longitude": 20
  },
  "PS": {
    "name": "Palestine",
    "continent": "AS",
    "currency": "EGP",
    "latitude": 31.9,
    "longitude": 35.2
  },
  "PT": {
    "name": "Portugal",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 39.5,
    "longitude": -8
  },
  "PW": {
    "name": "Palau",
    "continent": "OC",
    "currency": "USD",
    "latitude": 7.5,
    "longitude": 134.5
  },
  "PY": {
    "name": "Paraguay",
    "continent": "SA",
    "currency": "PYG",
    "latitude": -23,
    "longitude": -58
  },
  "QA": {
    "name": "Qatar",
    "continent": "AS",
    "currency": "QAR",
    "latitude": 25.5,
    "longitude": 51.25
  },
  "RO": {
    "name": "Romania",
    "continent": "EU",
    "currency": "RON",
    "latitude": 46,
    "longitude": 25
  },
  "RS": {
    "name": "Serbia",
    "continent": "EU",
    "currency": "RSD",
    "latitude": 44,
    "longitude": 21
  },
  "RU": {
    "name": "Russia",
    "continent": "EU",
    "currency": "RUB",
    "latitude": 60,
    "longitude": 100
  },
  "RW": {
    "name": "Rwanda",
    "continent": "AF",
    "currency": "RWF",
    "latitude": -2,
    "longitude": 30
  },
  "SA": {
    "name": "Saudi Arabia",
    "continent": "AS",
    "currency": "SAR",
    "latitude": 25,
    "longitude": 45
  },
  "SB": {
    "name": "Solomon Islands",
    "continent": "OC",
    "currency": "SBD",
    "latitude": -8,
    "longitude": 159
  },
  "SC": {
    "name": "Seychelles",
    "continent": "AF",
    "currency": "SCR",
    "latitude": -4.58,
    "longitude": 55.67
  },
  "SD": {
    "name": "Sudan",
    "continent": "AF",
    "currency": "SDG",
    "latitude": 15,
    "longitude": 30
  },
  "SE": {
    "name": "Sweden",
    "continent": "EU",
    "currency": "SEK",
    "latitude": 62,
    "longitude": 15
  },
  "SG": {
    "name": "Singapore",
    "continent": "AS",
    "currency": "SGD",
    "latitude": 1.37,
    "longitude": 103.8
  },
  "SI": {
    "name": "Slovenia",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 46,
    "longitude": 15
  },
  "SK": {
    "name": "Slovakia",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 48.67,
    "longitude": 19.5
  },
  "SL": {
    "name": "Sierra Leone",
    "continent": "AF",
    "currency": "SLE",
    "latitude": 8.5,
    "longitude": -11.5
  },
  "SM": {
    "name": "San Marino",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 43.77,
    "longitude": 12.42
  },
  "SN": {
    "name": "Senegal",
    "continent": "AF",
    "currency": "XOF",
    "latitude": 14,
    "longitude": -14
  },
  "SO": {
    "name": "Somalia",
    "continent": "AF",
    "currency": "SOS",
    "latitude": 10,
    "longitude": 49
  },
  "SR": {
    "name": "Suriname",
    "continent": "SA",
    "currency": "SRD",
    "latitude": 4,
    "longitude": -56
  },
  "SS": {
    "name": "South Sudan",
    "continent": "AF",
    "currency": "SSP",
    "latitude": 8,
    "longitude": 30
  },
  "ST": {
    "name": "São Tomé and Príncipe",
    "continent": "AF",
    "currency": "STN",
    "latitude": 1,
    "longitude": 7
  },
  "SV": {
    "name": "El Salvador",
    "continent": "NA",
    "currency": "USD",
    "latitude": 13.83,
    "longitude": -88.92
  },
  "SY": {
    "name": "Syria",
    "continent": "AS",
    "currency": "SYP",
    "latitude": 35,
    "longitude": 38
  },
  "SZ": {
    "name": "Eswatini",
    "continent": "AF",
    "currency": "SZL",
    "latitude": -26.5,
    "longitude": 31.5
  },
  "TD": {
    "name": "Chad",
    "continent": "AF",
    "currency": "XAF",
    "latitude": 15,
    "longitude": 19
  },
  "TG": {
    "name": "Togo",
    "continent": "AF",
    "currency": "XOF",
    "latitude": 8,
    "longitude": 1.17
  },
  "TH": {
    "name": "Thailand",
    "continent": "AS",
    "currency": "THB",
    "latitude": 15,
    "longitude": 100
  },
  "TJ": {
    "name": "Tajikistan",
    "continent": "AS",
    "currency": "TJS",
    "latitude": 39,
    "longitude": 71
  },
  "TL": {
    "name": "Timor-Leste",
    "continent": "AS",
    "currency": "USD",
    "latitude": -8.83,
    "longitude": 125.92
  },
  "TM": {
    "name": "Turkmenistan",
    "continent": "AS",
    "currency": "TMT",
    "latitude": 40,
    "longitude": 60
  },
  "TN": {
    "name": "Tunisia",
    "continent": "AF",
    "currency": "TND",
    "latitude": 34,
    "longitude": 9
  },
  "TO": {
    "name": "Tonga",
    "continent": "OC",
    "currency": "TOP",
    "latitude": -20,
    "longitude": -175
  },
  "TR": {
    "name": "Turkey",
    "continent": "AS",
    "currency": "TRY",
    "latitude": 39,
    "longitude": 35
  },
  "TT": {
    "name": "Trinidad and Tobago",
    "continent": "NA",
    "currency": "TTD",
    "latitude": 11,
    "longitude": -61
  },
  "TV": {
    "name": "Tuvalu",
    "continent": "OC",
    "currency": "AUD",
    "latitude": -8,
    "longitude": 178
  },
  "TW": {
    "name": "Taiwan",
    "continent": "AS",
    "currency": "TWD",
    "latitude": 23.5,
    "longitude": 121
  },
  "TZ": {
    "name": "Tanzania",
    "continent": "AF",
    "currency": "TZS",
    "latitude": -6,
    "longitude": 35
  },
  "UA": {
    "name": "Ukraine",
    "continent": "EU",
    "currency": "UAH",
    "latitude": 49,
    "longitude": 32
  },
  "UG": {
    "name": "Uganda",
    "continent": "AF",
    "currency": "UGX",
    "latitude": 1,
    "longitude": 32
  },
  "US": {
    "name": "United States",
    "continent": "NA",
    "currency": "USD",
    "latitude": 38,
    "longitude": -97
  },
  "UY": {
    "name": "Uruguay",
    "continent": "SA",
    "currency": "UYU",
    "latitude": -33,
    "longitude": -56
  },
  "UZ": {
    "name": "Uzbekistan",
    "continent": "AS",
    "currency": "UZS",
    "latitude": 41,
    "longitude": 64
  },
  "VA": {
    "name": "Vatican City",
    "continent": "EU",
    "currency": "EUR",
    "latitude": 41.9,
    "longitude": 12.45
  },
  "VC": {
    "name": "Saint Vincent and the Grenadines",
    "continent": "NA",
    "currency": "XCD",
    "latitude": 13.25,
    "longitude": -61.2
  },
  "VE": {
    "name": "Venezuela",
    "continent": "SA",
    "currency": "VES",
    "latitude": 8,
    "longitude": -66
  },
  "VN": {
    "name": "Vietnam",
    "continent": "AS",
    "currency": "VND",
    "latitude": 16,
    "longitude": 106
  },
  "VU": {
    "name": "Vanuatu",
    "continent": "OC",
    "currency": "VUV",
    "latitude": -16,
    "longitude": 167
  },
  "WS": {
    "name": "Samoa",
    "continent": "OC",
    "currency": "WST",
    "latitude": -13.58,
    "longitude": -172.33
  },
  "YE": {
    "name": "Yemen",
    "continent": "AS",
    "currency": "YER",
    "latitude": 15,
    "longitude": 48
  },
  "ZA": {
    "name": "South Africa",
    "continent": "AF",
    "currency": "ZAR",
    "latitude": -29,
    "longitude": 24
  },
  "ZM": {
    "name": "Zambia",
    "continent": "AF",
    "currency": "ZMW",
    "latitude": -15,
    "longitude": 30
  },
  "ZW": {
    "name": "Zimbabwe",
    "continent": "AF",
    "currency": "BWP",
    "latitude": -20,
    "longitude": 30
  }
}

/** The seven continents Appwrite reports, in code order. */
export const CONTINENTS: Record<string, ContinentData> = {
  "AF": {
    "name": "Africa",
    "latitude": 8.7832,
    "longitude": 34.5085
  },
  "AN": {
    "name": "Antarctica",
    "latitude": -82.8628,
    "longitude": 135
  },
  "AS": {
    "name": "Asia",
    "latitude": 34.0479,
    "longitude": 100.6197
  },
  "EU": {
    "name": "Europe",
    "latitude": 54.526,
    "longitude": 15.2551
  },
  "NA": {
    "name": "North America",
    "latitude": 54.526,
    "longitude": -105.2551
  },
  "OC": {
    "name": "Oceania",
    "latitude": -22.7359,
    "longitude": 140.0188
  },
  "SA": {
    "name": "South America",
    "latitude": -8.7832,
    "longitude": -55.4915
  }
}

/** ISO 4217 currencies. */
export const CURRENCIES: CurrencyData[] = [
  {
    "symbol": "$",
    "name": "US Dollar",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "USD",
    "namePlural": "US dollars"
  },
  {
    "symbol": "€",
    "name": "Euro",
    "symbolNative": "€",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "EUR",
    "namePlural": "euros"
  },
  {
    "symbol": "£",
    "name": "British Pound Sterling",
    "symbolNative": "£",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "GBP",
    "namePlural": "British pounds sterling"
  },
  {
    "symbol": "CA$",
    "name": "Canadian Dollar",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "CAD",
    "namePlural": "Canadian dollars"
  },
  {
    "symbol": "AED",
    "name": "United Arab Emirates Dirham",
    "symbolNative": "د.إ.‏",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "AED",
    "namePlural": "UAE dirhams"
  },
  {
    "symbol": "Af",
    "name": "Afghan Afghani",
    "symbolNative": "؋",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "AFN",
    "namePlural": "Afghan Afghanis"
  },
  {
    "symbol": "ALL",
    "name": "Albanian Lek",
    "symbolNative": "Lek",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "ALL",
    "namePlural": "Albanian lekë"
  },
  {
    "symbol": "AMD",
    "name": "Armenian Dram",
    "symbolNative": "դր.",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "AMD",
    "namePlural": "Armenian drams"
  },
  {
    "symbol": "AR$",
    "name": "Argentine Peso",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "ARS",
    "namePlural": "Argentine pesos"
  },
  {
    "symbol": "AU$",
    "name": "Australian Dollar",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "AUD",
    "namePlural": "Australian dollars"
  },
  {
    "symbol": "man.",
    "name": "Azerbaijani Manat",
    "symbolNative": "ман.",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "AZN",
    "namePlural": "Azerbaijani manats"
  },
  {
    "symbol": "KM",
    "name": "Bosnia-Herzegovina Convertible Mark",
    "symbolNative": "KM",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "BAM",
    "namePlural": "Bosnia-Herzegovina convertible marks"
  },
  {
    "symbol": "Tk",
    "name": "Bangladeshi Taka",
    "symbolNative": "৳",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "BDT",
    "namePlural": "Bangladeshi takas"
  },
  {
    "symbol": "BGN",
    "name": "Bulgarian Lev",
    "symbolNative": "лв.",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "BGN",
    "namePlural": "Bulgarian leva"
  },
  {
    "symbol": "BD",
    "name": "Bahraini Dinar",
    "symbolNative": "د.ب.‏",
    "decimalDigits": 3,
    "rounding": 0,
    "code": "BHD",
    "namePlural": "Bahraini dinars"
  },
  {
    "symbol": "FBu",
    "name": "Burundian Franc",
    "symbolNative": "FBu",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "BIF",
    "namePlural": "Burundian francs"
  },
  {
    "symbol": "BN$",
    "name": "Brunei Dollar",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "BND",
    "namePlural": "Brunei dollars"
  },
  {
    "symbol": "Bs",
    "name": "Bolivian Boliviano",
    "symbolNative": "Bs",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "BOB",
    "namePlural": "Bolivian bolivianos"
  },
  {
    "symbol": "R$",
    "name": "Brazilian Real",
    "symbolNative": "R$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "BRL",
    "namePlural": "Brazilian reals"
  },
  {
    "symbol": "BWP",
    "name": "Botswanan Pula",
    "symbolNative": "P",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "BWP",
    "namePlural": "Botswanan pulas"
  },
  {
    "symbol": "BYR",
    "name": "Belarusian Ruble",
    "symbolNative": "BYR",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "BYR",
    "namePlural": "Belarusian rubles"
  },
  {
    "symbol": "BZ$",
    "name": "Belize Dollar",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "BZD",
    "namePlural": "Belize dollars"
  },
  {
    "symbol": "CDF",
    "name": "Congolese Franc",
    "symbolNative": "FrCD",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "CDF",
    "namePlural": "Congolese francs"
  },
  {
    "symbol": "CHF",
    "name": "Swiss Franc",
    "symbolNative": "CHF",
    "decimalDigits": 2,
    "rounding": 0.05,
    "code": "CHF",
    "namePlural": "Swiss francs"
  },
  {
    "symbol": "CL$",
    "name": "Chilean Peso",
    "symbolNative": "$",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "CLP",
    "namePlural": "Chilean pesos"
  },
  {
    "symbol": "CN¥",
    "name": "Chinese Yuan",
    "symbolNative": "CN¥",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "CNY",
    "namePlural": "Chinese yuan"
  },
  {
    "symbol": "CO$",
    "name": "Colombian Peso",
    "symbolNative": "$",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "COP",
    "namePlural": "Colombian pesos"
  },
  {
    "symbol": "₡",
    "name": "Costa Rican Colón",
    "symbolNative": "₡",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "CRC",
    "namePlural": "Costa Rican colóns"
  },
  {
    "symbol": "CV$",
    "name": "Cape Verdean Escudo",
    "symbolNative": "CV$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "CVE",
    "namePlural": "Cape Verdean escudos"
  },
  {
    "symbol": "Kč",
    "name": "Czech Republic Koruna",
    "symbolNative": "Kč",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "CZK",
    "namePlural": "Czech Republic korunas"
  },
  {
    "symbol": "Fdj",
    "name": "Djiboutian Franc",
    "symbolNative": "Fdj",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "DJF",
    "namePlural": "Djiboutian francs"
  },
  {
    "symbol": "Dkr",
    "name": "Danish Krone",
    "symbolNative": "kr",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "DKK",
    "namePlural": "Danish kroner"
  },
  {
    "symbol": "RD$",
    "name": "Dominican Peso",
    "symbolNative": "RD$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "DOP",
    "namePlural": "Dominican pesos"
  },
  {
    "symbol": "DA",
    "name": "Algerian Dinar",
    "symbolNative": "د.ج.‏",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "DZD",
    "namePlural": "Algerian dinars"
  },
  {
    "symbol": "Ekr",
    "name": "Estonian Kroon",
    "symbolNative": "kr",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "EEK",
    "namePlural": "Estonian kroons"
  },
  {
    "symbol": "EGP",
    "name": "Egyptian Pound",
    "symbolNative": "ج.م.‏",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "EGP",
    "namePlural": "Egyptian pounds"
  },
  {
    "symbol": "Nfk",
    "name": "Eritrean Nakfa",
    "symbolNative": "Nfk",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "ERN",
    "namePlural": "Eritrean nakfas"
  },
  {
    "symbol": "Br",
    "name": "Ethiopian Birr",
    "symbolNative": "Br",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "ETB",
    "namePlural": "Ethiopian birrs"
  },
  {
    "symbol": "GEL",
    "name": "Georgian Lari",
    "symbolNative": "GEL",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "GEL",
    "namePlural": "Georgian laris"
  },
  {
    "symbol": "GH₵",
    "name": "Ghanaian Cedi",
    "symbolNative": "GH₵",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "GHS",
    "namePlural": "Ghanaian cedis"
  },
  {
    "symbol": "FG",
    "name": "Guinean Franc",
    "symbolNative": "FG",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "GNF",
    "namePlural": "Guinean francs"
  },
  {
    "symbol": "GTQ",
    "name": "Guatemalan Quetzal",
    "symbolNative": "Q",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "GTQ",
    "namePlural": "Guatemalan quetzals"
  },
  {
    "symbol": "HK$",
    "name": "Hong Kong Dollar",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "HKD",
    "namePlural": "Hong Kong dollars"
  },
  {
    "symbol": "HNL",
    "name": "Honduran Lempira",
    "symbolNative": "L",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "HNL",
    "namePlural": "Honduran lempiras"
  },
  {
    "symbol": "kn",
    "name": "Croatian Kuna",
    "symbolNative": "kn",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "HRK",
    "namePlural": "Croatian kunas"
  },
  {
    "symbol": "Ft",
    "name": "Hungarian Forint",
    "symbolNative": "Ft",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "HUF",
    "namePlural": "Hungarian forints"
  },
  {
    "symbol": "Rp",
    "name": "Indonesian Rupiah",
    "symbolNative": "Rp",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "IDR",
    "namePlural": "Indonesian rupiahs"
  },
  {
    "symbol": "₪",
    "name": "Israeli New Sheqel",
    "symbolNative": "₪",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "ILS",
    "namePlural": "Israeli new sheqels"
  },
  {
    "symbol": "Rs",
    "name": "Indian Rupee",
    "symbolNative": "₹",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "INR",
    "namePlural": "Indian Rupees"
  },
  {
    "symbol": "IQD",
    "name": "Iraqi Dinar",
    "symbolNative": "د.ع.‏",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "IQD",
    "namePlural": "Iraqi dinars"
  },
  {
    "symbol": "IRR",
    "name": "Iranian Rial",
    "symbolNative": "﷼",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "IRR",
    "namePlural": "Iranian rials"
  },
  {
    "symbol": "Ikr",
    "name": "Icelandic Króna",
    "symbolNative": "kr",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "ISK",
    "namePlural": "Icelandic krónur"
  },
  {
    "symbol": "J$",
    "name": "Jamaican Dollar",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "JMD",
    "namePlural": "Jamaican dollars"
  },
  {
    "symbol": "JD",
    "name": "Jordanian Dinar",
    "symbolNative": "د.أ.‏",
    "decimalDigits": 3,
    "rounding": 0,
    "code": "JOD",
    "namePlural": "Jordanian dinars"
  },
  {
    "symbol": "¥",
    "name": "Japanese Yen",
    "symbolNative": "￥",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "JPY",
    "namePlural": "Japanese yen"
  },
  {
    "symbol": "Ksh",
    "name": "Kenyan Shilling",
    "symbolNative": "Ksh",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "KES",
    "namePlural": "Kenyan shillings"
  },
  {
    "symbol": "KHR",
    "name": "Cambodian Riel",
    "symbolNative": "៛",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "KHR",
    "namePlural": "Cambodian riels"
  },
  {
    "symbol": "CF",
    "name": "Comorian Franc",
    "symbolNative": "FC",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "KMF",
    "namePlural": "Comorian francs"
  },
  {
    "symbol": "₩",
    "name": "South Korean Won",
    "symbolNative": "₩",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "KRW",
    "namePlural": "South Korean won"
  },
  {
    "symbol": "KD",
    "name": "Kuwaiti Dinar",
    "symbolNative": "د.ك.‏",
    "decimalDigits": 3,
    "rounding": 0,
    "code": "KWD",
    "namePlural": "Kuwaiti dinars"
  },
  {
    "symbol": "KZT",
    "name": "Kazakhstani Tenge",
    "symbolNative": "тңг.",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "KZT",
    "namePlural": "Kazakhstani tenges"
  },
  {
    "symbol": "SLRs",
    "name": "Sri Lankan Rupee",
    "symbolNative": "SL Re",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "LKR",
    "namePlural": "Sri Lankan rupees"
  },
  {
    "symbol": "Lt",
    "name": "Lithuanian Litas",
    "symbolNative": "Lt",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "LTL",
    "namePlural": "Lithuanian litai"
  },
  {
    "symbol": "Ls",
    "name": "Latvian Lats",
    "symbolNative": "Ls",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "LVL",
    "namePlural": "Latvian lati"
  },
  {
    "symbol": "LD",
    "name": "Libyan Dinar",
    "symbolNative": "د.ل.‏",
    "decimalDigits": 3,
    "rounding": 0,
    "code": "LYD",
    "namePlural": "Libyan dinars"
  },
  {
    "symbol": "MAD",
    "name": "Moroccan Dirham",
    "symbolNative": "د.م.‏",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "MAD",
    "namePlural": "Moroccan dirhams"
  },
  {
    "symbol": "MDL",
    "name": "Moldovan Leu",
    "symbolNative": "MDL",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "MDL",
    "namePlural": "Moldovan lei"
  },
  {
    "symbol": "MGA",
    "name": "Malagasy Ariary",
    "symbolNative": "MGA",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "MGA",
    "namePlural": "Malagasy Ariaries"
  },
  {
    "symbol": "MKD",
    "name": "Macedonian Denar",
    "symbolNative": "MKD",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "MKD",
    "namePlural": "Macedonian denari"
  },
  {
    "symbol": "MMK",
    "name": "Myanma Kyat",
    "symbolNative": "K",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "MMK",
    "namePlural": "Myanma kyats"
  },
  {
    "symbol": "MOP$",
    "name": "Macanese Pataca",
    "symbolNative": "MOP$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "MOP",
    "namePlural": "Macanese patacas"
  },
  {
    "symbol": "MURs",
    "name": "Mauritian Rupee",
    "symbolNative": "MURs",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "MUR",
    "namePlural": "Mauritian rupees"
  },
  {
    "symbol": "MX$",
    "name": "Mexican Peso",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "MXN",
    "namePlural": "Mexican pesos"
  },
  {
    "symbol": "RM",
    "name": "Malaysian Ringgit",
    "symbolNative": "RM",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "MYR",
    "namePlural": "Malaysian ringgits"
  },
  {
    "symbol": "MTn",
    "name": "Mozambican Metical",
    "symbolNative": "MTn",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "MZN",
    "namePlural": "Mozambican meticals"
  },
  {
    "symbol": "N$",
    "name": "Namibian Dollar",
    "symbolNative": "N$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "NAD",
    "namePlural": "Namibian dollars"
  },
  {
    "symbol": "₦",
    "name": "Nigerian Naira",
    "symbolNative": "₦",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "NGN",
    "namePlural": "Nigerian nairas"
  },
  {
    "symbol": "C$",
    "name": "Nicaraguan Córdoba",
    "symbolNative": "C$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "NIO",
    "namePlural": "Nicaraguan córdobas"
  },
  {
    "symbol": "Nkr",
    "name": "Norwegian Krone",
    "symbolNative": "kr",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "NOK",
    "namePlural": "Norwegian kroner"
  },
  {
    "symbol": "NPRs",
    "name": "Nepalese Rupee",
    "symbolNative": "नेरू",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "NPR",
    "namePlural": "Nepalese rupees"
  },
  {
    "symbol": "NZ$",
    "name": "New Zealand Dollar",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "NZD",
    "namePlural": "New Zealand dollars"
  },
  {
    "symbol": "OMR",
    "name": "Omani Rial",
    "symbolNative": "ر.ع.‏",
    "decimalDigits": 3,
    "rounding": 0,
    "code": "OMR",
    "namePlural": "Omani rials"
  },
  {
    "symbol": "B/.",
    "name": "Panamanian Balboa",
    "symbolNative": "B/.",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "PAB",
    "namePlural": "Panamanian balboas"
  },
  {
    "symbol": "S/.",
    "name": "Peruvian Nuevo Sol",
    "symbolNative": "S/.",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "PEN",
    "namePlural": "Peruvian nuevos soles"
  },
  {
    "symbol": "₱",
    "name": "Philippine Peso",
    "symbolNative": "₱",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "PHP",
    "namePlural": "Philippine pesos"
  },
  {
    "symbol": "PKRs",
    "name": "Pakistani Rupee",
    "symbolNative": "₨",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "PKR",
    "namePlural": "Pakistani rupees"
  },
  {
    "symbol": "zł",
    "name": "Polski Złoty",
    "symbolNative": "zł",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "PLN",
    "namePlural": "Polish zlotych"
  },
  {
    "symbol": "₲",
    "name": "Paraguayan Guarani",
    "symbolNative": "₲",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "PYG",
    "namePlural": "Paraguayan guaranis"
  },
  {
    "symbol": "QR",
    "name": "Qatari Rial",
    "symbolNative": "ر.ق.‏",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "QAR",
    "namePlural": "Qatari rials"
  },
  {
    "symbol": "RON",
    "name": "Romanian Leu",
    "symbolNative": "RON",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "RON",
    "namePlural": "Romanian lei"
  },
  {
    "symbol": "din.",
    "name": "Serbian Dinar",
    "symbolNative": "дин.",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "RSD",
    "namePlural": "Serbian dinars"
  },
  {
    "symbol": "RUB",
    "name": "Russian Ruble",
    "symbolNative": "руб.",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "RUB",
    "namePlural": "Russian rubles"
  },
  {
    "symbol": "RWF",
    "name": "Rwandan Franc",
    "symbolNative": "FR",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "RWF",
    "namePlural": "Rwandan francs"
  },
  {
    "symbol": "SR",
    "name": "Saudi Riyal",
    "symbolNative": "ر.س.‏",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "SAR",
    "namePlural": "Saudi riyals"
  },
  {
    "symbol": "SDG",
    "name": "Sudanese Pound",
    "symbolNative": "SDG",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "SDG",
    "namePlural": "Sudanese pounds"
  },
  {
    "symbol": "Skr",
    "name": "Swedish Krona",
    "symbolNative": "kr",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "SEK",
    "namePlural": "Swedish kronor"
  },
  {
    "symbol": "S$",
    "name": "Singapore Dollar",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "SGD",
    "namePlural": "Singapore dollars"
  },
  {
    "symbol": "Ssh",
    "name": "Somali Shilling",
    "symbolNative": "Ssh",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "SOS",
    "namePlural": "Somali shillings"
  },
  {
    "symbol": "SY£",
    "name": "Syrian Pound",
    "symbolNative": "ل.س.‏",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "SYP",
    "namePlural": "Syrian pounds"
  },
  {
    "symbol": "฿",
    "name": "Thai Baht",
    "symbolNative": "฿",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "THB",
    "namePlural": "Thai baht"
  },
  {
    "symbol": "DT",
    "name": "Tunisian Dinar",
    "symbolNative": "د.ت.‏",
    "decimalDigits": 3,
    "rounding": 0,
    "code": "TND",
    "namePlural": "Tunisian dinars"
  },
  {
    "symbol": "T$",
    "name": "Tongan Paʻanga",
    "symbolNative": "T$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "TOP",
    "namePlural": "Tongan paʻanga"
  },
  {
    "symbol": "TL",
    "name": "Turkish Lira",
    "symbolNative": "TL",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "TRY",
    "namePlural": "Turkish Lira"
  },
  {
    "symbol": "TT$",
    "name": "Trinidad and Tobago Dollar",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "TTD",
    "namePlural": "Trinidad and Tobago dollars"
  },
  {
    "symbol": "NT$",
    "name": "New Taiwan Dollar",
    "symbolNative": "NT$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "TWD",
    "namePlural": "New Taiwan dollars"
  },
  {
    "symbol": "TSh",
    "name": "Tanzanian Shilling",
    "symbolNative": "TSh",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "TZS",
    "namePlural": "Tanzanian shillings"
  },
  {
    "symbol": "₴",
    "name": "Ukrainian Hryvnia",
    "symbolNative": "₴",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "UAH",
    "namePlural": "Ukrainian hryvnias"
  },
  {
    "symbol": "USh",
    "name": "Ugandan Shilling",
    "symbolNative": "USh",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "UGX",
    "namePlural": "Ugandan shillings"
  },
  {
    "symbol": "$U",
    "name": "Uruguayan Peso",
    "symbolNative": "$",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "UYU",
    "namePlural": "Uruguayan pesos"
  },
  {
    "symbol": "UZS",
    "name": "Uzbekistan Som",
    "symbolNative": "UZS",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "UZS",
    "namePlural": "Uzbekistan som"
  },
  {
    "symbol": "Bs.F.",
    "name": "Venezuelan Bolívar",
    "symbolNative": "Bs.F.",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "VEF",
    "namePlural": "Venezuelan bolívars"
  },
  {
    "symbol": "₫",
    "name": "Vietnamese Dong",
    "symbolNative": "₫",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "VND",
    "namePlural": "Vietnamese dong"
  },
  {
    "symbol": "FCFA",
    "name": "CFA Franc BEAC",
    "symbolNative": "FCFA",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "XAF",
    "namePlural": "CFA francs BEAC"
  },
  {
    "symbol": "CFA",
    "name": "CFA Franc BCEAO",
    "symbolNative": "CFA",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "XOF",
    "namePlural": "CFA francs BCEAO"
  },
  {
    "symbol": "YR",
    "name": "Yemeni Rial",
    "symbolNative": "ر.ي.‏",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "YER",
    "namePlural": "Yemeni rials"
  },
  {
    "symbol": "R",
    "name": "South African Rand",
    "symbolNative": "R",
    "decimalDigits": 2,
    "rounding": 0,
    "code": "ZAR",
    "namePlural": "South African rand"
  },
  {
    "symbol": "ZK",
    "name": "Zambian Kwacha",
    "symbolNative": "ZK",
    "decimalDigits": 0,
    "rounding": 0,
    "code": "ZMK",
    "namePlural": "Zambian kwachas"
  }
]

/** ISO 639-1 languages. */
export const LANGUAGES: LanguageData[] = [
  {
    "code": "aa",
    "name": "Afar",
    "nativeName": "Afar"
  },
  {
    "code": "ab",
    "name": "Abkhazian",
    "nativeName": "Аҧсуа"
  },
  {
    "code": "af",
    "name": "Afrikaans",
    "nativeName": "Afrikaans"
  },
  {
    "code": "ak",
    "name": "Akan",
    "nativeName": "Akana"
  },
  {
    "code": "am",
    "name": "Amharic",
    "nativeName": "አማርኛ"
  },
  {
    "code": "an",
    "name": "Aragonese",
    "nativeName": "Aragonés"
  },
  {
    "code": "ar",
    "name": "Arabic",
    "nativeName": "العربية"
  },
  {
    "code": "as",
    "name": "Assamese",
    "nativeName": "অসমীয়া"
  },
  {
    "code": "av",
    "name": "Avar",
    "nativeName": "Авар"
  },
  {
    "code": "ay",
    "name": "Aymara",
    "nativeName": "Aymar"
  },
  {
    "code": "az",
    "name": "Azerbaijani",
    "nativeName": "Azərbaycanca / آذربايجان"
  },
  {
    "code": "ba",
    "name": "Bashkir",
    "nativeName": "Башҡорт"
  },
  {
    "code": "be",
    "name": "Belarusian",
    "nativeName": "Беларуская"
  },
  {
    "code": "bg",
    "name": "Bulgarian",
    "nativeName": "Български"
  },
  {
    "code": "bh",
    "name": "Bihari",
    "nativeName": "भोजपुरी"
  },
  {
    "code": "bi",
    "name": "Bislama",
    "nativeName": "Bislama"
  },
  {
    "code": "bm",
    "name": "Bambara",
    "nativeName": "Bamanankan"
  },
  {
    "code": "bn",
    "name": "Bengali",
    "nativeName": "বাংলা"
  },
  {
    "code": "bo",
    "name": "Tibetan",
    "nativeName": "བོད་ཡིག / Bod skad"
  },
  {
    "code": "br",
    "name": "Breton",
    "nativeName": "Brezhoneg"
  },
  {
    "code": "bs",
    "name": "Bosnian",
    "nativeName": "Bosanski"
  },
  {
    "code": "ca",
    "name": "Catalan",
    "nativeName": "Català"
  },
  {
    "code": "ce",
    "name": "Chechen",
    "nativeName": "Нохчийн"
  },
  {
    "code": "ch",
    "name": "Chamorro",
    "nativeName": "Chamoru"
  },
  {
    "code": "co",
    "name": "Corsican",
    "nativeName": "Corsu"
  },
  {
    "code": "cr",
    "name": "Cree",
    "nativeName": "Nehiyaw"
  },
  {
    "code": "cs",
    "name": "Czech",
    "nativeName": "Česky"
  },
  {
    "code": "cu",
    "name": "Old Church Slavonic / Old Bulgarian",
    "nativeName": "словѣньскъ / slověnĭskŭ"
  },
  {
    "code": "cv",
    "name": "Chuvash",
    "nativeName": "Чăваш"
  },
  {
    "code": "cy",
    "name": "Welsh",
    "nativeName": "Cymraeg"
  },
  {
    "code": "da",
    "name": "Danish",
    "nativeName": "Dansk"
  },
  {
    "code": "de",
    "name": "German",
    "nativeName": "Deutsch"
  },
  {
    "code": "dv",
    "name": "Divehi",
    "nativeName": "ދިވެހިބަސް"
  },
  {
    "code": "dz",
    "name": "Dzongkha",
    "nativeName": "ཇོང་ཁ"
  },
  {
    "code": "ee",
    "name": "Ewe",
    "nativeName": "Ɛʋɛ"
  },
  {
    "code": "el",
    "name": "Greek",
    "nativeName": "Ελληνικά"
  },
  {
    "code": "en",
    "name": "English",
    "nativeName": "English"
  },
  {
    "code": "eo",
    "name": "Esperanto",
    "nativeName": "Esperanto"
  },
  {
    "code": "es",
    "name": "Spanish",
    "nativeName": "Español"
  },
  {
    "code": "et",
    "name": "Estonian",
    "nativeName": "Eesti"
  },
  {
    "code": "eu",
    "name": "Basque",
    "nativeName": "Euskara"
  },
  {
    "code": "fa",
    "name": "Persian",
    "nativeName": "فارسی"
  },
  {
    "code": "ff",
    "name": "Peul",
    "nativeName": "Fulfulde"
  },
  {
    "code": "fi",
    "name": "Finnish",
    "nativeName": "Suomi"
  },
  {
    "code": "fj",
    "name": "Fijian",
    "nativeName": "Na Vosa Vakaviti"
  },
  {
    "code": "fo",
    "name": "Faroese",
    "nativeName": "Føroyskt"
  },
  {
    "code": "fr",
    "name": "French",
    "nativeName": "Français"
  },
  {
    "code": "fy",
    "name": "West Frisian",
    "nativeName": "Frysk"
  },
  {
    "code": "ga",
    "name": "Irish",
    "nativeName": "Gaeilge"
  },
  {
    "code": "gd",
    "name": "Scottish Gaelic",
    "nativeName": "Gàidhlig"
  },
  {
    "code": "gl",
    "name": "Galician",
    "nativeName": "Galego"
  },
  {
    "code": "gn",
    "name": "Guarani",
    "nativeName": "Avañe'ẽ"
  },
  {
    "code": "gu",
    "name": "Gujarati",
    "nativeName": "ગુજરાતી"
  },
  {
    "code": "gv",
    "name": "Manx",
    "nativeName": "Gaelg"
  },
  {
    "code": "ha",
    "name": "Hausa",
    "nativeName": "هَوُسَ"
  },
  {
    "code": "he",
    "name": "Hebrew",
    "nativeName": "עברית"
  },
  {
    "code": "hi",
    "name": "Hindi",
    "nativeName": "हिन्दी / हिंदी "
  },
  {
    "code": "ho",
    "name": "Hiri Motu",
    "nativeName": "Hiri Motu"
  },
  {
    "code": "hr",
    "name": "Croatian",
    "nativeName": "Hrvatski"
  },
  {
    "code": "ht",
    "name": "Haitian",
    "nativeName": "Krèyol ayisyen"
  },
  {
    "code": "hu",
    "name": "Hungarian",
    "nativeName": "Magyar"
  },
  {
    "code": "hy",
    "name": "Armenian",
    "nativeName": "Հայերեն"
  },
  {
    "code": "hz",
    "name": "Herero",
    "nativeName": "Otsiherero"
  },
  {
    "code": "ia",
    "name": "Interlingua",
    "nativeName": "Interlingua"
  },
  {
    "code": "id",
    "name": "Indonesian",
    "nativeName": "Bahasa Indonesia"
  },
  {
    "code": "ie",
    "name": "Interlingue",
    "nativeName": "Interlingue"
  },
  {
    "code": "ig",
    "name": "Igbo",
    "nativeName": "Igbo"
  },
  {
    "code": "ii",
    "name": "Sichuan Yi",
    "nativeName": "ꆇꉙ / 四川彝语"
  },
  {
    "code": "ik",
    "name": "Inupiak",
    "nativeName": "Iñupiak"
  },
  {
    "code": "io",
    "name": "Ido",
    "nativeName": "Ido"
  },
  {
    "code": "is",
    "name": "Icelandic",
    "nativeName": "Íslenska"
  },
  {
    "code": "it",
    "name": "Italian",
    "nativeName": "Italiano"
  },
  {
    "code": "iu",
    "name": "Inuktitut",
    "nativeName": "ᐃᓄᒃᑎᑐᑦ"
  },
  {
    "code": "ja",
    "name": "Japanese",
    "nativeName": "日本語"
  },
  {
    "code": "jv",
    "name": "Javanese",
    "nativeName": "Basa Jawa"
  },
  {
    "code": "ka",
    "name": "Georgian",
    "nativeName": "ქართული"
  },
  {
    "code": "kg",
    "name": "Kongo",
    "nativeName": "KiKongo"
  },
  {
    "code": "ki",
    "name": "Kikuyu",
    "nativeName": "Gĩkũyũ"
  },
  {
    "code": "kj",
    "name": "Kuanyama",
    "nativeName": "Kuanyama"
  },
  {
    "code": "kk",
    "name": "Kazakh",
    "nativeName": "Қазақша"
  },
  {
    "code": "kl",
    "name": "Greenlandic",
    "nativeName": "Kalaallisut"
  },
  {
    "code": "km",
    "name": "Khmer",
    "nativeName": "ភាសាខ្មែរ"
  },
  {
    "code": "kn",
    "name": "Kannada",
    "nativeName": "ಕನ್ನಡ"
  },
  {
    "code": "ko",
    "name": "Korean",
    "nativeName": "한국어"
  },
  {
    "code": "kr",
    "name": "Kanuri",
    "nativeName": "Kanuri"
  },
  {
    "code": "ks",
    "name": "Kashmiri",
    "nativeName": "कश्मीरी / كشميري"
  },
  {
    "code": "ku",
    "name": "Kurdish",
    "nativeName": "Kurdî / كوردی"
  },
  {
    "code": "kv",
    "name": "Komi",
    "nativeName": "Коми"
  },
  {
    "code": "kw",
    "name": "Cornish",
    "nativeName": "Kernewek"
  },
  {
    "code": "ky",
    "name": "Kirghiz",
    "nativeName": "Kırgızca / Кыргызча"
  },
  {
    "code": "la",
    "name": "Latin",
    "nativeName": "Latina"
  },
  {
    "code": "lb",
    "name": "Luxembourgish",
    "nativeName": "Lëtzebuergesch"
  },
  {
    "code": "lg",
    "name": "Ganda",
    "nativeName": "Luganda"
  },
  {
    "code": "li",
    "name": "Limburgian",
    "nativeName": "Limburgs"
  },
  {
    "code": "ln",
    "name": "Lingala",
    "nativeName": "Lingála"
  },
  {
    "code": "lo",
    "name": "Laotian",
    "nativeName": "ລາວ / Pha xa lao"
  },
  {
    "code": "lt",
    "name": "Lithuanian",
    "nativeName": "Lietuvių"
  },
  {
    "code": "lu",
    "name": "Luba-Katanga",
    "nativeName": "Tshiluba"
  },
  {
    "code": "lv",
    "name": "Latvian",
    "nativeName": "Latviešu"
  },
  {
    "code": "mg",
    "name": "Malagasy",
    "nativeName": "Malagasy"
  },
  {
    "code": "mh",
    "name": "Marshallese",
    "nativeName": "Kajin Majel / Ebon"
  },
  {
    "code": "mi",
    "name": "Maori",
    "nativeName": "Māori"
  },
  {
    "code": "mk",
    "name": "Macedonian",
    "nativeName": "Македонски"
  },
  {
    "code": "ml",
    "name": "Malayalam",
    "nativeName": "മലയാളം"
  },
  {
    "code": "mn",
    "name": "Mongolian",
    "nativeName": "Монгол"
  },
  {
    "code": "mo",
    "name": "Moldovan",
    "nativeName": "Moldovenească"
  },
  {
    "code": "mr",
    "name": "Marathi",
    "nativeName": "मराठी"
  },
  {
    "code": "ms",
    "name": "Malay",
    "nativeName": "Bahasa Melayu"
  },
  {
    "code": "mt",
    "name": "Maltese",
    "nativeName": "bil-Malti"
  },
  {
    "code": "my",
    "name": "Burmese",
    "nativeName": "မြန်မာစာ"
  },
  {
    "code": "na",
    "name": "Nauruan",
    "nativeName": "Dorerin Naoero"
  },
  {
    "code": "nb",
    "name": "Norwegian Bokmål",
    "nativeName": "Norsk bokmål"
  },
  {
    "code": "nd",
    "name": "North Ndebele",
    "nativeName": "Sindebele"
  },
  {
    "code": "ne",
    "name": "Nepali",
    "nativeName": "नेपाली"
  },
  {
    "code": "ng",
    "name": "Ndonga",
    "nativeName": "Oshiwambo"
  },
  {
    "code": "nl",
    "name": "Dutch",
    "nativeName": "Nederlands"
  },
  {
    "code": "nn",
    "name": "Norwegian Nynorsk",
    "nativeName": "Norsk nynorsk"
  },
  {
    "code": "nr",
    "name": "South Ndebele",
    "nativeName": "isiNdebele"
  },
  {
    "code": "nv",
    "name": "Navajo",
    "nativeName": "Diné bizaad"
  },
  {
    "code": "ny",
    "name": "Chichewa",
    "nativeName": "Chi-Chewa"
  },
  {
    "code": "oc",
    "name": "Occitan",
    "nativeName": "Occitan"
  },
  {
    "code": "oj",
    "name": "Ojibwa",
    "nativeName": "ᐊᓂᔑᓈᐯᒧᐎᓐ / Anishinaabemowin"
  },
  {
    "code": "om",
    "name": "Oromo",
    "nativeName": "Oromoo"
  },
  {
    "code": "or",
    "name": "Oriya",
    "nativeName": "ଓଡ଼ିଆ"
  },
  {
    "code": "os",
    "name": "Ossetian / Ossetic",
    "nativeName": "Иронау"
  },
  {
    "code": "pa",
    "name": "Panjabi / Punjabi",
    "nativeName": "ਪੰਜਾਬੀ / पंजाबी / پنجابي"
  },
  {
    "code": "pi",
    "name": "Pali",
    "nativeName": "Pāli / पाऴि"
  },
  {
    "code": "pl",
    "name": "Polish",
    "nativeName": "Polski"
  },
  {
    "code": "ps",
    "name": "Pashto",
    "nativeName": "پښتو"
  },
  {
    "code": "pt-pt",
    "name": "Portuguese",
    "nativeName": "Português"
  },
  {
    "code": "pt-br",
    "name": "Portuguese (Brazilian)",
    "nativeName": "Português"
  },
  {
    "code": "qu",
    "name": "Quechua",
    "nativeName": "Runa Simi"
  },
  {
    "code": "rm",
    "name": "Raeto Romance",
    "nativeName": "Rumantsch"
  },
  {
    "code": "rn",
    "name": "Kirundi",
    "nativeName": "Kirundi"
  },
  {
    "code": "ro",
    "name": "Romanian",
    "nativeName": "Română"
  },
  {
    "code": "ru",
    "name": "Russian",
    "nativeName": "Русский"
  },
  {
    "code": "rw",
    "name": "Rwandi",
    "nativeName": "Kinyarwandi"
  },
  {
    "code": "sa",
    "name": "Sanskrit",
    "nativeName": "संस्कृतम्"
  },
  {
    "code": "sc",
    "name": "Sardinian",
    "nativeName": "Sardu"
  },
  {
    "code": "sd",
    "name": "Sindhi",
    "nativeName": "सिन्धी / सिंधी "
  },
  {
    "code": "se",
    "name": "Northern Sami",
    "nativeName": "Sámegiella"
  },
  {
    "code": "sg",
    "name": "Sango",
    "nativeName": "Sängö"
  },
  {
    "code": "sh",
    "name": "Serbo-Croatian",
    "nativeName": "Srpskohrvatski / Српскохрватски"
  },
  {
    "code": "si",
    "name": "Sinhalese",
    "nativeName": "සිංහල"
  },
  {
    "code": "sk",
    "name": "Slovak",
    "nativeName": "Slovenčina"
  },
  {
    "code": "sl",
    "name": "Slovenian",
    "nativeName": "Slovenščina"
  },
  {
    "code": "sm",
    "name": "Samoan",
    "nativeName": "Gagana Samoa"
  },
  {
    "code": "sn",
    "name": "Shona",
    "nativeName": "chiShona"
  },
  {
    "code": "so",
    "name": "Somalia",
    "nativeName": "Soomaaliga"
  },
  {
    "code": "sq",
    "name": "Albanian",
    "nativeName": "Shqip"
  },
  {
    "code": "sr",
    "name": "Serbian",
    "nativeName": "Српски"
  },
  {
    "code": "ss",
    "name": "Swati",
    "nativeName": "SiSwati"
  },
  {
    "code": "st",
    "name": "Southern Sotho",
    "nativeName": "Sesotho"
  },
  {
    "code": "su",
    "name": "Sundanese",
    "nativeName": "Basa Sunda"
  },
  {
    "code": "sv",
    "name": "Swedish",
    "nativeName": "Svenska"
  },
  {
    "code": "sw",
    "name": "Swahili",
    "nativeName": "Kiswahili"
  },
  {
    "code": "ta",
    "name": "Tamil",
    "nativeName": "தமிழ்"
  },
  {
    "code": "te",
    "name": "Telugu",
    "nativeName": "తెలుగు"
  },
  {
    "code": "tg",
    "name": "Tajik",
    "nativeName": "Тоҷикӣ"
  },
  {
    "code": "th",
    "name": "Thai",
    "nativeName": "ไทย / Phasa Thai"
  },
  {
    "code": "ti",
    "name": "Tigrinya",
    "nativeName": "ትግርኛ"
  },
  {
    "code": "tk",
    "name": "Turkmen",
    "nativeName": "Туркмен / تركمن"
  },
  {
    "code": "tl",
    "name": "Tagalog / Filipino",
    "nativeName": "Tagalog"
  },
  {
    "code": "tn",
    "name": "Tswana",
    "nativeName": "Setswana"
  },
  {
    "code": "to",
    "name": "Tonga",
    "nativeName": "Lea Faka-Tonga"
  },
  {
    "code": "tr",
    "name": "Turkish",
    "nativeName": "Türkçe"
  },
  {
    "code": "ts",
    "name": "Tsonga",
    "nativeName": "Xitsonga"
  },
  {
    "code": "tt",
    "name": "Tatar",
    "nativeName": "Tatarça"
  },
  {
    "code": "tw",
    "name": "Twi",
    "nativeName": "Twi"
  },
  {
    "code": "ty",
    "name": "Tahitian",
    "nativeName": "Reo Mā`ohi"
  },
  {
    "code": "ug",
    "name": "Uyghur",
    "nativeName": "Uyƣurqə / ئۇيغۇرچە"
  },
  {
    "code": "uk",
    "name": "Ukrainian",
    "nativeName": "Українська"
  },
  {
    "code": "ur",
    "name": "Urdu",
    "nativeName": "اردو"
  },
  {
    "code": "uz",
    "name": "Uzbek",
    "nativeName": "Ўзбек"
  },
  {
    "code": "ve",
    "name": "Venda",
    "nativeName": "Tshivenḓa"
  },
  {
    "code": "vi",
    "name": "Vietnamese",
    "nativeName": "Tiếng Việt"
  },
  {
    "code": "vo",
    "name": "Volapük",
    "nativeName": "Volapük"
  },
  {
    "code": "wa",
    "name": "Walloon",
    "nativeName": "Walon"
  },
  {
    "code": "wo",
    "name": "Wolof",
    "nativeName": "Wollof"
  },
  {
    "code": "xh",
    "name": "Xhosa",
    "nativeName": "isiXhosa"
  },
  {
    "code": "yi",
    "name": "Yiddish",
    "nativeName": "ייִדיש"
  },
  {
    "code": "yo",
    "name": "Yoruba",
    "nativeName": "Yorùbá"
  },
  {
    "code": "za",
    "name": "Zhuang",
    "nativeName": "Cuengh / Tôô / 壮语"
  },
  {
    "code": "zh-cn",
    "name": "Chinese (Simplified)",
    "nativeName": "中文"
  },
  {
    "code": "zh-tw",
    "name": "Chinese (Traditional)",
    "nativeName": "中文"
  },
  {
    "code": "zu",
    "name": "Zulu",
    "nativeName": "isiZulu"
  }
]

/** Locale codes accepted by email templates and the X-Appwrite-Locale header. */
export const LOCALE_CODES: LocaleCodeData[] = [
  {
    "code": "af",
    "name": "Afrikaans"
  },
  {
    "code": "ar-ae",
    "name": "Arabic (U.A.E.)"
  },
  {
    "code": "ar-bh",
    "name": "Arabic (Bahrain)"
  },
  {
    "code": "ar-dz",
    "name": "Arabic (Algeria)"
  },
  {
    "code": "ar-eg",
    "name": "Arabic (Egypt)"
  },
  {
    "code": "ar-iq",
    "name": "Arabic (Iraq)"
  },
  {
    "code": "ar-jo",
    "name": "Arabic (Jordan)"
  },
  {
    "code": "ar-kw",
    "name": "Arabic (Kuwait)"
  },
  {
    "code": "ar-lb",
    "name": "Arabic (Lebanon)"
  },
  {
    "code": "ar-ly",
    "name": "Arabic (Libya)"
  },
  {
    "code": "ar-ma",
    "name": "Arabic (Morocco)"
  },
  {
    "code": "ar-om",
    "name": "Arabic (Oman)"
  },
  {
    "code": "ar-qa",
    "name": "Arabic (Qatar)"
  },
  {
    "code": "ar-sa",
    "name": "Arabic (Saudi Arabia)"
  },
  {
    "code": "ar-sy",
    "name": "Arabic (Syria)"
  },
  {
    "code": "ar-tn",
    "name": "Arabic (Tunisia)"
  },
  {
    "code": "ar-ye",
    "name": "Arabic (Yemen)"
  },
  {
    "code": "as",
    "name": "Assamese"
  },
  {
    "code": "az",
    "name": "Azerbaijani"
  },
  {
    "code": "be",
    "name": "Belarusian"
  },
  {
    "code": "bg",
    "name": "Bulgarian"
  },
  {
    "code": "bh",
    "name": "Bihari"
  },
  {
    "code": "bn",
    "name": "Bengali"
  },
  {
    "code": "bs",
    "name": "Bosnian"
  },
  {
    "code": "ca",
    "name": "Catalan"
  },
  {
    "code": "cs",
    "name": "Czech"
  },
  {
    "code": "cy",
    "name": "Welsh"
  },
  {
    "code": "da",
    "name": "Danish"
  },
  {
    "code": "de",
    "name": "German (Standard)"
  },
  {
    "code": "de-at",
    "name": "German (Austria)"
  },
  {
    "code": "de-ch",
    "name": "German (Switzerland)"
  },
  {
    "code": "de-li",
    "name": "German (Liechtenstein)"
  },
  {
    "code": "de-lu",
    "name": "German (Luxembourg)"
  },
  {
    "code": "el",
    "name": "Greek"
  },
  {
    "code": "en",
    "name": "English"
  },
  {
    "code": "en-au",
    "name": "English (Australia)"
  },
  {
    "code": "en-bz",
    "name": "English (Belize)"
  },
  {
    "code": "en-ca",
    "name": "English (Canada)"
  },
  {
    "code": "en-gb",
    "name": "English (United Kingdom)"
  },
  {
    "code": "en-ie",
    "name": "English (Ireland)"
  },
  {
    "code": "en-jm",
    "name": "English (Jamaica)"
  },
  {
    "code": "en-nz",
    "name": "English (New Zealand)"
  },
  {
    "code": "en-tt",
    "name": "English (Trinidad)"
  },
  {
    "code": "en-us",
    "name": "English (United States)"
  },
  {
    "code": "en-za",
    "name": "English (South Africa)"
  },
  {
    "code": "eo",
    "name": "Esperanto"
  },
  {
    "code": "es",
    "name": "Spanish (Spain)"
  },
  {
    "code": "es-ar",
    "name": "Spanish (Argentina)"
  },
  {
    "code": "es-bo",
    "name": "Spanish (Bolivia)"
  },
  {
    "code": "es-cl",
    "name": "Spanish (Chile)"
  },
  {
    "code": "es-co",
    "name": "Spanish (Colombia)"
  },
  {
    "code": "es-cr",
    "name": "Spanish (Costa Rica)"
  },
  {
    "code": "es-do",
    "name": "Spanish (Dominican Republic)"
  },
  {
    "code": "es-ec",
    "name": "Spanish (Ecuador)"
  },
  {
    "code": "es-gt",
    "name": "Spanish (Guatemala)"
  },
  {
    "code": "es-hn",
    "name": "Spanish (Honduras)"
  },
  {
    "code": "es-mx",
    "name": "Spanish (Mexico)"
  },
  {
    "code": "es-ni",
    "name": "Spanish (Nicaragua)"
  },
  {
    "code": "es-pa",
    "name": "Spanish (Panama)"
  },
  {
    "code": "es-pe",
    "name": "Spanish (Peru)"
  },
  {
    "code": "es-pr",
    "name": "Spanish (Puerto Rico)"
  },
  {
    "code": "es-py",
    "name": "Spanish (Paraguay)"
  },
  {
    "code": "es-sv",
    "name": "Spanish (El Salvador)"
  },
  {
    "code": "es-uy",
    "name": "Spanish (Uruguay)"
  },
  {
    "code": "es-ve",
    "name": "Spanish (Venezuela)"
  },
  {
    "code": "et",
    "name": "Estonian"
  },
  {
    "code": "eu",
    "name": "Basque"
  },
  {
    "code": "fa",
    "name": "Farsi"
  },
  {
    "code": "fi",
    "name": "Finnish"
  },
  {
    "code": "fo",
    "name": "Faeroese"
  },
  {
    "code": "fr",
    "name": "French (Standard)"
  },
  {
    "code": "fr-be",
    "name": "French (Belgium)"
  },
  {
    "code": "fr-ca",
    "name": "French (Canada)"
  },
  {
    "code": "fr-ch",
    "name": "French (Switzerland)"
  },
  {
    "code": "fr-lu",
    "name": "French (Luxembourg)"
  },
  {
    "code": "ga",
    "name": "Irish"
  },
  {
    "code": "gd",
    "name": "Gaelic (Scotland)"
  },
  {
    "code": "he",
    "name": "Hebrew"
  },
  {
    "code": "hi",
    "name": "Hindi"
  },
  {
    "code": "hr",
    "name": "Croatian"
  },
  {
    "code": "hu",
    "name": "Hungarian"
  },
  {
    "code": "id",
    "name": "Indonesian"
  },
  {
    "code": "is",
    "name": "Icelandic"
  },
  {
    "code": "it",
    "name": "Italian (Standard)"
  },
  {
    "code": "it-ch",
    "name": "Italian (Switzerland)"
  },
  {
    "code": "ja",
    "name": "Japanese"
  },
  {
    "code": "ji",
    "name": "Yiddish"
  },
  {
    "code": "ko",
    "name": "Korean"
  },
  {
    "code": "ku",
    "name": "Kurdish"
  },
  {
    "code": "lt",
    "name": "Lithuanian"
  },
  {
    "code": "lv",
    "name": "Latvian"
  },
  {
    "code": "mk",
    "name": "Macedonian (FYROM)"
  },
  {
    "code": "ml",
    "name": "Malayalam"
  },
  {
    "code": "ms",
    "name": "Malaysian"
  },
  {
    "code": "mt",
    "name": "Maltese"
  },
  {
    "code": "nb",
    "name": "Norwegian (Bokmål)"
  },
  {
    "code": "ne",
    "name": "Nepali"
  },
  {
    "code": "nl",
    "name": "Dutch (Standard)"
  },
  {
    "code": "nl-be",
    "name": "Dutch (Belgium)"
  },
  {
    "code": "nn",
    "name": "Norwegian (Nynorsk)"
  },
  {
    "code": "no",
    "name": "Norwegian"
  },
  {
    "code": "pa",
    "name": "Punjabi"
  },
  {
    "code": "pl",
    "name": "Polish"
  },
  {
    "code": "pt",
    "name": "Portuguese (Portugal)"
  },
  {
    "code": "pt-br",
    "name": "Portuguese (Brazil)"
  },
  {
    "code": "rm",
    "name": "Rhaeto-Romanic"
  },
  {
    "code": "ro",
    "name": "Romanian"
  },
  {
    "code": "ro-md",
    "name": "Romanian (Republic of Moldova)"
  },
  {
    "code": "ru",
    "name": "Russian"
  },
  {
    "code": "ru-md",
    "name": "Russian (Republic of Moldova)"
  },
  {
    "code": "sb",
    "name": "Sorbian"
  },
  {
    "code": "sk",
    "name": "Slovak"
  },
  {
    "code": "sl",
    "name": "Slovenian"
  },
  {
    "code": "sq",
    "name": "Albanian"
  },
  {
    "code": "sr",
    "name": "Serbian"
  },
  {
    "code": "sv",
    "name": "Swedish"
  },
  {
    "code": "sv-fi",
    "name": "Swedish (Finland)"
  },
  {
    "code": "th",
    "name": "Thai"
  },
  {
    "code": "tn",
    "name": "Tswana"
  },
  {
    "code": "tr",
    "name": "Turkish"
  },
  {
    "code": "ts",
    "name": "Tsonga"
  },
  {
    "code": "ua",
    "name": "Ukrainian"
  },
  {
    "code": "ur",
    "name": "Urdu"
  },
  {
    "code": "ve",
    "name": "Venda"
  },
  {
    "code": "vi",
    "name": "Vietnamese"
  },
  {
    "code": "xh",
    "name": "Xhosa"
  },
  {
    "code": "zh-cn",
    "name": "Chinese (PRC)"
  },
  {
    "code": "zh-hk",
    "name": "Chinese (Hong Kong)"
  },
  {
    "code": "zh-sg",
    "name": "Chinese (Singapore)"
  },
  {
    "code": "zh-tw",
    "name": "Chinese (Taiwan)"
  },
  {
    "code": "zu",
    "name": "Zulu"
  }
]

/** Countries that are members of the European Union. */
export const EU_COUNTRY_CODES: string[] = [
  "AT",
  "BE",
  "HR",
  "BG",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE"
]

/** Country code to international calling code without the leading plus. */
export const PHONE_CODES: Record<string, string> = {
  "AD": "376",
  "AE": "971",
  "AF": "93",
  "AG": "1268",
  "AL": "355",
  "AM": "374",
  "AO": "244",
  "AR": "54",
  "AT": "43",
  "AU": "61",
  "AZ": "994",
  "BA": "387",
  "BB": "1246",
  "BD": "880",
  "BE": "32",
  "BF": "226",
  "BG": "359",
  "BH": "973",
  "BI": "257",
  "BJ": "229",
  "BN": "673",
  "BO": "591",
  "BR": "55",
  "BS": "1242",
  "BT": "975",
  "BW": "267",
  "BY": "375",
  "BZ": "501",
  "CA": "1",
  "CD": "243",
  "CF": "236",
  "CG": "242",
  "CH": "41",
  "CI": "225",
  "CL": "56",
  "CM": "237",
  "CN": "86",
  "CO": "57",
  "CR": "506",
  "CU": "53",
  "CV": "238",
  "CY": "357",
  "CZ": "420",
  "DE": "49",
  "DJ": "253",
  "DK": "45",
  "DM": "1767",
  "DO": "1809",
  "DZ": "213",
  "EC": "593",
  "EE": "372",
  "EG": "20",
  "ER": "291",
  "ES": "34",
  "ET": "251",
  "FI": "358",
  "FJ": "679",
  "FM": "691",
  "FR": "33",
  "GA": "241",
  "GB": "44",
  "GD": "1473",
  "GE": "995",
  "GH": "233",
  "GM": "220",
  "GN": "224",
  "GQ": "240",
  "GR": "30",
  "GT": "502",
  "GW": "245",
  "GY": "592",
  "HN": "504",
  "HR": "385",
  "HT": "509",
  "HU": "36",
  "ID": "62",
  "IE": "353",
  "IL": "972",
  "IN": "91",
  "IQ": "964",
  "IR": "98",
  "IS": "354",
  "IT": "39",
  "JM": "1876",
  "JO": "962",
  "JP": "81",
  "KE": "254",
  "KG": "996",
  "KH": "855",
  "KI": "686",
  "KM": "269",
  "KN": "1869",
  "KP": "850",
  "KR": "82",
  "KW": "965",
  "KZ": "76",
  "LA": "856",
  "LB": "961",
  "LC": "1758",
  "LI": "423",
  "LK": "94",
  "LR": "231",
  "LS": "266",
  "LT": "370",
  "LU": "352",
  "LV": "371",
  "LY": "218",
  "MA": "212",
  "MC": "377",
  "MD": "373",
  "ME": "382",
  "MG": "261",
  "MH": "692",
  "MK": "389",
  "ML": "223",
  "MM": "95",
  "MN": "976",
  "MR": "222",
  "MT": "356",
  "MU": "230",
  "MV": "960",
  "MW": "265",
  "MX": "52",
  "MY": "60",
  "MZ": "258",
  "NA": "264",
  "NE": "227",
  "NG": "234",
  "NI": "505",
  "NL": "31",
  "NO": "47",
  "NP": "977",
  "NR": "674",
  "NZ": "64",
  "OM": "968",
  "PA": "507",
  "PE": "51",
  "PG": "675",
  "PH": "63",
  "PK": "92",
  "PL": "48",
  "PS": "970",
  "PT": "351",
  "PW": "680",
  "PY": "595",
  "QA": "974",
  "RO": "40",
  "RS": "381",
  "RU": "7",
  "RW": "250",
  "SA": "966",
  "SB": "677",
  "SC": "248",
  "SD": "249",
  "SE": "46",
  "SG": "65",
  "SI": "386",
  "SK": "421",
  "SL": "232",
  "SM": "378",
  "SN": "221",
  "SO": "252",
  "SR": "597",
  "SS": "211",
  "ST": "239",
  "SV": "503",
  "SY": "963",
  "SZ": "268",
  "TD": "235",
  "TG": "228",
  "TH": "66",
  "TJ": "992",
  "TL": "670",
  "TM": "993",
  "TN": "216",
  "TO": "676",
  "TR": "90",
  "TT": "1868",
  "TV": "688",
  "TW": "886",
  "TZ": "255",
  "UA": "380",
  "UG": "256",
  "US": "1",
  "UY": "598",
  "UZ": "998",
  "VA": "379",
  "VC": "1784",
  "VE": "58",
  "VN": "84",
  "VU": "678",
  "WS": "685",
  "YE": "967",
  "ZA": "27",
  "ZM": "260",
  "ZW": "263"
}
