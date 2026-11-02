/**
 * The guided backup setup and the readiness card at the top of the backups
 * page. The wizard owns no privileged work: it saves what the console can save,
 * then turns the remaining host-side steps into a numbered, copyable list and
 * checks the live state again on refresh.
 */
import { doctorLabel, doctorTone, type PostgresDoctorReport } from '~/backups/postgres'
import { firstIncompleteStep, type BackupReadiness, type ReadinessStep } from '~/backups/readiness'
import type { BackupsConfig } from '~/config'
import { html, type Html } from '~/console/html'
import { alert, badge, formatBytes, icon, when } from '~/console/ui'
import { BACKUPS, BACKUP_SCHEDULES, BACKUP_SETUP, schedulePreset } from './backup-shared'
import { s3Fields } from './settings'

const STEP_ICON = { done: 'check-circle', warn: 'warning-circle', todo: 'info' } as const

/** The persistent progress card shown above the detailed backup settings. */
export function backupReadinessCard(readiness: BackupReadiness, startStep = firstIncompleteStep(readiness)): Html {
  const tone = readiness.complete ? 'success' : readiness.stage === 'unprotected' ? 'attention' : 'info'
  const action = readiness.complete ? 'Review setup' : 'Finish setup'
  const target = `${BACKUP_SETUP}?step=${startStep}`
  return html`<div class="card readiness-card">
    <div class="readiness-head">
      <div>
        <div class="readiness-kicker">Backup protection ${badge(readiness.complete ? 'Verified' : `${readiness.done} of ${readiness.total}`, tone)}</div>
        <h2>${readiness.title}</h2>
        <p class="subdued">${readiness.summary}</p>
      </div>
      <div class="readiness-progress">
        <b>${readiness.percent}%</b>
        <div class="readiness-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${readiness.percent}"><span style="width:${readiness.percent}%"></span></div>
      </div>
    </div>
    <ul class="readiness-steps">
      ${readiness.steps.map(
        (step) => html`<li class="${step.status}">
          ${icon(STEP_ICON[step.status], 18)}
          <div><b>${step.label}</b><span>${step.detail}</span></div>
        </li>`,
      )}
    </ul>
    <div class="foot">
      <a class="btn ${readiness.complete ? '' : 'primary'}" href="${target}">${action}</a>
    </div>
  </div>`
}

export interface BackupSetupInput {
  driver: 'sqlite' | 'postgres'
  step: number
  readiness: BackupReadiness
  backups: BackupsConfig
  latestBackup?: { name: string; size: number; modified: string }
  report?: PostgresDoctorReport | null
  verified?: boolean
  error?: string
}

const STEP_LABELS = {
  sqlite: ['Where backups live', 'When to run', 'First backup', 'Test a restore'],
  postgres: ['Where backups live', 'WAL archiving', 'Base backup', 'Test a restore'],
} as const

const STEP_HINTS = {
  sqlite: [
    'Pick one place. Off-site storage survives a lost server; local storage is faster but leaves with the disk.',
    'A schedule means nobody has to remember. Daily at 02:00 UTC is a good default.',
    'Create one archive now so there is something to recover from today.',
    'Bunwrite opens the newest archive in a temporary folder and checks every database. Live data is not touched.',
  ],
  postgres: [
    'WAL-G stores base backups and every WAL segment in S3-compatible storage. Enter the same credentials the database host will use.',
    'Postgres must archive each WAL segment as it is written. Add the settings below to the database host, then restart Postgres.',
    'A base backup is the starting point that WAL replay builds on. Take one after archiving is on.',
    'Restore the backup into an isolated container and check it. Production stays untouched until you switch over.',
  ],
} as const

function stepper(input: BackupSetupInput): Html {
  const labels = STEP_LABELS[input.driver]
  const keys: ReadinessStep['key'][] = ['storage', 'schedule', 'archive', 'drill']
  return html`<ol class="wizard-steps">
    ${labels.map((label, index) => {
      const status = input.readiness.steps.find((step) => step.key === keys[index])?.status ?? 'todo'
      const current = input.step === index + 1
      return html`<li class="${status !== 'todo' ? 'done' : ''} ${current ? 'on' : ''}">
        <a href="${BACKUP_SETUP}?step=${index + 1}"><span class="num">${status !== 'todo' ? icon('check', 14) : index + 1}</span>${label}</a>
      </li>`
    })}
  </ol>`
}

