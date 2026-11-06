/** Organization-level backups: SQLite archives or one Postgres dump per run. */
import { readPendingRestore } from '~/backups/pending'
import type { BackupFile } from '~/backups/service'
import { litestreamStatus, maskReplica } from '~/backups/litestream'
import { litestreamSettingsFromEnv, readLitestreamSettings } from '~/backups/litestream-settings'
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { alert, badge, destroy, emptyState, formatBytes, icon, settingsSection, when } from '~/console/ui'
import { fileField } from '~/console/upload'
import { parseCron } from '~/functions/cron'
import { s3Fields } from './settings'

export const BACKUPS = '/console/organization/backups'

/** Common schedules offered as presets. Custom expressions stay available underneath. */
export const BACKUP_SCHEDULES = [
  { key: 'daily', label: 'Daily at 02:00', cron: '0 2 * * *' },
  { key: 'every-6-hours', label: 'Every 6 hours', cron: '0 */6 * * *' },
  { key: 'every-12-hours', label: 'Every 12 hours', cron: '0 */12 * * *' },
  { key: 'weekly', label: 'Weekly on Monday at 02:00', cron: '0 2 * * 1' },
  { key: 'monthly', label: 'Monthly on the 1st at 02:00', cron: '0 2 1 * *' },
  { key: 'hourly', label: 'Every hour', cron: '0 * * * *' },
] as const

type SchedulePreset = 'custom' | (typeof BACKUP_SCHEDULES)[number]['key']

function schedulePreset(expression: string): SchedulePreset {
  return BACKUP_SCHEDULES.find((preset) => preset.cron === expression.trim())?.key ?? 'custom'
}

function scheduleLabel(expression: string): string {
  return BACKUP_SCHEDULES.find((preset) => preset.cron === expression.trim())?.label ?? expression
}

/** The next UTC minute that the expression matches, for the summary card. */
function nextRun(expression: string): string {
  try {
    const cron = parseCron(expression)
    const at = new Date()
    at.setUTCSeconds(0, 0)
    at.setUTCMinutes(at.getUTCMinutes() + 1)
    for (let minute = 0; minute < 366 * 24 * 60; minute++) {
      if (cron.matches(at)) {
        return `${at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false })} UTC`
      }
      at.setUTCMinutes(at.getUTCMinutes() + 1)
    }
  } catch {
    // Invalid schedules are reported by the form when they are saved.
  }
  return '—'
}

