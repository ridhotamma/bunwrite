import { createInterface } from 'node:readline'

const colors = process.stdout.isTTY && !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0'
const paint = (code: number) => (text: string) => (colors ? `\x1b[${code}m${text}\x1b[0m` : text)

export const bold = paint(1)
export const dim = paint(2)
export const green = paint(32)
export const red = paint(31)
export const yellow = paint(33)
export const cyan = paint(36)

export const log = (message = '') => console.log(message)
export const info = (message: string) => console.log(`${cyan('ℹ')} ${message}`)
export const success = (message: string) => console.log(`${green('✓')} ${message}`)
export const warn = (message: string) => console.error(`${yellow('!')} ${message}`)
export const fail = (message: string) => console.error(`${red('✗ Error:')} ${message}`)

/** A failure to show the user as is, without a stack trace. */
export class CliError extends Error {}

/** Ask a yes/no question. Without a terminal, the answer is the first line of stdin. */
export async function confirm(question: string, fallback = false): Promise<boolean> {
  const answer = (await ask(`${question} ${fallback ? '(Y/n)' : '(y/N)'} `)).trim().toLowerCase()
  if (!answer) return fallback
  return answer === 'y' || answer === 'yes'
}

let terminal: ReturnType<typeof createInterface> | undefined
let lines: AsyncIterator<string> | undefined

/** Release stdin before handing it to a child process. */
export function closeAsk(): void {
  terminal?.close()
  terminal = undefined
  lines = undefined
}

export async function ask(question: string): Promise<string> {
  process.stdout.write(question)
  if (!lines) {
    terminal = createInterface({ input: process.stdin, terminal: false })
    lines = terminal[Symbol.asyncIterator]()
  }
  const next = await lines.next()
  if (!process.stdin.isTTY) process.stdout.write('\n')
  return next.done ? '' : next.value
}

/**
 * Ask for a secret. In a terminal every key is shown as `*`, so the value is
 * never echoed; Backspace, Ctrl-C and Ctrl-D behave as usual. Without a
 * terminal (piped input) it reads the next line like `ask`.
 */
export async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question)
  closeAsk()
  process.stdout.write(question)
  process.stdin.setEncoding('utf8')
  process.stdin.setRawMode(true)
  process.stdin.resume()

  return new Promise((resolve) => {
    let answer = ''
    let escape = 0

    const finish = (value: string) => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
      resolve(value)
    }

    const onData = (chunk: string) => {
      for (const char of chunk) {
        // Skip escape sequences (arrow keys, function keys) instead of typing them.
        if (escape === 1) {
          escape = char === '[' || char === 'O' ? 2 : 0
          continue
        }
        if (escape === 2) {
          if (char >= '@' && char <= '~') escape = 0
          continue
        }
        if (char === '\x1b') {
          escape = 1
          continue
        }
        if (char === '\r' || char === '\n' || char === '\x04') {
          finish(answer)
          return
        }
        if (char === '\x03') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdout.write('\n')
          process.exit(130)
        }
        if (char === '\x7f' || char === '\b') {
          if (!answer) continue
          answer = answer.slice(0, -1)
          process.stdout.write('\b \b')
          continue
        }
        if (char < ' ') continue
        answer += char
        process.stdout.write('*')
      }
    }

    process.stdin.on('data', onData)
  })
}

/** A plain table for lists. */
export function table(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)))
  const line = (values: string[]) => values.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd()
  return [bold(line(columns)), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))].join('\n')
}
