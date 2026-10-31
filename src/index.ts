process.env.TZ = 'UTC'

import { applyPendingRestore } from './backups/pending'
import { clusterConfig } from './cluster/config'
import { runSupervisor } from './cluster/supervisor'
import { configFromEnv } from './config'
import { startServer } from './server'

const cluster = clusterConfig()
// A staged restore replaces the control database, so it must run before any
// process opens SQLite. In a cluster the supervisor does it before spawning
// workers; a single process does it here.
if (cluster.supervisor || cluster.workers === 1) await applyPendingRestore(configFromEnv())
if (cluster.supervisor) await runSupervisor(cluster.publicWorkers)
else await startServer()
