import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { createServices, CATALOG } from '../packages/mcp/src/catalog'
import { createClient, normalizeEndpoint, readConfig, type McpConfig } from '../packages/mcp/src/config'
import { createOperator } from '../packages/mcp/src/operator'
import { McpServer } from '../packages/mcp/src/protocol'
import { KEY, PROJECT, startServer, type TestServer } from './helpers'

let server: TestServer
let config: McpConfig
let mcp: McpServer

function build(overrides: Partial<McpConfig> = {}): McpServer {
  const current = { ...config, ...overrides }
  const client = createClient(current)
  const services = createServices(client, current)
  const operator = createOperator({ services, config: current, catalog: CATALOG })
  return new McpServer({
    name: 'bunwrite',
    version: 'test',
    instructions: operator.instructions,
    tools: operator.tools,
    callTool: operator.callTool,
    resources: operator.resources,
    readResource: operator.readResource,
    prompts: operator.prompts,
    getPrompt: operator.getPrompt,
  })
}

async function call(name: string, args: Record<string, unknown> = {}, id = 1): Promise<any> {
  const response = (await mcp.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })) as any
  const text = response.result?.content?.[0]?.text
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // Tool errors are plain text; callers assert on `text`.
  }
  return { response, text, body }
}

beforeAll(() => {
  server = startServer()
  config = readConfig([], {
    BUNWRITE_ENDPOINT: server.endpoint,
    BUNWRITE_PROJECT_ID: PROJECT,
    BUNWRITE_API_KEY: KEY,
  })
  mcp = build()
})

afterAll(() => server.stop())

describe('MCP protocol', () => {
  test('initializes with the requested protocol and exposes the compact operator surface', async () => {
    const response = (await mcp.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '1' } },
    })) as any
    expect(response.result.protocolVersion).toBe('2025-06-18')
    expect(response.result.serverInfo).toEqual({ name: 'bunwrite', version: 'test' })
    expect(response.result.instructions).toContain('bunwrite_get_context')

    const list = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as any
    expect(list.result.tools.map((tool: any) => tool.name)).toEqual([
      'bunwrite_get_context',
      'bunwrite_search_tools',
      'bunwrite_call_tool',
      'bunwrite_call_write_tool',
      'bunwrite_search_docs',
    ])
    for (const tool of list.result.tools) expect(tool.inputSchema).toBeTruthy()
  })

  test('answers ping and reports unknown methods as JSON-RPC errors', async () => {
    expect((await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'ping' })) as any).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
    const unknown = (await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'nope' })) as any
    expect(unknown.error.code).toBe(-32601)
  })

  test('lists docs resources and reads one', async () => {
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })) as any
    expect(list.result.resources.some((resource: any) => resource.uri === 'bunwrite://docs/observability')).toBe(true)
    const read = (await mcp.handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/read',
      params: { uri: 'bunwrite://docs/observability' },
    })) as any
    expect(read.result.contents[0].text).toContain('Datadog')
  })

  test('returns a prompt', async () => {
    const prompt = (await mcp.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'prompts/get',
      params: { name: 'bunwrite', arguments: { task: 'Add a bookings collection' } },
    })) as any
    expect(prompt.result.messages[0].content.text).toContain('Add a bookings collection')
  })
})

