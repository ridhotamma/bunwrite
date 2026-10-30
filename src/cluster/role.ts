/**
 * Which process runs the single-instance work (cron jobs, backups, reapers,
 * render queue, pruning). A server that is not part of a cluster is always the
 * leader, so tests and `WORKERS=1` keep the old behavior.
 */
let leading = true
const listeners = new Set<(leader: boolean) => void>()

export function isLeader(): boolean {
  return leading
}

export function setLeader(value: boolean): void {
  if (value === leading) return
  leading = value
  for (const listener of listeners) listener(value)
}

/** Observe leadership changes, for work that should start or stop with them. */
export function onLeaderChange(listener: (leader: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
