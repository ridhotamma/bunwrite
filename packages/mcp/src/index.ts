/**
 * Bunwrite MCP server entry point.
 *
 *   bunwrite-mcp                 stdio, for Claude Code / Cursor / Codex / ...
 *   bunwrite-mcp --transport http
 *
 * The model gets five small operator tools; the catalog is searched at runtime.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { createServices, CATALOG } from './catalog'
import { ConfigError, USAGE, createClient, describeTarget, readConfig, type McpConfig } from './config'
import { createOperator } from './operator'
import { McpServer } from './protocol'

declare const __BUNWRITE_MCP_VERSION__: string | undefined
const VERSION = typeof __BUNWRITE_MCP_VERSION__ === 'string' ? __BUNWRITE_MCP_VERSION__ : '0.0.0-dev'

function build(config: McpConfig): McpServer {
  const client = createClient(config)
  const services = createServices(client, config)
  const operator = createOperator({ services, config, catalog: CATALOG })
  return new McpServer({
    name: 'bunwrite',
    version: VERSION,
    instructions: operator.instructions,
    tools: operator.tools,
    callTool: operator.callTool,
    resources: operator.resources,
    readResource: operator.readResource,
    prompts: operator.prompts,
    getPrompt: operator.getPrompt,
  })
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function loopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function authorized(request: IncomingMessage, config: McpConfig): boolean {
  const project = header(request, 'x-bunwrite-project') || header(request, 'x-appwrite-project')
  if (project && project !== config.project) return false
  const bearer = header(request, 'authorization').replace(/^Bearer\s+/i, '')
  const key = header(request, 'x-bunwrite-key') || header(request, 'x-appwrite-key')
  const supplied = bearer || key
  // Loopback defaults to no header so local clients work out of the box. Any
  // supplied credential must still match.
  if (!supplied) return loopbackHost(config.host)
  return supplied === config.key
}

function readBody(request: IncomingMessage, limit = 2_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let length = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > limit) {
        reject(new Error('Request body is too large.'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers })
  response.end(text)
}

async function runHttp(config: McpConfig): Promise<void> {
  const server = build(config)
  const http = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (url.pathname === '/health' && request.method === 'GET') {
        send(response, 200, { ok: true, name: 'bunwrite-mcp', version: VERSION, project: config.project })
        return
      }
      if (url.pathname !== '/mcp') {
        send(response, 404, { error: 'Not found. Use POST /mcp.' })
        return
      }
      if (request.method === 'GET') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (request.method === 'DELETE') {
        response.writeHead(204)
        response.end()
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!authorized(request, config)) {
        send(response, 401, { error: 'Unauthorized. Send Authorization: Bearer <BUNWRITE_API_KEY>.' })
        return
      }
      let message: unknown
      try {
        message = JSON.parse(await readBody(request))
      } catch (caught) {
        send(response, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: caught instanceof Error ? caught.message : 'Parse error' },
        })
        return
      }
      const handled = await server.handle(message)
      if (!handled) {
        response.writeHead(202)
        response.end()
        return
      }
      send(response, 200, handled)
    })().catch((caught) => {
      if (!response.headersSent) {
        send(response, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: caught instanceof Error ? caught.message : String(caught) } })
      } else {
        response.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(config.port, config.host, () => resolve())
  })
  console.error(`[bunwrite-mcp] ${VERSION} · HTTP ${config.host}:${config.port}/mcp · ${describeTarget(config)}${config.readOnly ? ' · read-only' : ''}`)
  const stop = () => {
    http.close(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION)
    return
  }
  let config: McpConfig
  try {
    config = readConfig(argv)
  } catch (caught) {
    if (caught instanceof ConfigError) {
      console.error(`bunwrite-mcp: ${caught.message}`)
      console.error('Run `bunwrite-mcp --help` for usage.')
      process.exitCode = 1
      return
    }
    throw caught
  }

  if (config.transport === 'http') {
    await runHttp(config)
    return
  }

  const server = build(config)
  console.error(`[bunwrite-mcp] ${VERSION} · stdio · ${describeTarget(config)}${config.readOnly ? ' · read-only' : ''}`)
  await server.runStdio()
}

await main()