describe('operator tools', () => {
  test('gets project context and searches the catalog', async () => {
    const context = await call('bunwrite_get_context')
    expect(context.body.project).toBe(PROJECT)
    expect(context.body.counts.databases).toBeGreaterThanOrEqual(1)
    expect(context.body.catalog.operations).toBeGreaterThan(30)

    const search = await call('bunwrite_search_tools', { query: 'list documents' })
    expect(search.body.tools.some((tool: any) => tool.name === 'documents_list')).toBe(true)
    expect(search.body.tools.some((tool: any) => tool.name === 'users_list')).toBe(false)
  })

  test('runs reads through the catalog', async () => {
    const databases = await call('bunwrite_call_tool', {
      name: 'databases_list',
      arguments: { queries: [JSON.stringify({ method: 'limit', values: [1] })] },
    })
    expect(databases.body.total).toBeGreaterThanOrEqual(1)
    const version = await call('bunwrite_call_tool', { name: 'health_version' })
    expect(version.body.version).toBeTruthy()
  })

  test('refuses writes without confirmation and runs them with it', async () => {
    const denied = await call('bunwrite_call_write_tool', {
      name: 'databases_create',
      arguments: { databaseId: 'mcp-test', name: 'MCP test' },
      confirm_write: false,
    })
    expect(denied.response.result.isError).toBe(true)
    expect(denied.text).toContain('confirm_write')

    const readPath = await call('bunwrite_call_tool', {
      name: 'databases_create',
      arguments: { databaseId: 'mcp-test', name: 'MCP test' },
    })
    expect(readPath.response.result.isError).toBe(true)
    expect(readPath.text).toContain('bunwrite_call_write_tool')

    const created = await call('bunwrite_call_write_tool', {
      name: 'databases_create',
      arguments: { databaseId: 'mcp-test', name: 'MCP test' },
      confirm_write: true,
    })
    expect(created.body.$id).toBe('mcp-test')

    const fetched = await call('bunwrite_call_tool', { name: 'databases_get', arguments: { databaseId: 'mcp-test' } })
    expect(fetched.body.$id).toBe('mcp-test')
  })

  test('hides and refuses writes in read-only mode', async () => {
    const readOnly = build({ readOnly: true })
    const list = (await readOnly.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as any
    expect(list.result.tools.map((tool: any) => tool.name)).not.toContain('bunwrite_call_write_tool')
    const result = (await readOnly.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bunwrite_call_write_tool', arguments: { name: 'databases_create', arguments: {}, confirm_write: true } },
    })) as any
    expect(result.result.isError).toBe(true)
    expect(result.result.content[0].text).toContain('read-only')
  })

  test('searches docs and exposes flags', async () => {
    const docs = await call('bunwrite_search_docs', { query: 'datadog traces' })
    expect(docs.body.some((hit: any) => hit.title.toLowerCase().includes('observability'))).toBe(true)
    const flags = await call('bunwrite_call_tool', { name: 'flags_get' })
    expect(flags.body).toHaveProperty('flags')
  })

  test('manages vector collections, points and RAG', async () => {
    const context = await call('bunwrite_get_context')
    expect(context.body.catalog.groups).toContain('vectors')
    expect(context.body.catalog.groups).toContain('rag')
    expect(context.body.counts.vectorCollections).toBeGreaterThanOrEqual(0)

    const created = await call('bunwrite_call_write_tool', {
      name: 'vectors_collections_create',
      arguments: { collectionId: 'mcp-vectors', name: 'MCP knowledge', dimension: 64 },
      confirm_write: true,
    })
    expect(created.body.$id).toBe('mcp-vectors')

    const points = await call('bunwrite_call_write_tool', {
      name: 'vectors_points_upsert_batch',
      arguments: {
        collectionId: 'mcp-vectors',
        points: [
          { id: 'mcp-v1', content: 'SQLite keeps data in one file.', metadata: { topic: 'storage' } },
          { id: 'mcp-v2', content: 'Postgres can use one schema per project.', metadata: { topic: 'storage' } },
        ],
      },
      confirm_write: true,
    })
    expect(points.body.points).toHaveLength(2)

    const search = await call('bunwrite_call_tool', {
      name: 'vectors_search',
      arguments: { collectionId: 'mcp-vectors', text: 'where is data stored?', topK: 2 },
    })
    expect(search.body.points.length).toBeGreaterThan(0)
    expect(typeof search.body.points[0].score).toBe('number')

    const ingested = await call('bunwrite_call_write_tool', {
      name: 'rag_ingest',
      arguments: {
        collectionId: 'mcp-vectors',
        documentId: 'mcp-guide',
        text: 'SQLite stores the database in a local file. Postgres stores a project in a schema.',
      },
      confirm_write: true,
    })
    expect(ingested.body.documentId).toBe('mcp-guide')
    expect(ingested.body.chunks).toBeGreaterThan(0)

    const chunks = await call('bunwrite_call_tool', {
      name: 'vectors_documents_get',
      arguments: { collectionId: 'mcp-vectors', documentId: 'mcp-guide' },
    })
    expect(chunks.body.total).toBe(ingested.body.chunks)

    const query = await call('bunwrite_call_tool', {
      name: 'rag_query',
      arguments: { collectionId: 'mcp-vectors', query: 'Where is data stored?', topK: 2, generate: false },
    })
    expect(query.body.answer).toBeNull()
    expect(query.body.sources.length).toBeGreaterThan(0)

    const removedDocument = await call('bunwrite_call_write_tool', {
      name: 'vectors_documents_delete',
      arguments: { collectionId: 'mcp-vectors', documentId: 'mcp-guide' },
      confirm_write: true,
    })
    expect(removedDocument.body.deleted).toBe(ingested.body.chunks)
    const removedPoint = await call('bunwrite_call_write_tool', {
      name: 'vectors_points_delete',
      arguments: { collectionId: 'mcp-vectors', pointId: 'mcp-v1' },
      confirm_write: true,
    })
    expect(removedPoint.body.ok).toBe(true)
    const removedCollection = await call('bunwrite_call_write_tool', {
      name: 'vectors_collections_delete',
      arguments: { collectionId: 'mcp-vectors' },
      confirm_write: true,
    })
    expect(removedCollection.body.ok).toBe(true)
  })
})

describe('configuration', () => {
  test('normalizes endpoints and rejects missing credentials', () => {
    expect(normalizeEndpoint('https://example.com')).toBe('https://example.com/v1')
    expect(normalizeEndpoint('https://example.com/v1/')).toBe('https://example.com/v1')
    expect(() => readConfig([], { BUNWRITE_ENDPOINT: 'http://localhost/v1' })).toThrow('No project ID')
    expect(() => readConfig([], { BUNWRITE_ENDPOINT: 'http://localhost/v1', BUNWRITE_PROJECT_ID: 'p' })).toThrow('No API key')
  })
})
