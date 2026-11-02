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
  bunwrite snapshot [dir]      Back up every database consistently
  bunwrite restore <archive>   Restore every database from a backup archive
  bunwrite failover            Restore databases from Litestream
  bunwrite postgres:doctor     Check WAL-G and print a Postgres restore runbook
  bunwrite backup:open <file>  Open a legacy per-project backup (.sqlite.zst)
  bunwrite schema:push ...     Apply a project config file
  bunwrite migrate ...         Import an Appwrite project
  bunwrite autotune [--json]   Show the auto-tuned resource limits
  bunwrite autotune --shell    Print startup-only env (JSC heap, malloc arenas)
  bunwrite health              Exit 0 when the local server answers /v1/health

Environment is read from .env in the working directory, like the source CLI.`

switch (command) {
  case undefined:
  case 'serve':
    await import('./index')
    break
  case '__bunwrite-runner-node': {
    const { runNodeFunction } = await import('./functions/runtime')
    await runNodeFunction(args[0] ?? '')
    break
  }
  case 'health': {
    // Used by the container HEALTHCHECK, so the image needs no curl.
    const port = process.env.PORT || '8080'
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(4000) })
      process.exit(res.ok ? 0 : 1)
    } catch {
      process.exit(1)
    }
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
  case 'restore':
    runCli(...args)
    await import('./cli/restore')
    break
  case 'failover':
    runCli(...args)
    await import('./cli/failover')
    break
  case 'postgres:doctor':
    runCli(...args)
    await import('./cli/postgres-doctor')
    break
  case 'backup:open':
    runCli(...args)
    await import('./cli/backup-open')
    break
  case 'schema:push':
    runCli(...args)
    await import('./cli/schema-push')
    break
  case 'migrate':
    runCli(...args)
    await import('./cli/migrate')
    break
  case 'autotune': {
    const [{ reportAutotune }, { clusterConfig }] = await Promise.all([
      import('./system/autotune'),
      import('./cluster/config'),
    ])
    // `--shell` runs before the supervisor spawns anything, so it must use the
    // process count the supervisor will use: the children plus that supervisor.
    const cluster = clusterConfig()
    reportAutotune(args, process.env, cluster.workers > 1 ? cluster.workers + 1 : 1)
    break
  }
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
