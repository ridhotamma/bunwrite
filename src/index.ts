process.env.TZ = 'UTC'

import { clusterConfig } from './cluster/config'
import { runSupervisor } from './cluster/supervisor'
import { startServer } from './server'

const cluster = clusterConfig()
if (cluster.supervisor) await runSupervisor(cluster.publicWorkers)
else await startServer()
