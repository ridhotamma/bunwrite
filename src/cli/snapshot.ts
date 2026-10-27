/**
 * Consistent copy of the live database, safe while the server runs:
 * `bun run snapshot [dir]` writes <dir>/pesanle-<timestamp>.sqlite and keeps the newest KEEP (default 7).
 * Copy the folder off the VPS (rclone to R2, for example); a disk failure takes both otherwise.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const source = process.env.DATABASE_PATH ?? './data/pesanle.sqlite'
const dir = process.argv[2] ?? process.env.SNAPSHOT_DIR ?? './data/snapshots'
const keep = Number(process.env.KEEP ?? 7)

mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const target = join(dir, `pesanle-${stamp}.sqlite`)
const db = new Database(source, { readonly: true })
db.run(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
db.close()
console.log(`snapshot: ${target}`)

const old = readdirSync(dir).filter((f) => /^pesanle-.*\.sqlite$/.test(f)).sort().reverse().slice(keep)
for (const f of old) rmSync(join(dir, f))
if (old.length) console.log(`removed ${old.length} old snapshot(s)`)
