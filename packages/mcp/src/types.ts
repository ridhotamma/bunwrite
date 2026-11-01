/** Shared MCP wire types. The server speaks JSON-RPC 2.0; these are the MCP shapes. */

export interface McpToolDefinition {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export interface McpResourceDefinition {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpPromptDefinition {
  name: string
  title?: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpTextContent {
  type: 'text'
  text: string
}

export interface McpToolResult {
  content: McpTextContent[]
  isError?: boolean
}

export interface McpReadResourceResult {
  contents: Array<{ uri: string; mimeType?: string; text: string }>
}

export interface McpPromptResult {
  description?: string
  messages: Array<{ role: 'user' | 'assistant'; content: McpTextContent }>
}
