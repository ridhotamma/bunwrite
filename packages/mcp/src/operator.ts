/**
 * The compact "operator" surface, modeled on Appwrite's MCP server:
 *
 *   bunwrite_get_context       workspace summary
 *   bunwrite_search_tools      search the internal catalog
 *   bunwrite_call_tool         run one read operation
 *   bunwrite_call_write_tool   run one write operation after confirm_write
 *   bunwrite_search_docs       search Bunwrite docs
 *
 * The full catalog stays internal, so a large API does not consume the model's
 * context on every turn.
 */
import { CATALOG, operationGroups, type Operation, type Services } from './catalog'
import type { McpConfig } from './config'
import { docResources, readDoc, searchDocs } from './docs'
import type {
  McpPromptDefinition,
  McpPromptResult,
  McpReadResourceResult,
  McpResourceDefinition,
  McpToolDefinition,
  McpToolResult,
} from './types'

export interface Operator {
  tools: McpToolDefinition[]
  instructions: string
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>
  resources: McpResourceDefinition[]
  readResource: (uri: string) => Promise<McpReadResourceResult>
  prompts: McpPromptDefinition[]
  getPrompt: (name: string, args: Record<string, string>) => Promise<McpPromptResult>
  getContext: () => Promise<unknown>
  searchTools: (query: string, limit?: number) => unknown
}

