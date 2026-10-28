/**
 * Runs one Appwrite Node function execution on this server's Bun:
 * `bun runner-node.ts <entrypoint>`. The runner itself is runner-node.mjs,
 * plain JavaScript that downloaded Node.js and Bun runtimes run directly.
 */
import { runNodeFunction } from './runner-node.mjs'

export { runNodeFunction }

if (import.meta.main) {
  const entry = process.argv[2]
  if (!entry) {
    console.error('usage: runner-node.ts <entrypoint>')
    process.exit(1)
  }
  await runNodeFunction(entry)
}
