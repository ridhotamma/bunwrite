/**
 * Minimal MCP server over JSON-RPC 2.0.
 *
 * Stdio is newline-delimited JSON, one message per line; stdout carries only
 * protocol messages, so logs go to stderr. The HTTP mode reuses the same
 * `handle()` for a stateless streamable-HTTP POST.
 *
 * Implemented directly (no SDK dependency) for the subset this server needs:
 * initialize, tools, resources and prompts.
 */
import type {
  McpPromptDefinition,
  McpPromptResult,
  McpReadResourceResult,
  McpResourceDefinition,
  McpToolDefinition,
  McpToolResult,
} from './types'

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const DEFAULT_PROTOCOL = '2025-06-18'

export interface McpServerOptions {
  name: string
  version: string
  instructions: string
  tools: McpToolDefinition[]
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>
  resources: McpResourceDefinition[]
  readResource: (uri: string) => Promise<McpReadResourceResult>
  prompts: McpPromptDefinition[]
  getPrompt: (name: string, args: Record<string, string>) => Promise<McpPromptResult>
}

type RpcId = string | number | null

interface RpcRequest {
  jsonrpc: '2.0'
  id?: RpcId
  method: string
  params?: Record<string, unknown>
}

interface RpcError {
  code: number
  message: string
  data?: unknown
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const error = (id: RpcId, code: number, message: string): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  error: { code, message } satisfies RpcError,
})

const result = (id: RpcId, value: unknown): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  result: value,
})

export class McpServer {
  constructor(private readonly options: McpServerOptions) {}

  /** Handle one decoded JSON-RPC message; null for notifications. */
  async handle(message: unknown): Promise<Record<string, unknown> | Record<string, unknown>[] | null> {
    if (Array.isArray(message)) {
      const responses = await Promise.all(message.map((entry) => this.handleOne(entry)))
      const present = responses.filter((entry): entry is Record<string, unknown> => entry !== null)
      return present.length ? present : null
    }
    return this.handleOne(message)
  }

  private async handleOne(message: unknown): Promise<Record<string, unknown> | null> {
    if (!isObject(message)) return error(null, -32600, 'Invalid Request')
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(null, -32600, 'Invalid Request')
    const request = message as unknown as RpcRequest
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
    const id = (request.id ?? null) as RpcId
    if (!hasId) {
      // Notifications: initialization complete, cancellation and roots changes.
      return null
    }
    try {
      return result(id, await this.dispatch(request))
    } catch (caught) {
      const messageText = caught instanceof Error ? caught.message : String(caught)
      const code = isObject(caught) && typeof caught.code === 'number' ? caught.code : -32603
      return error(id, code, messageText)
    }
  }

  private async dispatch(request: RpcRequest): Promise<unknown> {
    const params = isObject(request.params) ? request.params : {}
    switch (request.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        const protocolVersion = (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested) ? requested : DEFAULT_PROTOCOL
        return {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
            prompts: { listChanged: false },
          },
          serverInfo: { name: this.options.name, version: this.options.version },
          instructions: this.options.instructions,
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: this.options.tools }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        if (!name) throw new Error('tools/call requires a tool name.')
        const args = isObject(params.arguments) ? (params.arguments as Record<string, unknown>) : {}
        try {
          return await this.options.callTool(name, args)
        } catch (caught) {
          return {
            content: [{ type: 'text', text: caught instanceof Error ? caught.message : String(caught) }],
            isError: true,
          } satisfies McpToolResult
        }
      }
      case 'resources/list':
        return { resources: this.options.resources }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'resources/read': {
        const uri = typeof params.uri === 'string' ? params.uri : ''
        if (!uri) throw new Error('resources/read requires a uri.')
        return this.options.readResource(uri)
      }
      case 'prompts/list':
        return { prompts: this.options.prompts }
      case 'prompts/get': {
        const name = typeof params.name === 'string' ? params.name : ''
        if (!name) throw new Error('prompts/get requires a name.')
        const raw = isObject(params.arguments) ? params.arguments : {}
        const args = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]))
        return this.options.getPrompt(name, args)
      }
      case 'logging/setLevel':
        return {}
      case 'completion/complete':
        return { completion: { values: [], total: 0, hasMore: false } }
      default:
        throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 })
    }
  }

  /** Run over stdin/stdout until the client closes the stream. */
  async runStdio(): Promise<void> {
    process.stdin.setEncoding('utf8')
    let buffer = ''
    const consume = async (line: string): Promise<void> => {
      const trimmed = line.trim()
      if (!trimmed) return
      let message: unknown
      try {
        message = JSON.parse(trimmed)
      } catch {
        this.write(error(null, -32700, 'Parse error'))
        return
      }
      const response = await this.handle(message)
      if (response) this.write(response)
    }
    for await (const chunk of process.stdin) {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        await consume(line)
        newline = buffer.indexOf('\n')
      }
    }
    if (buffer.trim()) await consume(buffer)
  }

  private write(message: unknown): void {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
}
