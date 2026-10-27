#!/usr/bin/env bun
/**
 * Entrypoint for the compiled `bunwrite` executable. The server is the default
 * command; the other commands mirror the package.json scripts.
 */
const [command, ...args] = process.argv.slice(2)

function runCli(...cliArgs: string[]): void {
  process.argv = [process.argv[0]!, 'bunwrite', ...cliArgs]
}

const USAGE = `Bunwrite — Appwrite-compatible backend

Usage:
  bunwrite                     Start the server
  bunwrite serve               Start the server
  bunwrite console:admin ...   Create, reset or remove a console admin
  bunwrite snapshot [dir]      Copy the database consistently
  bunwrite schema:push ...     Apply appwrite.config.json
  bunwrite migrate ...         Import an Appwrite project

Environment is read from .env in the working directory, like the source CLI.`

switch (command) {
  case undefined:
  case 'serve':
    await import('./index')
    break
  case '__bunwrite-runner-node': {
    const { runNodeFunction } = await import('./functions/runner-node')
    await runNodeFunction(args[0] ?? '')
    break
  }
  case 'console:admin':
    runCli(...args)
    await import('./cli/console-admin')
    break
  case 'snapshot':
    runCli(...args)
    await import('./cli/snapshot')
    break
  case 'schema:push':
    runCli(...args)
    await import('./cli/schema-push')
    break
  case 'migrate':
    runCli(...args)
    await import('./cli/migrate')
    break
  case 'help':
  case '--help':
  case '-h':
    console.log(USAGE)
    break
  default:
    console.error(`Unknown command: ${command}\n`)
    console.log(USAGE)
    process.exit(1)
}

export {}
