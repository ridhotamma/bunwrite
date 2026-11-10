/** MCP page: connect an AI agent to this project through the Bunwrite MCP server. */
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { alert, header, icon, settingsSection } from '~/console/ui'
import { API } from './api'

export const MCP = '/console/mcp'

const MCP_GUIDE = 'https://github.com/ridhotamma/bunwrite/blob/main/docs/MCP.md'

const TOOLS = [
  ['bunwrite_get_context', 'Start here: project, version, resource counts and catalog groups.'],
  ['bunwrite_search_tools', 'Find an operation by name, group or description.'],
  ['bunwrite_call_tool', 'Run a read operation.'],
  ['bunwrite_call_write_tool', 'Run a write after confirm_write: true. Hidden in read-only mode.'],
  ['bunwrite_search_docs', 'Search the Bunwrite documentation.'],
] as const

const CLIENTS = [
  ['Claude Code', 'claude mcp add …'],
  ['Claude Desktop', 'claude_desktop_config.json'],
  ['Cursor', '~/.cursor/mcp.json or .cursor/mcp.json'],
  ['VS Code', '.vscode/mcp.json'],
  ['OpenCode', 'the mcp section of opencode.json'],
  ['Codex', '~/.codex/config.toml'],
  ['Zed', 'settings.json → context_servers'],
] as const

/** A copyable code block. The copy button reads textContent, so escaping is safe. */
function codeBlock(id: string, code: string): Html {
  return html`<div class="code-block">
    <pre id="${id}">${code}</pre>
    <button type="button" class="small" data-copy-target="#${id}" aria-label="Copy code">${icon('copy')}<span data-copy-label>Copy</span></button>
  </div>`
}

function serverCommand(endpoint: string, projectId: string): string {
  return [
    `BUNWRITE_ENDPOINT=${endpoint}`,
    `BUNWRITE_PROJECT_ID=${projectId}`,
    'BUNWRITE_API_KEY=standard_...',
  ]
    .map((line) => `${line} \\`)
    .join('\n')
    .concat('\n  npx -y @bunwrite/mcp')
}

function claudeCommand(endpoint: string, projectId: string): string {
  return [
    'claude mcp add bunwrite \\',
    `  --env BUNWRITE_ENDPOINT=${endpoint} \\`,
    `  --env BUNWRITE_PROJECT_ID=${projectId} \\`,
    '  --env BUNWRITE_API_KEY=standard_... \\',
    '  -- npx -y @bunwrite/mcp',
  ].join('\n')
}

function clientConfig(endpoint: string, projectId: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        bunwrite: {
          command: 'npx',
          args: ['-y', '@bunwrite/mcp'],
          env: {
            BUNWRITE_ENDPOINT: endpoint,
            BUNWRITE_PROJECT_ID: projectId,
            BUNWRITE_API_KEY: 'standard_...',
          },
        },
      },
    },
    null,
    2,
  )
}

export function mcpView(ctx: ConsoleContext): Html {
  const endpoint = ctx.services.config.publicEndpoint
  const projectId = ctx.services.config.projectId
  const actions = html`<a class="btn" href="${MCP_GUIDE}" target="_blank" rel="noreferrer">${icon('info')}<span>Guide</span></a>
    <a class="btn primary" href="${API}">${icon('key')}<span>API keys</span></a>`

  return html`${header('MCP', { description: 'Let AI agents work with this project through the Model Context Protocol.', actions })}
    ${settingsSection(
      'Connection',
      'The MCP server calls this project through its REST API. It uses a server-side API key, not a browser session.',
      html`<div class="fields">
          <label>API endpoint<div class="copy-row"><input id="mcp-endpoint" class="mono" readonly value="${endpoint}"><button type="button" data-copy-target="#mcp-endpoint">${icon('copy')}<span data-copy-label>Copy</span></button></div></label>
          <label>Project ID<div class="copy-row"><input id="mcp-project-id" class="mono" readonly value="${projectId}"><button type="button" data-copy-target="#mcp-project-id">${icon('copy')}<span data-copy-label>Copy</span></button></div></label>
        </div>
        <p class="help">Create a scoped key on the <a href="${API}">API page</a>. Give the agent only the operations it needs.</p>`,
      { id: 'connection' },
    )}
    ${settingsSection(
      'Run the server',
      'Run the MCP server beside your agent. It stays local and connects out to this API endpoint.',
      html`${codeBlock('mcp-command', serverCommand(endpoint, projectId))}
        <p class="help">
          Add <code>--read-only</code> to hide and refuse writes. If your client cannot start a process, use
          <code>--transport http --port 7801</code> and connect it to <code>http://127.0.0.1:7801/mcp</code>.
        </p>
        <p class="help">From a checkout, run <code>bun run mcp:build</code> and use <code>node packages/mcp/dist/mcp.js</code> instead of <code>npx</code>.</p>`,
      { id: 'run' },
    )}
    ${settingsSection(
      'Agent configuration',
      'Paste this into an MCP client and replace the API key placeholder with a real server-side key.',
      html`${codeBlock('mcp-client-config', clientConfig(endpoint, projectId))}
        <p class="help">Claude Code can register the same server from the terminal:</p>
        ${codeBlock('mcp-claude-command', claudeCommand(endpoint, projectId))}
        <ul class="list">
          ${CLIENTS.map(([client, location]) => html`<li><span>${client}</span><span class="subdued">${location}</span></li>`)}
        </ul>
        <p class="help"><a href="${MCP_GUIDE}" target="_blank" rel="noreferrer">Read the MCP guide</a> for client-specific file formats.</p>`,
      { id: 'agents' },
    )}
    ${settingsSection(
      'Tools',
      'The agent sees five small operator tools. The full API catalog stays behind search, so it does not fill the model’s context.',
      html`<ul class="list">
          ${TOOLS.map(([name, description]) => html`<li><span class="mono">${name}</span><span class="subdued">${description}</span></li>`)}
        </ul>
        ${alert(
          'warning',
          html`Use a scoped key, keep it in the agent’s environment, and prefer <code>--read-only</code> for exploration. Write tools ask for confirmation, but review destructive calls before approving them.`,
        )}`,
      { id: 'tools' },
    )}`
}