function stepCard(index: number, input: BackupSetupInput, body: Html): Html {
  return html`<div class="card wizard-card">
    <div class="wizard-head">
      <span class="wizard-count">Step ${index} of 4</span>
      <h2>${STEP_LABELS[input.driver][index - 1]}</h2>
      <p class="subdued">${STEP_HINTS[input.driver][index - 1]}</p>
    </div>
    ${body}
  </div>`
}

function skippable(): Html {
  return html`<div class="wizard-skip"><a class="subdued" href="${BACKUPS}">I will finish this later</a></div>`
}

function storageStep(input: BackupSetupInput): Html {
  const s3 = input.backups.s3
  const postgres = input.driver === 'postgres'
  const mode = postgres || s3.enabled ? 's3' : 'local'
  const prefix = input.backups.prefix ?? ''
  return stepCard(
    1,
    input,
    html`<form method="post" action="${BACKUP_SETUP}/storage" class="stack-fields">
      ${postgres
        ? html`<input type="hidden" name="storageMode" value="s3">`
        : html`<div class="choice" role="radiogroup" aria-label="Backup storage">
            <label><input type="radio" name="storageMode" value="s3" data-show-by ${mode === 's3' ? 'checked' : ''}><span><b>Off-site storage (recommended)</b><span>Any S3-compatible bucket. The backups survive losing this server.</span></span></label>
            <label><input type="radio" name="storageMode" value="local" data-show-by ${mode === 'local' ? 'checked' : ''}><span><b>This server only</b><span>No setup. If the VPS is lost, the backups are lost with it.</span></span></label>
          </div>`}
      <div data-show-for="s3" data-for-select="storageMode" ${mode === 's3' ? '' : 'hidden'}>
        ${postgres ? alert('info', html`WAL-G runs on the Postgres host. Bunwrite remembers these values so it can generate the host commands, but it cannot install or restart WAL-G for you.`) : ''}
        ${s3Fields('backupS3', s3)}
        <p class="help">Leave the endpoint empty for AWS S3. R2, MinIO, Supabase and most other providers need their endpoint and path-style addressing.</p>
        <label>Key prefix<input name="backupPrefix" class="mono" value="${prefix}" placeholder="${postgres ? 'bunwrite/postgres' : 'backups'}"><small>${postgres ? 'WAL-G stores base backups and WAL under this prefix. Keep it separate from other tools in the same bucket.' : 'Backups go under this prefix. Keep it different from the Litestream replica prefix.'}</small></label>
      </div>
      <div data-show-for="local" data-for-select="storageMode" ${mode === 'local' ? '' : 'hidden'}>
        ${alert('warning', html`Backups on this server protect against a bad migration or a corrupted database, not against losing the VPS. You can add off-site storage later.`)}
      </div>
      <div class="foot"><a class="btn" href="${BACKUPS}">Cancel</a><button class="primary">Save and continue</button></div>
    </form>${skippable()}`,
  )
}

function scheduleFields(input: BackupSetupInput): Html {
  const preset = schedulePreset(input.backups.schedule)
  return html`<div class="fields">
      <label>How often
        <select name="backupSchedulePreset" data-show-by>
          ${BACKUP_SCHEDULES.map((entry) => html`<option value="${entry.key}" ${preset === entry.key ? 'selected' : ''}>${entry.label}</option>`)}
          <option value="custom" ${preset === 'custom' ? 'selected' : ''}>Custom cron…</option>
        </select>
        <small>All times are UTC.</small>
      </label>
      <label>Keep at most<input name="backupsKeep" type="number" min="1" max="100" value="${input.backups.keep}"><small>Older automatic backups are removed after each run.</small></label>
    </div>
    <div data-show-for="custom" data-for-select="backupSchedulePreset" ${preset === 'custom' ? '' : 'hidden'}>
      <label>Cron expression<input name="backupSchedule" class="mono" value="${input.backups.schedule}" placeholder="0 2 * * *"><small>Five fields: minute, hour, day of month, month, day of week.</small></label>
    </div>`
}

function scheduleStep(input: BackupSetupInput): Html {
  if (input.driver === 'postgres') return archiveStep(input)
  return stepCard(
    2,
    input,
    html`<form method="post" action="${BACKUP_SETUP}/schedule" class="stack-fields">
      <input type="hidden" name="backupsEnabled" value="on">
      ${scheduleFields(input)}
      <div class="foot"><a class="btn" href="${BACKUP_SETUP}?step=1">Back</a><button class="primary">Save schedule</button></div>
    </form>${skippable()}`,
  )
}