const textResult = (value: unknown, maxChars: number): McpToolResult => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n… truncated (${text.length - maxChars} more characters)` : text
  return { content: [{ type: 'text', text: body }] }
}

const requireArgs = (operation: Operation, args: Record<string, unknown>): void => {
  for (const key of operation.input.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') throw new Error(`Missing required argument: ${key}`)
  }
}

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function scoreOperation(operation: Operation, terms: string[]): number {
  const name = operation.name.toLowerCase()
  const title = operation.title.toLowerCase()
  const description = operation.description.toLowerCase()
  const group = operation.group.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (!term) continue
    if (name === term) score += 20
    else if (name.includes(term)) score += 8
    if (title.includes(term)) score += 5
    if (group === term) score += 4
    else if (group.includes(term)) score += 2
    if (description.includes(term)) score += 1
  }
  return score
}

export function operatorTools(readOnly: boolean): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [
    {
      name: 'bunwrite_get_context',
      title: 'Get Bunwrite context',
      description:
        'Return the Bunwrite endpoint, project, version and a count of the main resources. Start here to see what is available.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Get Bunwrite context', readOnlyHint: true, openWorldHint: true },
    },
    {
      name: 'bunwrite_search_tools',
      title: 'Search Bunwrite tools',
      description:
        'Search the Bunwrite operation catalog by name, service or description. Returns operation names for bunwrite_call_tool.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to do, for example "list documents" or "create user".' },
          limit: { type: 'integer', description: 'Maximum results, default 12.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: 'Search Bunwrite tools', readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'bunwrite_call_tool',
      title: 'Run a Bunwrite read operation',
      description: 'Run one read-only operation from the catalog, for example databases_list or documents_list.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Operation name from bunwrite_search_tools.' },
          arguments: { type: 'object', description: 'Operation arguments.', additionalProperties: true },
        },
        required: ['name'],
        additionalProperties: false,
      },
      annotations: { title: 'Run a Bunwrite read operation', readOnlyHint: true, openWorldHint: true },
    },
    {
      name: 'bunwrite_search_docs',
      title: 'Search Bunwrite documentation',
      description: 'Search Bunwrite docs for configuration, databases, deployment, observability, MCP and more.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms.' },
          limit: { type: 'integer', description: 'Maximum results, default 5.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { title: 'Search Bunwrite documentation', readOnlyHint: true, openWorldHint: false },
    },
  ]
  if (!readOnly) {
    tools.splice(3, 0, {
      name: 'bunwrite_call_write_tool',
      title: 'Run a Bunwrite write operation',
      description:
        'Run one operation that changes the project, for example documents_create or users_create. Requires confirm_write: true.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Write operation name from bunwrite_search_tools.' },
          arguments: { type: 'object', description: 'Operation arguments.', additionalProperties: true },
          confirm_write: {
            type: 'boolean',
            description: 'Must be true. Set it only after the user has approved the change.',
          },
        },
        required: ['name', 'confirm_write'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Run a Bunwrite write operation',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    })
  }
  return tools
}

export function createOperator(options: { services: Services; config: McpConfig; catalog?: Operation[] }): Operator {
  const { services, config } = options
  const catalog = (options.catalog ?? CATALOG).filter((operation) => !config.readOnly || !operation.write)
  const tools = operatorTools(config.readOnly)
  const docsDir = config.docsDir

  const searchTools = (query: string, limit = 12): unknown => {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((term) => term.length > 0)
    const results = catalog
      .map((operation) => ({ operation, score: scoreOperation(operation, terms) }))
      .filter((entry) => terms.length === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score || a.operation.name.localeCompare(b.operation.name))
      .slice(0, Math.min(50, Math.max(1, Math.round(limit))))
      .map(({ operation }) => ({
        name: operation.name,
        title: operation.title,
        description: operation.description,
        group: operation.group,
        write: Boolean(operation.write),
        destructive: Boolean(operation.destructive),
      }))
    return { query, count: results.length, tools: results }
  }

  const getContext = async (): Promise<unknown> => {
    const list = (call: Promise<{ total: number }>) =>
      call.then(
        (value) => value.total,
        () => undefined,
      )
    const [version, databases, users, teams, buckets, functions, sites, topics] = await Promise.all([
      services.health.getVersion().catch(() => undefined),
      list(services.databases.list({}) as Promise<{ total: number }>),
      list(services.users.list({}) as Promise<{ total: number }>),
      list(services.teams.list({}) as Promise<{ total: number }>),
      list(services.storage.listBuckets({}) as Promise<{ total: number }>),
      list(services.functions.list({}) as Promise<{ total: number }>),
      list(services.sites.list({}) as Promise<{ total: number }>),
      list(services.messaging.listTopics({}) as Promise<{ total: number }>),
    ])
    return {
      endpoint: config.endpoint,
      project: config.project,
      version: (version as { version?: string } | undefined)?.version ?? null,
      readOnly: config.readOnly,
      counts: {
        databases,
        users,
        teams,
        buckets,
        functions,
        sites,
        topics,
      },
      catalog: { operations: catalog.length, groups: operationGroups() },
      hint: 'Use bunwrite_search_tools, then bunwrite_call_tool. Writes use bunwrite_call_write_tool with confirm_write: true.',
    }
  }

  const callTool = async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
    switch (name) {
      case 'bunwrite_get_context':
        return textResult(await getContext(), config.maxResultChars)
      case 'bunwrite_search_tools':
        return textResult(searchTools(String(args.query ?? ''), Number(args.limit ?? 12)), config.maxResultChars)
      case 'bunwrite_search_docs':
        return textResult(searchDocs(String(args.query ?? ''), Number(args.limit ?? 5), docsDir), config.maxResultChars)
      case 'bunwrite_call_tool': {
        const operationName = String(args.name ?? '')
        const operation = catalog.find((entry) => entry.name === operationName)
        if (!operation) throw new Error(`Unknown operation: ${operationName}`)
        if (operation.write) throw new Error(`${operationName} changes the project. Use bunwrite_call_write_tool with confirm_write: true.`)
        const operationArgs = asObject(args.arguments)
        requireArgs(operation, operationArgs)
        return textResult(await operation.run(services, operationArgs), config.maxResultChars)
      }
      case 'bunwrite_call_write_tool': {
        if (config.readOnly) throw new Error('This MCP server is read-only (BUNWRITE_MCP_READ_ONLY).')
        if (args.confirm_write !== true) throw new Error('Writes require confirm_write: true.')
        const operationName = String(args.name ?? '')
        const operation = catalog.find((entry) => entry.name === operationName)
        if (!operation) throw new Error(`Unknown operation: ${operationName}`)
        if (!operation.write) throw new Error(`${operationName} is read-only. Use bunwrite_call_tool.`)
        const operationArgs = asObject(args.arguments)
        requireArgs(operation, operationArgs)
        return textResult(await operation.run(services, operationArgs), config.maxResultChars)
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  }

  const resources = docResources(docsDir)
  const prompts: McpPromptDefinition[] = [
    {
      name: 'bunwrite',
      title: 'Work on a Bunwrite project',
      description: 'Start a task with the Bunwrite MCP tools and the right operating rules.',
      arguments: [{ name: 'task', description: 'What you want to build or change.', required: true }],
    },
  ]

  return {
    tools,
    instructions: [
      `Bunwrite MCP server connected to ${config.endpoint} (project ${config.project}).`,
      'Call bunwrite_get_context first. Use bunwrite_search_tools to find operations, then bunwrite_call_tool for reads.',
      config.readOnly
        ? 'This server is read-only; write tools are hidden.'
        : 'Writes use bunwrite_call_write_tool and require confirm_write: true. Ask the user before changing or deleting data.',
      'Prefer bounded queries (limit) and never fetch an unbounded list of documents, users or log entries.',
      'Feature flags are available through the flags_get operation. Documentation is in bunwrite_search_docs and bunwrite://docs/* resources.',
    ].join('\n'),
    callTool,
    resources,
    readResource: async (uri) => {
      const match = /^bunwrite:\/\/docs\/([a-z0-9_-]+)$/i.exec(uri)
      const doc = match ? readDoc(match[1]!, docsDir) : null
      if (!doc) throw new Error(`Unknown resource: ${uri}`)
      return { contents: [{ uri: doc.uri, mimeType: doc.mimeType, text: doc.text }] }
    },
    prompts,
    getPrompt: async (name, args) => {
      if (name !== 'bunwrite') throw new Error(`Unknown prompt: ${name}`)
      const task = String(args.task ?? '').trim() || 'Explore this Bunwrite project.'
      return {
        description: 'Work on a Bunwrite project with the MCP tools.',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are working with a Bunwrite project through its MCP server.\n\nTask: ${task}\n\nStart with bunwrite_get_context, search the catalog with bunwrite_search_tools, and use bunwrite_call_tool for reads. Ask before any write; then use bunwrite_call_write_tool with confirm_write: true.`,
            },
          },
        ],
      }
    },
    getContext,
    searchTools,
  }
}
