/** Organization-level whole-instance backups: one archive for every project. */
import { readPendingRestore } from '~/backups/pending'
import type { BackupFile } from '~/backups/service'
import { litestreamStatus, maskReplica } from '~/backups/litestream'
import { litestreamSettingsFromEnv, readLitestreamSettings } from '~/backups/litestream-settings'
import { walgStatus } from '~/backups/walg'
import type { ConsoleContext } from '~/console/context'
import { html, type Html } from '~/console/html'
import { alert, badge, destroy, emptyState, formatBytes, settingsSection, when } from '~/console/ui'
import { s3Fields } from './settings'

export const BACKUPS = '/console/organization/backups'

export async function backupsView(ctx: ConsoleContext): Promise<Html> {
  const control = ctx.projects.control
  const c = control.config
  // Whole-instance archives use VACUUM INTO on local SQLite files. Postgres
  // deployments use WAL-G or the provider's managed PITR instead.
  if (!control.db.capabilities.localFile) return postgresBackupsView()
  let backups: BackupFile[] = []
  let error = ''
  try {
    backups = await control.backups.list()
  } catch (problem) {
    error = problem instanceof Error ? problem.message : String(problem)
  }
  const pending = readPendingRestore(c.databasePath)
  const litestream = litestreamStatus()
  const storedLitestream = readLitestreamSettings(c.databasePath)
  const litestreamSettings = storedLitestream ?? litestreamSettingsFromEnv()
  const encryption = c.backupEncryptionKey
    ? alert('info', html`Backups are compressed and encrypted with <code>BACKUP_ENCRYPTION_KEY</code>. Keep a copy of that key somewhere other than this server; without it the backups cannot be opened. Restore one here, or with <code>bunwrite restore &lt;file&gt;</code>.`)
    : alert('warning', html`Backups are compressed but not encrypted, and they include every project's stored secrets. Set <code>BACKUP_ENCRYPTION_KEY</code> in the server environment (for example from <code>openssl rand -base64 32</code>) and restart to encrypt new backups.`)
  return html`
    ${error ? alert('critical', html`${error}`) : ''}
    ${encryption}
    ${settingsSection(
      'Backups',
      'One archive covers the control database and every project database. Automatic backups run once a day at 02:00 UTC.',
      html`<div class="toolbar"><h2 style="margin:0">Saved backups</h2>
          <form method="post" action="${BACKUPS}/create" class="inline" style="margin-left:auto"><button class="primary">Create backup</button></form>
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
          : emptyState('No backups yet', 'Create one now, or wait for the daily automatic backup.')}`,
      { id: 'backups', flush: true },
    )}
    ${pending
      ? settingsSection(
          'Restore staged',
          'This archive was validated and is waiting for the next start.',
          html`<div class="toolbar">
              <div class="backup-meta"><span class="mono clip" title="${pending.name}">${pending.name}</span><span class="subdued cell-sub">Uploaded ${pending.uploadedAt ? when(pending.uploadedAt) : 'earlier'}</span></div>
              <form method="post" action="${BACKUPS}/restore/cancel" class="inline" style="margin-left:auto" data-confirm="Cancel the staged restore?" data-confirm-label="Cancel restore" data-confirm-tone="critical"><button class="critical small">Cancel staged restore</button></form>
            </div>
            <p>Restart Bunwrite to apply it. The control database and every project database are replaced; the previous files stay as <code>*.before-restore-&lt;timestamp&gt;</code>.</p>
            <p>Uploaded files, function code and site builds are not in the archive.</p>`,
          { id: 'backup-pending' },
        )
      : settingsSection(
          'Restore archive',
          'Upload a backup here. Bunwrite validates it now and applies it the next time it starts, so there is no CLI step.',
          html`<form method="post" action="${BACKUPS}/restore" enctype="multipart/form-data" hx-boost="false" class="stack-fields"
              data-confirm="Stage this archive? The control database and every project database will be replaced when Bunwrite next starts." data-confirm-label="Stage restore" data-confirm-tone="critical">
            <label>Backup archive<input type="file" name="backup" accept=".zst,.enc,application/x-bunwrite-archive" required>
              <small>A <code>.archive.zst</code> or <code>.archive.zst.enc</code> file from this server.</small></label>
            <label>Encryption key <span class="subdued">(only for encrypted archives)</span><input type="password" name="backupKey" autocomplete="off" placeholder="BACKUP_ENCRYPTION_KEY">
              <small>Leave empty to use <code>BACKUP_ENCRYPTION_KEY</code> from the server environment.</small></label>
            <div class="foot"><button class="critical">Validate and stage</button></div>
          </form>
          <p class="subdued">After staging, restart Bunwrite from your host (<code>docker compose restart bunwrite</code> or <code>systemctl restart bunwrite</code>). The archive is applied before the database opens. You can still run <code>bunwrite restore &lt;file&gt;</code> manually with the server stopped.</p>`,
          { id: 'backup-restore' },
        )}
    ${settingsSection(
      'Continuous replication (Litestream)',
      'Continuous WAL replication to object storage, separate from the archives above. Save it here; restart Bunwrite to apply it.',
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
                html`Not configured. Without Litestream, recovery can only reach the last archive above, so writes since then are lost if the host or disk fails. Configure a replica below, or set the Litestream variables in the server environment.`,
              )}
        <form method="post" action="${BACKUPS}/litestream">
          <label class="check"><input type="checkbox" name="litestreamEnabled" ${litestreamSettings.enabled ? 'checked' : ''}><span>Enable continuous replication</span><small>Changes are written to the data directory and apply on the next restart.</small></label>
          <label>Replica URL<input name="litestreamReplicaUrl" class="mono" value="${litestreamSettings.replicaUrl}" placeholder="s3://my-bucket/bunwrite"><small>Use a bucket/prefix dedicated to this instance. S3, GCS, Azure Blob and file URLs are accepted.</small></label>
          <div class="fields">
            <label>S3 access key ID<input name="litestreamAccessKeyId" value="${litestreamSettings.accessKeyId}" autocomplete="off"><small>Leave both credentials empty to use an instance role.</small></label>
            <label>Secret access key<input name="litestreamSecretAccessKey" type="password" autocomplete="new-password" placeholder="${litestreamSettings.secretAccessKey ? 'Configured; leave blank to keep' : ''}"></label>
          </div>
          <label class="check"><input type="checkbox" name="clearLitestreamCredentials"><span>Remove stored S3 credentials</span></label>
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
          <div class="foot"><button class="primary">Save Litestream settings</button></div>
        </form>
        ${storedLitestream
          ? html`<div class="disclosure"><p class="subdued">Remove the console override and use the server environment again.</p>${destroy(`${BACKUPS}/litestream/reset`, 'Reset to environment', 'Remove the saved Litestream settings and use the server environment on the next restart?')}</div>`
          : ''}
        <p>Litestream streams SQLite WAL frames to the replica while the server runs. On start, the entrypoint restores missing databases; on a replacement host, run <code>bunwrite failover</code> before starting to restore the control database and every project database. It is single-writer disaster recovery, not active/active HA.</p>
        <p>It covers databases only. Uploaded files, function code and site builds are not replicated; back up <code>STORAGE_PATH</code> or the uploads bucket separately.</p>
        <p>If the replica and the backup archives share one bucket, use different key prefixes (for example <code>litestream</code> in the replica URL and <code>backups</code> in Backup options) and credentials scoped to each prefix.</p>
        <p class="subdued">The generated config lives beside the SQLite database. <code>bunwrite failover</code> restores the latest point; use Litestream's <code>restore -timestamp</code> for point-in-time recovery.</p>
        ${litestream.allowEmpty ? alert('warning', html`<code>LITESTREAM_ALLOW_EMPTY</code> is set. A missing restore point will start an empty instance instead of failing closed; remove it after the first deployment.`) : ''}
        ${litestream.forceRestore ? alert('critical', html`<code>LITESTREAM_FORCE_RESTORE</code> is set. Every start replaces local databases from the replica; remove it unless you mean it.`) : ''}`,
      {
        id: 'litestream',
        badge: storedLitestream ? badge('Console', 'info') : litestream.configured ? badge('Environment') : badge('Off'),
      },
    )}
    ${settingsSection(
      'Backup options',
      'Whole-instance backups: enable the daily run, choose how many to keep, and where they are stored.',
      html`<form method="post" action="${BACKUPS}">
        <label class="check"><input type="checkbox" name="backupsEnabled" ${c.backups.enabled ? 'checked' : ''}>Enable auto backups</label>
        <div class="fields"><label>Keep automatic backups<input name="backupsKeep" type="number" min="1" max="100" value="${c.backups.keep}"></label></div>
        <label class="check"><input type="checkbox" name="backupS3Enabled" ${c.backups.s3.enabled ? 'checked' : ''}>Store backups in S3 storage</label>
        ${s3Fields('backupS3', c.backups.s3)}
        <label>Key prefix<input name="backupPrefix" class="mono" value="${c.backups.prefix ?? ''}" placeholder="backups">
          <small>Object keys go under this prefix. If Litestream uses the same bucket, keep the prefixes separate (for example <code>backups</code> here and <code>litestream</code> in the replica URL).</small></label>
        <div class="foot"><button>Save</button></div>
      </form>`,
      {
        id: 'backup-options',
        badge: control.settings.overridden('backups')
          ? html`${badge('Custom', 'info')} ${destroy(`${BACKUPS}/reset`, 'Reset', 'Reset backup settings to the defaults?')}`
          : badge('Default'),
      },
    )}`
}

/**
 * Postgres backups run outside the app: WAL-G archives WAL and base backups on
 * the database host, or a managed provider exposes its own PITR. The console
 * reports the environment and the exact Postgres settings; it never starts a
 * backup-push against a data directory it does not own.
 */
function postgresBackupsView(): Html {
  const walg = walgStatus()
  return html`
    ${settingsSection(
      'Postgres continuous backup (WAL-G)',
      'Postgres uses WAL archiving and base backups on the database host instead of the SQLite archive files.',
      html`${walg.configured
        ? alert('success', html`WAL-G storage is configured for <code class="mono">${walg.storage}</code>${walg.compression ? html` · compression <code>${walg.compression}</code>` : ''}${walg.encrypted ? ' · encrypted' : ''}.`)
        : alert('warning', html`WAL-G is not configured in this process. Set <code>WALG_S3_PREFIX</code> (or another <code>WALG_*_PREFIX</code>) and the storage credentials where the Postgres server and <code>wal-g</code> run, then restart Postgres so it inherits them.`)}
      <p>WAL-G does not run inside Bunwrite: the Postgres server calls it through <code>archive_command</code> and operators take base backups with <code>wal-g backup-push</code>. Bunwrite cannot copy a remote <code>PGDATA</code>, so these settings belong on the database host.</p>
      <ul class="list">
        <li><span class="subdued">postgresql.conf</span><code>wal_level = replica</code> and <code>archive_mode = on</code></li>
        <li><span class="subdued">archive_command</span><code>${walg.archiveCommand}</code></li>
        <li><span class="subdued">restore_command</span><code>${walg.restoreCommand}</code></li>
        <li><span class="subdued">Base backup</span><code>wal-g backup-push $PGDATA</code> (cron or a systemd timer)</li>
        <li><span class="subdued">Point-in-time restore</span>restore the base backup with <code>wal-g backup-fetch $PGDATA LATEST</code>, create <code>recovery.signal</code>, and set <code>recovery_target_time</code> before starting Postgres.</li>
        <li><span class="subdued">Retention</span><code>wal-g delete retain FULL 7 --confirm</code></li>
      </ul>
      <p class="subdued">Uploaded files, function code and site builds are not in WAL-G; back up your storage bucket separately. If the provider offers managed PITR, use that instead of running WAL-G yourself.</p>`,
      { id: 'postgres-backup' },
    )}
    ${settingsSection(
      'Logical backups',
      'For a portable copy of one database, use pg_dump. It is slower to restore than WAL-G but easy to inspect.',
      html`<pre>pg_dump --format=custom --file=bunwrite.dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" bunwrite.dump</pre>
        <p class="subdued">A logical dump restores one point in time; it does not replace continuous WAL archiving.</p>`,
      { id: 'postgres-logical' },
    )}
    ${settingsSection(
      'SQLite archives',
      'The whole-instance archive, restore upload and Litestream controls are only available when DB_DRIVER=sqlite.',
      html`<p class="subdued">This instance uses Postgres, so those buttons are hidden instead of writing an archive to a local SQLite path that does not exist.</p>`,
      { id: 'sqlite-backup-disabled' },
    )}`
}