function archiveStep(input: BackupSetupInput): Html {
  const report = input.report
  const status = report?.status
  const archiver = status?.archiver
  const on = status?.settings.archiveMode === 'on' && status?.settings.walLevel === 'replica'
  const pgdata = status?.dataDirectory ?? '/var/lib/postgresql/16/main'
  const env = walgEnv(input.backups)
  return stepCard(
    2,
    input,
    html`${on
        ? alert('success', html`WAL archiving is on${archiver?.lastArchivedAt ? `; the last segment was archived ${when(archiver.lastArchivedAt)}` : ''}. ${archiver && archiver.failedCount > 0 ? `${archiver.failedCount} archive failures need a look in pg_stat_archiver.` : ''}`)
        : alert('warning', html`WAL archiving is not on yet. Add the settings below on the database host, then restart Postgres.`)}
      <ol class="wizard-list">
        <li><b>Set the WAL-G environment</b><p class="subdued">Put this in the environment the Postgres service reads, for example <code>/etc/postgresql/&lt;version&gt;/main/environment</code> on Debian and Ubuntu.</p>
          <div class="code-block"><pre id="walg-env">${env}</pre><button type="button" class="small" data-copy-target="#walg-env">${icon('copy')}<span data-copy-label>Copy</span></button></div>
        </li>
        <li><b>Turn on archiving</b><p class="subdued">Add these to <code>postgresql.conf</code> (or a file in <code>conf.d</code>), then restart Postgres.</p>
          <div class="code-block"><pre id="walg-conf">wal_level = replica
archive_mode = on
archive_command = 'wal-g wal-push %p'
restore_command = 'wal-g wal-fetch %f %p'</pre><button type="button" class="small" data-copy-target="#walg-conf">${icon('copy')}<span data-copy-label>Copy</span></button></div>
        </li>
        <li><b>Check again</b><p class="subdued">This page reads the live server, so it updates as soon as archiving is visible.</p>
          <a class="btn" href="${BACKUP_SETUP}?step=2">Check again</a>
        </li>
      </ol>
      <details class="disclosure"><summary>What Bunwrite can see right now</summary>
        <ul class="list doctor-checks">${(report?.checks ?? []).map(
          (check) => html`<li><div><b>${check.label}</b><div class="subdued cell-sub">${check.detail}</div>${check.fix ? html`<div class="help"><code>${check.fix}</code></div>` : ''}</div>${badge(doctorLabel(check.status), doctorTone(check.status))}</li>`,
        )}</ul>
        <p class="help">Data directory: <code>${pgdata}</code></p>
      </details>
      ${archiveCron(input, pgdata)}${skippable()}`,
  )
}

function archiveCron(input: BackupSetupInput, pgdata: string): Html {
  const cron = input.backups.schedule
  const prefix = (input.backups.prefix ?? '').replace(/^\/+|\/+$/g, '') || 'bunwrite/postgres'
  return html`<details class="disclosure"><summary>Automate base backups</summary>
    <p class="subdued">WAL archiving is continuous, but a base backup is the starting point for recovery. Create a small wrapper that loads the WAL-G environment, then run it from cron.</p>
    <div class="code-block"><pre id="walg-cron">sudo tee /usr/local/bin/bunwrite-pg-backup >/dev/null <<'EOF'
#!/bin/sh
set -eu
export PGDATA=${pgdata}
set -a; . /etc/postgresql/*/main/environment; set +a
exec wal-g backup-push "$PGDATA"
EOF
sudo chmod +x /usr/local/bin/bunwrite-pg-backup

# ${cron} (UTC), keeping ${input.backups.keep} base backups:
# ${cron} root /usr/local/bin/bunwrite-pg-backup >> /var/log/bunwrite-pg-backup.log 2>&1
# Retention, weekly:
# 30 3 * * 0 postgres wal-g delete retain FULL ${input.backups.keep} --confirm</pre><button type="button" class="small" data-copy-target="#walg-cron">${icon('copy')}<span data-copy-label>Copy</span></button></div>
    <p class="help">Prefix: <code>s3://${input.backups.s3.bucket || '<bucket>'}/${prefix}</code></p>
  </details>`
}

