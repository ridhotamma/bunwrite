/** MCP page handler. Markup lives in console/views/mcp. */
import type { ConsoleRouter } from '~/console/context'
import { MCP, mcpView } from '~/console/views/mcp'

export function mcpPages(router: ConsoleRouter): void {
  router.get(MCP, ({ ctx }) => ctx.render('MCP', 'mcp', mcpView(ctx)))
}
