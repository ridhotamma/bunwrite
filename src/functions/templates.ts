/** Runtimes the console offers and the starter code for each. */
import type { CodeFile } from './deployments'

export interface RuntimeOption {
  id: string
  label: string
}

/**
 * Node and Bun functions run under this server's Bun, Python ones under
 * python3, so the version is a label kept for Appwrite compatibility.
 */
export const RUNTIME_OPTIONS: RuntimeOption[] = [
  { id: 'node-22', label: 'Node.js 22' },
  { id: 'node-20', label: 'Node.js 20' },
  { id: 'bun-1.1', label: 'Bun 1.1' },
  { id: 'python-3.12', label: 'Python 3.12' },
  { id: 'python-3.9', label: 'Python 3.9' },
]

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