function walgEnv(config: BackupsConfig): string {
  const s3 = config.s3
  const prefix = (config.prefix ?? '').replace(/^\/+|\/+$/g, '') || 'bunwrite/postgres'
  const lines = [
    `WALG_S3_PREFIX='s3://${s3.bucket || '<bucket>'}/${prefix}'`,
    `AWS_ACCESS_KEY_ID='${s3.accessKey || '<access key>'}'`,
    "AWS_SECRET_ACCESS_KEY='<the secret you entered in step 1>'",
    `AWS_DEFAULT_REGION='${s3.region || 'us-east-1'}'`,
  ]
  if (s3.endpoint) lines.push(`AWS_ENDPOINT_URL='${s3.endpoint}'`)
  if (s3.forcePathStyle) lines.push("AWS_S3_FORCE_PATH_STYLE='true'")
  return lines.join('\n')
}

function firstBackupStep(input: BackupSetupInput): Html {
  const latest = input.latestBackup
  const detected = input.driver === 'postgres' ? Boolean(input.report?.walg.backups[0]) : Boolean(latest)
  const pgdata = input.report?.status.dataDirectory ?? '/var/lib/postgresql/16/main'
  return stepCard(
    3,
    input,
    html`${detected
        ? alert('success', html`A backup exists${latest ? html`: <code class="mono">${latest.name}</code> (${formatBytes(latest.size)}, ${when(latest.modified)})` : input.report?.walg.backups[0] ? html`: <code class="mono">${input.report.walg.backups[0].name}</code>` : ''}.`)
        : input.driver === 'sqlite'
          ? alert('info', html`Nothing to recover from yet. Create the first archive now; it usually takes seconds.`)
          : alert('info', html`Take a base backup on the database host once archiving is on.`)}
      ${input.driver === 'postgres'
        ? html`<div class="code-block"><pre id="walg-push"># On the Postgres host, with the environment from step 2 loaded:
export PGDATA=${pgdata}
wal-g backup-push "$PGDATA"
wal-g backup-list</pre><button type="button" class="small" data-copy-target="#walg-push">${icon('copy')}<span data-copy-label>Copy</span></button></div>
          <form method="post" action="${BACKUP_SETUP}/first" class="stack-fields">
            <label class="check"><input type="checkbox" name="baseBackupConfirmed" required><span>I ran the base backup and wal-g backup-list shows it</span></label>
            <div class="foot"><a class="btn" href="${BACKUP_SETUP}?step=2">Back</a><a class="btn" href="${BACKUP_SETUP}?step=3">Check again</a><button class="primary">Continue</button></div>
          </form>`
        : latest
          ? html`<div class="foot" style="justify-content:flex-start"><a class="btn" href="${BACKUP_SETUP}?step=2">Back</a><a class="btn primary" href="${BACKUP_SETUP}?step=4">Continue to restore test</a></div>
              <form method="post" action="${BACKUP_SETUP}/first" class="inline" style="margin-top:8px"><button class="small">Create another backup</button></form>`
          : html`<form method="post" action="${BACKUP_SETUP}/first" class="stack-fields">
              <div class="foot"><a class="btn" href="${BACKUP_SETUP}?step=2">Back</a><button class="primary">Create first backup</button></div>
            </form>`}
      ${skippable()}`,
  )
}

function verifyStep(input: BackupSetupInput): Html {
  if (input.driver === 'postgres') return verifyPostgresStep(input)
  if (!input.latestBackup) {
    return stepCard(
      4,
      input,
      html`${alert('warning', html`Create a backup before testing a restore.`)}<div class="foot" style="justify-content:flex-start"><a class="btn" href="${BACKUP_SETUP}?step=3">Back to step 3</a></div>`,
    )
  }
  return stepCard(
    4,
    input,
    html`${input.verified ? alert('success', html`Restore test passed. This backup was opened and every database inside it checked out.`) : ''}
      <p>The newest archive is <code class="mono">${input.latestBackup.name}</code> (${formatBytes(input.latestBackup.size)}, ${when(input.latestBackup.modified)}).</p>
      <p class="subdued">The test extracts it into a temporary directory, runs an integrity check and the Bunwrite shape check on every database, then deletes the temporary copy. It does not replace live data.</p>
      <form method="post" action="${BACKUP_SETUP}/verify" class="stack-fields">
        <div class="foot" style="justify-content:flex-start"><a class="btn" href="${BACKUP_SETUP}?step=3">Back</a><button class="primary">${input.verified ? 'Test again' : 'Run restore test'}</button></div>
      </form>${skippable()}`,
  )
}

