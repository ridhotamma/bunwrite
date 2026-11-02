/**
 * Optional answer generation for RAG.
 *
 * Bunwrite does not ship a model. When a chat endpoint is configured it calls
 * an OpenAI-compatible `/chat/completions` API; otherwise `/rag/query` returns
 * the retrieved context and sources so the caller can run its own model.
 */

export interface ChatProvider {
  readonly name: string
  complete(system: string, user: string): Promise<{ answer: string; usage?: unknown }>
}

export interface HttpChatOptions {
  url: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
}

export function chatEndpoint(url: string): string {
  const base = url.trim().replace(/\/+$/, '')
  if (!base) throw new Error('A chat URL is required for answer generation.')
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

export class HttpChat implements ChatProvider {
  readonly name: string
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly model: string
  private readonly temperature: number
  private readonly maxTokens: number
  private readonly timeoutMs: number

  constructor(options: HttpChatOptions) {
    this.endpoint = chatEndpoint(options.url)
    this.apiKey = options.apiKey
    this.model = options.model
    this.temperature = options.temperature
    this.maxTokens = Math.max(1, Math.round(options.maxTokens))
    this.timeoutMs = Math.max(1_000, Math.round(options.timeoutMs))
    this.name = options.model
  }

  async complete(system: string, user: string): Promise<{ answer: string; usage?: unknown }> {
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new Error(`Chat request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`Chat provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw new Error('Chat provider returned a non-JSON response.', { cause: error })
    }
    const data = body && typeof body === 'object' ? (body as { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown }) : {}
    const answer = data.choices?.[0]?.message?.content
    if (typeof answer !== 'string' || answer.trim() === '') throw new Error('Chat provider returned an empty answer.')
    return { answer: answer.trim(), usage: data.usage }
  }
}
