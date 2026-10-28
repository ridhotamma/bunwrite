/** Runtimes the console offers and the starter code for each. */
import { DEFAULT_RUNTIME, FUNCTION_RUNTIMES } from '~/runtimes/catalog'
import type { CodeFile } from './deployments'

export interface RuntimeOption {
  id: string
  label: string
}

/**
 * Node.js and Bun functions run on that runtime, downloaded on first use (see
 * runtimes/install.ts); Python ones on the server's python3. The default comes
 * first.
 */
export const RUNTIME_OPTIONS: RuntimeOption[] = [
  ...FUNCTION_RUNTIMES.filter((r) => r.id === DEFAULT_RUNTIME),
  ...FUNCTION_RUNTIMES.filter((r) => r.id !== DEFAULT_RUNTIME),
].map((r) => ({ id: r.id, label: r.note ? `${r.label} (${r.note})` : r.label }))

export const SUPPORTED_RUNTIME_IDS = RUNTIME_OPTIONS.map((r) => r.id)

export const isPython = (runtime: string) => runtime.startsWith('python')

export const defaultEntrypoint = (runtime: string) => (isPython(runtime) ? 'src/main.py' : 'src/main.js')

const NODE_STARTER = `// Runs on every execution. Return a response with res.json, res.text, res.send or res.empty.
export default async ({ req, res, log, error }) => {
  log(\`\${req.method} \${req.path}\`)

  if (req.path === '/ping') {
    return res.text('pong')
  }

  return res.json({
    message: 'Hello from your new function',
    method: req.method,
    query: req.query,
  })
}
`

const PYTHON_STARTER = `# Runs on every execution. Return a response with res.json, res.text, res.send or res.empty.
def main(context):
    req = context.req
    context.log(f"{req.method} {req.path}")

    if req.path == "/ping":
        return context.res.text("pong")

    return context.res.json({
        "message": "Hello from your new function",
        "method": req.method,
        "query": req.query,
    })
`

export const starterCode = (runtime: string) => (isPython(runtime) ? PYTHON_STARTER : NODE_STARTER)

/** The starter as deployable files, with a package.json for Node and Bun. */
export function starterFiles(runtime: string, entrypoint: string): CodeFile[] {
  const files: CodeFile[] = [{ path: entrypoint, content: starterCode(runtime) }]
  if (!isPython(runtime)) files.push({ path: 'package.json', content: `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n` })
  return files
}