function verifyPostgresStep(input: BackupSetupInput): Html {
  const env = walgEnv(input.backups)
  const database = input.report?.status.database ?? 'bunwrite'
  return stepCard(
    4,
    input,
    html`${input.verified ? alert('success', html`Restore test recorded. Keep the old backups and the note with the date of the last test.`) : alert('info', html`The safest check is the isolated Docker target: it restores into a fresh volume and leaves production untouched.`)}
      <ol class="wizard-list">
        <li><b>Start the isolated restore</b><p class="subdued">Run this on a host with Docker and this repository. It fetches the latest base backup into a new volume.</p>
          <div class="code-block"><pre id="pg-restore-env">${env}
docker compose -f docker-compose.restore.yml --profile restore up --build postgres-restore</pre><button type="button" class="small" data-copy-target="#pg-restore-env">${icon('copy')}<span data-copy-label>Copy</span></button></div>
        </li>
        <li><b>Check that it recovered</b><p class="subdued">Use the original database user and password from <code>DATABASE_URL</code>, only the host and port change.</p>
          <div class="code-block"><pre id="pg-restore-check">psql 'postgres://USER:PASSWORD@127.0.0.1:55432/${database}' -c 'SELECT pg_is_in_recovery();'</pre><button type="button" class="small" data-copy-target="#pg-restore-check">${icon('copy')}<span data-copy-label>Copy</span></button></div>
          <p class="help">It should return <code>f</code>. Then spot-check a few recent rows before you trust it.</p>
        </li>
        <li><b>Clean up and record it</b><p class="subdued">Stop the test instance when you are done.</p>
          <div class="code-block"><pre id="pg-restore-down">docker compose -f docker-compose.restore.yml --profile restore down</pre><button type="button" class="small" data-copy-target="#pg-restore-down">${icon('copy')}<span data-copy-label>Copy</span></button></div>
        </li>
      </ol>
      <form method="post" action="${BACKUP_SETUP}/verify" class="stack-fields">
        <label class="check"><input type="checkbox" name="drillConfirmed" required><span>I restored the backup and the check returned <code>f</code></span></label>
        <div class="foot" style="justify-content:flex-start"><a class="btn" href="${BACKUP_SETUP}?step=3">Back</a><button class="primary">Record restore test</button></div>
      </form>
      <p class="help">The full point-in-time runbook is on the <a href="${BACKUPS}#postgres-restore">backups page</a>.</p>${skippable()}`,
  )
}

function doneStep(input: BackupSetupInput): Html {
  return html`<div class="card wizard-card">
    <div class="wizard-head">
      <span class="wizard-count">Setup complete</span>
      <h2>${input.readiness.complete ? 'This instance is protected' : 'Almost protected'}</h2>
      <p class="subdued">${input.readiness.complete ? 'Backups are running and a restore has been tested. The schedule keeps working while nobody is watching.' : input.readiness.summary}</p>
    </div>
    ${input.readiness.complete ? alert('success', html`You can close this page. Bunwrite keeps the schedule and reports failures on the backups page.`) : alert('warning', html`Some steps are still open. The readiness card on the backups page shows what is missing.`)}
    <ul class="readiness-steps">
      ${input.readiness.steps.map(
        (step) => html`<li class="${step.status}">${icon(STEP_ICON[step.status], 18)}<div><b>${step.label}</b><span>${step.detail}</span></div></li>`,
      )}
    </ul>
    <div class="foot"><a class="btn" href="${BACKUP_SETUP}?step=4">Test restore again</a><a class="btn primary" href="${BACKUPS}">Back to backups</a></div>
  </div>`
}

/** The whole setup page body: stepper plus the current step. */
export function backupSetupView(input: BackupSetupInput): Html {
  const body =
    input.step === 1
      ? storageStep(input)
      : input.step === 2
        ? scheduleStep(input)
        : input.step === 3
          ? firstBackupStep(input)
          : input.step === 4
            ? verifyStep(input)
            : doneStep(input)
  return html`${input.error ? alert('critical', html`${input.error}`) : ''}
    <div class="wizard">
      <div class="wizard-title">
        <div>
          <h1>Back up this instance</h1>
          <p class="subdued">Four short steps. You can leave and come back; the card on the backups page remembers where you stopped.</p>
        </div>
        <a class="btn" href="${BACKUPS}">Back to backups</a>
      </div>
      ${stepper(input)}
      ${body}
      <p class="help">Backups cover the databases only. Uploaded files, function code and site builds live in <code>STORAGE_PATH</code> or your uploads bucket and need their own copy.</p>
    </div>`
}