export async function backupsView(ctx: ConsoleContext): Promise<Html> {
  const control = ctx.projects.control
  const c = control.config
  const local = control.db.capabilities.localFile
  let backups: BackupFile[] = []
  let error = ''
  try {
    backups = await control.backups.list()
  } catch (problem) {
    error = problem instanceof Error ? problem.message : String(problem)
  }
  const basePath = c.legacyDatabasePath ?? c.databasePath
  const pending = readPendingRestore(basePath)
  const litestream = litestreamStatus()
  const storedLitestream = readLitestreamSettings(basePath)
  const litestreamSettings = storedLitestream ?? litestreamSettingsFromEnv()
  const preset = schedulePreset(c.backups.schedule)
  const nextBackup = c.backups.enabled ? nextRun(c.backups.schedule) : 'Paused'
  const offsite = c.backups.s3.enabled || (local && (storedLitestream ? storedLitestream.enabled : litestream.configured))
  const totalSize = backups.reduce((sum, backup) => sum + backup.size, 0)
  const encryption = c.backupEncryptionKey
    ? alert('info', html`Backups are compressed and encrypted with <code>BACKUP_ENCRYPTION_KEY</code>. Keep a copy of that key somewhere other than this server; without it the backups cannot be opened. ${local ? html`Restore one here, or with <code>bunwrite restore &lt;file&gt;</code>.` : html`Unpack one with <code>bunwrite backup:open</code>, then restore it with <code>pg_restore</code>.`}`)
    : alert('warning', html`Backups are compressed but not encrypted, and they include every project's stored secrets. Set <code>BACKUP_ENCRYPTION_KEY</code> in the server environment (for example from <code>openssl rand -base64 32</code>) and restart to encrypt new backups.`)
  return html`
    ${error ? alert('critical', html`${error}`) : ''}
    ${encryption}
    ${settingsSection(
      'Backup status',
      'The current schedule, saved copies and whether a copy leaves this server.',
      html`<ul class="list">
        <li><span class="subdued">Automatic backups</span><span>${c.backups.enabled ? badge('On', 'success') : badge('Off')} ${c.backups.enabled ? html`<span class="subdued">${scheduleLabel(c.backups.schedule)}</span>` : ''}</span></li>
        <li><span class="subdued">Next backup</span><span>${nextBackup}</span></li>
        <li><span class="subdued">Saved backups</span><span>${backups.length}${backups.length ? html` <span class="subdued">· ${formatBytes(totalSize)}</span>` : ''}</span></li>
        <li><span class="subdued">Off-site copy</span><span>${offsite ? badge('On', 'success') : badge('Off')} <span class="subdued">${offsite ? (local ? 'Litestream replica or S3' : 'S3') : 'This server'}</span></span></li>
      </ul>`,
      { id: 'backup-status' },
    )}
    ${settingsSection(
      'Saved backups',
      local
        ? 'One archive covers the control database and every project database. Download, restore or delete one here.'
        : 'One dump covers the whole Postgres database. Download or delete one here.',
      html`<div class="toolbar">
          ${backups.length ? html`<span class="subdued">${formatBytes(totalSize)} total</span>` : ''}
          <form method="post" action="${BACKUPS}/create" class="inline" style="margin-left:auto"><button class="primary">${icon('plus')}<span>Create backup</span></button></form>
        </div>
        ${backups.length
          ? html`<ul class="list backup-list">${backups.map(
              (b) => html`<li>
                <div class="backup-meta">
                  <span class="mono clip" title="${b.name}">${b.name}</span>
                  <span class="subdued cell-sub">${formatBytes(b.size)} · Created ${when(b.modified)}</span>
                </div>
                <div class="backup-actions">
                  <a class="btn small" href="${BACKUPS}/${encodeURIComponent(b.name)}/download" hx-boost="false">Download</a>
                  <form method="post" action="${BACKUPS}/${encodeURIComponent(b.name)}/delete" class="inline" data-confirm="Delete ${b.name}?" data-confirm-label="Delete" data-confirm-tone="critical">
                    <button class="critical small">Delete</button>
                  </form>
                </div>
              </li>`,
            )}</ul>`
          : emptyState(
              'No backups yet',
              c.backups.enabled ? 'Create one now, or wait for the next automatic backup.' : 'Create one now, or turn on automatic backups below.',
            )}`,
      {
        id: 'backups',
        flush: true,
        badge: backups.length
          ? badge(`${backups.length} ${backups.length === 1 ? (local ? 'archive' : 'dump') : local ? 'archives' : 'dumps'}`, 'info')
          : badge('None'),
      },
    )}
    ${settingsSection(
      'Automatic backups',
      local
        ? 'Create a whole-instance archive on a schedule, keep a fixed number of them, and optionally store them in S3.'
        : 'Create a Postgres dump on a schedule, keep a fixed number of them, and optionally upload them to S3.',
      html`<form method="post" action="${BACKUPS}" class="stack-fields">
        <label class="check"><input type="checkbox" name="backupsEnabled" ${c.backups.enabled ? 'checked' : ''}><span>Run backups automatically</span><small>${local ? 'Each run creates one archive for the control database and every project.' : 'Each run dumps the whole Postgres database with pg_dump.'}</small></label>
        <div class="fields">
          <label>Schedule
            <select name="backupSchedulePreset" data-show-by>
              ${BACKUP_SCHEDULES.map((entry) => html`<option value="${entry.key}" ${preset === entry.key ? 'selected' : ''}>${entry.label}</option>`)}
              <option value="custom" ${preset === 'custom' ? 'selected' : ''}>Custom cron…</option>
            </select>
            <small>All times are UTC.</small>
          </label>
          <label>Keep at most<input name="backupsKeep" type="number" min="1" max="100" value="${c.backups.keep}"><small>Older automatic backups are deleted after each run.</small></label>
        </div>
        <div data-show-for="custom" data-for-select="backupSchedulePreset" ${preset === 'custom' ? '' : 'hidden'}>
          <label>Cron expression<input name="backupSchedule" class="mono" value="${c.backups.schedule}" placeholder="0 2 * * *"><small>Five fields in UTC: minute, hour, day of month, month, day of week.</small></label>
        </div>
        <label class="check"><input type="checkbox" name="backupS3Enabled" data-show-by ${c.backups.s3.enabled ? 'checked' : ''}><span>Store ${local ? 'archives' : 'dumps'} in S3 storage</span><small>Off keeps them in the server's data directory.</small></label>
        <div class="stack-fields" data-show-for="on" data-for-select="backupS3Enabled" ${c.backups.s3.enabled ? '' : 'hidden'}>
          ${s3Fields('backupS3', c.backups.s3)}
          <label>Key prefix<input name="backupPrefix" class="mono" value="${c.backups.prefix ?? ''}" placeholder="backups">
            <small>${local ? 'Object keys go under this prefix. If Litestream uses the same bucket, keep the prefixes separate (for example <code>backups</code> here and <code>litestream</code> in the replica URL).' : 'Object keys go under this prefix. Keep it separate from other tools in the same bucket.'}</small></label>
        </div>
        ${local ? '' : html`<p class="help"><code>pg_dump</code> must be installed on this server, or set <code>PG_DUMP_BIN</code> to its path.</p>`}
        <div class="foot"><button class="primary">Save backup settings</button></div>
      </form>`,
      {
        id: 'backup-options',
        badge: control.settings.overridden('backups')
          ? html`${badge('Custom', 'info')} ${destroy(`${BACKUPS}/reset`, 'Reset', 'Reset backup settings to the defaults?')}`
          : badge('Default'),
      },
    )}
    ${local
      ? html`${settingsSection(
          'Continuous replication (Litestream)',
          'Stream every SQLite change to object storage, so recovery can reach the latest write instead of only the last archive.',
          html`${storedLitestream
              ? alert(
                  'info',
                  html`Console settings saved${litestreamSettings.enabled
                    ? html` for <code class="mono">${maskReplica(litestreamSettings.replicaUrl)}</code>`
                    : ' with replication turned off'}. Restart Bunwrite to apply them.`,
                )
              : litestream.configured
                ? alert(
                    'info',
                    html`Using the server environment for <code class="mono">${litestream.replica}</code> · every ${litestream.syncInterval}${litestream.heartbeat ? ' · heartbeat on' : ''}. Save below to manage it here.`,
                  )
                : alert(
                    'warning',
                    html`Not configured. Without Litestream, recovery can only reach the last archive above, so writes since then are lost if the host or disk fails. Turn it on below to add a replica, or set the Litestream variables in the server environment.`,
                  )}
            <form method="post" action="${BACKUPS}/litestream" class="stack-fields">
              <label class="check"><input type="checkbox" name="litestreamEnabled" data-show-by ${litestreamSettings.enabled ? 'checked' : ''}><span>Enable continuous replication</span><small>Changes are written to the data directory and apply on the next restart.</small></label>
              <div class="stack-fields" data-show-for="on" data-for-select="litestreamEnabled" ${litestreamSettings.enabled ? '' : 'hidden'}>
                <label>Replica URL<input name="litestreamReplicaUrl" class="mono" value="${litestreamSettings.replicaUrl}" placeholder="s3://my-bucket/bunwrite"><small>Use a bucket/prefix dedicated to this instance. S3, GCS, Azure Blob and file URLs are accepted.</small></label>
                <div class="fields">
                  <label>S3 access key ID<input name="litestreamAccessKeyId" value="${litestreamSettings.accessKeyId}" autocomplete="off"><small>Leave both credentials empty to use an instance role.</small></label>
                  <label>Secret access key<input name="litestreamSecretAccessKey" type="password" autocomplete="new-password" placeholder="${litestreamSettings.secretAccessKey ? 'Configured; leave blank to keep' : ''}"></label>
                </div>
                <label class="check"><input type="checkbox" name="clearLitestreamCredentials"><span>Remove stored S3 credentials</span></label>
                <details class="disclosure">
                  <summary>Advanced connection and retention settings</summary>
                  <div class="fields">
                    <label>Region<input name="litestreamRegion" value="${litestreamSettings.region}" placeholder="us-east-1 or auto"></label>
                    <label>S3 endpoint<input name="litestreamEndpoint" type="url" class="mono" value="${litestreamSettings.endpoint}" placeholder="https://…r2.cloudflarestorage.com"><small>Optional. R2, MinIO and other S3-compatible stores need it.</small></label>
                  </div>
                  <label class="check"><input type="checkbox" name="litestreamForcePathStyle" ${litestreamSettings.forcePathStyle ? 'checked' : ''}><span>Use path-style S3 addressing</span><small>Most non-AWS providers need this.</small></label>
                  <div class="fields">
                    <label>Sync interval<input name="litestreamSyncInterval" value="${litestreamSettings.syncInterval}" placeholder="1s"><small>How often WAL frames are pushed.</small></label>
                    <label>Heartbeat URL<input name="litestreamHeartbeatUrl" type="url" class="mono" value="${litestreamSettings.heartbeatUrl}" placeholder="Optional Healthchecks.io ping URL"></label>
                  </div>
                  <div class="fields">
                    <label>Snapshot interval<input name="litestreamSnapshotInterval" value="${litestreamSettings.snapshotInterval}" placeholder="24h"></label>
                    <label>Snapshot retention<input name="litestreamSnapshotRetention" value="${litestreamSettings.snapshotRetention}" placeholder="168h"></label>
                    <label>L0 retention<input name="litestreamL0Retention" value="${litestreamSettings.l0Retention}" placeholder="24h"></label>
                  </div>
                </details>
              </div>
              <div class="foot"><button class="primary">Save replication settings</button></div>
            </form>
            ${storedLitestream
              ? html`<div class="disclosure"><p class="subdued">Remove the console override and use the server environment again.</p>${destroy(`${BACKUPS}/litestream/reset`, 'Reset to environment', 'Remove the saved Litestream settings and use the server environment on the next restart?')}</div>`
              : ''}
            <p class="help">Litestream streams SQLite WAL frames to the replica and restores missing databases on start. Run <code>bunwrite failover</code> on a replacement host; this is disaster recovery, not active/active HA.</p>
            <p class="help">Databases only — back up <code>STORAGE_PATH</code> or the uploads bucket separately, and use distinct key prefixes if backups share the bucket.</p>
            ${litestream.allowEmpty ? alert('warning', html`<code>LITESTREAM_ALLOW_EMPTY</code> is set. A missing restore point will start an empty instance instead of failing closed; remove it after the first deployment.`) : ''}
            ${litestream.forceRestore ? alert('critical', html`<code>LITESTREAM_FORCE_RESTORE</code> is set. Every start replaces local databases from the replica; remove it unless you mean it.`) : ''}`,
          {
            id: 'litestream',
            badge: storedLitestream ? badge('Console', 'info') : litestream.configured ? badge('Environment') : badge('Off'),
          },
        )}`
      : ''}
    ${local
      ? pending
        ? settingsSection(
            'Restore staged',
            'This archive was validated and is waiting for the next start.',
            html`<div class="toolbar">
                <div class="backup-meta"><span class="mono clip" title="${pending.name}">${pending.name}</span><span class="subdued cell-sub">Uploaded ${pending.uploadedAt ? when(pending.uploadedAt) : 'earlier'}</span></div>
                <form method="post" action="${BACKUPS}/restore/cancel" class="inline" style="margin-left:auto" data-confirm="Cancel the staged restore?" data-confirm-label="Cancel restore" data-confirm-tone="critical"><button class="critical small">Cancel staged restore</button></form>
              </div>
              <p>Restart Bunwrite to apply it. The control database and every project database are replaced; the previous files stay as <code>*.before-restore-&lt;timestamp&gt;</code>.</p>
              <p>Uploaded files, function code and site builds are not in the archive.</p>`,
            { id: 'backup-pending', badge: badge('Waiting for restart', 'attention') },
          )
        : settingsSection(
            'Restore from archive',
            'Upload an archive to validate it now. It is applied the next time Bunwrite starts.',
            html`<form method="post" action="${BACKUPS}/restore" enctype="multipart/form-data" hx-boost="false" class="stack-fields"
                data-confirm="Stage this archive? The control database and every project database will be replaced when Bunwrite next starts." data-confirm-label="Stage restore" data-confirm-tone="critical">
              ${fileField({
                name: 'backup',
                label: 'Backup archive',
                accept: '.zst,.enc,application/x-bunwrite-archive',
                required: true,
                title: 'Drag and drop a backup archive here',
                hint: '.archive.zst or .archive.zst.enc',
                help: html`A <code>.archive.zst</code> or <code>.archive.zst.enc</code> file from this server.`,
              })}
              <label>Encryption key <span class="subdued">(only for encrypted archives)</span><input type="password" name="backupKey" autocomplete="off" placeholder="BACKUP_ENCRYPTION_KEY">
                <small>Leave empty to use <code>BACKUP_ENCRYPTION_KEY</code> from the server environment.</small></label>
              <div class="foot"><button class="critical">Validate and stage</button></div>
            </form>
            <p class="help">After staging, restart Bunwrite from your host (<code>docker compose restart bunwrite</code> or <code>systemctl restart bunwrite</code>). You can still run <code>bunwrite restore &lt;file&gt;</code> with the server stopped.</p>`,
            { id: 'backup-restore', badge: badge('Replaces all databases', 'critical') },
          )
      : settingsSection(
          'Restore a Postgres backup',
          'Download a dump, unpack it, and load it with pg_restore while Bunwrite is stopped.',
          html`<pre>bunwrite backup:open backup-....dump.zst bunwrite.dump
pg_restore --clean --if-exists --dbname="$DATABASE_URL" bunwrite.dump</pre>
            <p class="help">Encrypted dumps read <code>BACKUP_ENCRYPTION_KEY</code>; without that key they cannot be opened. Restoring replaces the database, so stop Bunwrite first. Uploaded files, function code and site builds are not in the dump.</p>`,
          { id: 'postgres-restore', badge: badge('Operator step', 'attention') },
        )}`
}
