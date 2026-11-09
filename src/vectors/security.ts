/**
 * Deterministic data-protection helpers for retrieval.
 *
 * PII redaction runs before context is handed to a chat model, so an answer
 * cannot quote an email, phone number or payment identifier that the caller
 * was not meant to send onward. Prompt-injection signals are advisory: the
 * system prompt tells the model that context is untrusted, and the API returns
 * which sources looked suspicious.
 */

export interface RedactionResult {
  text: string
  redactions: number
  kinds: string[]
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g
const NIK = /\b\d{16}\b/g
const PHONE =
  /(?:\+62|62|0)8\d[\d\s.-]{6,12}\b|\+\d{1,3}[\s.-]?(?:\d[\s.-]?){7,14}\d\b|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g
const CARD = /\b(?:\d[ -]?){13,19}\b/g

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/** Redact common personal identifiers. The original text is never modified. */
export function redactPii(source: string): RedactionResult {
  const kinds = new Set<string>()
  let redactions = 0
  let text = source

  const replace = (pattern: RegExp, kind: string, test?: (value: string) => boolean) => {
    text = text.replace(pattern, (value) => {
      if (test && !test(value)) return value
      redactions++
      kinds.add(kind)
      return `[redacted ${kind}]`
    })
  }

  replace(EMAIL, 'email')
  replace(IBAN, 'iban')
  replace(SSN, 'ssn')
  replace(NIK, 'nik')
  replace(CARD, 'card', luhn)
  replace(PHONE, 'phone')

  return { text, redactions, kinds: [...kinds] }
}

const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier)\b/i,
  /\b(system|developer)\s+(prompt|message|instruction)s?\b/i,
  /\byou are now\b/i,
  /\b(reveal|print|repeat|show)\b[^.\n]{0,30}\b(system|developer|prompt)\b/i,
  /\b(jailbreak|developer mode|do anything now|DAN mode)\b/i,
  /<\|?(system|assistant|developer)\|?>/i,
  /\b(abaikan|lewati)\b[^.\n]{0,40}\b(instruksi|perintah|petunjuk)\b/i,
  /\b(system prompt|instruksi sistem|prompt sistem)\b/i,
]

/** Human-readable signals that retrieved text may contain instructions aimed at the model. */
export function injectionSignals(source: string): string[] {
  const signals: string[] = []
  for (const pattern of INJECTION_PATTERNS) if (pattern.test(source)) signals.push(pattern.source)
  return signals
}
