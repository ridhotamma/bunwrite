/** Evaluation tab: run a golden set, inspect metrics and compare saved runs. */
import { html, type Html } from '~/console/html'
import { alert, badge, emptyState, settingsSection, when } from '~/console/ui'
import type { EvaluateResult, EvaluationRun, EvaluationRunSummary, VectorCollection } from '~/vectors/types'
import { collectionShell, collectionUrl, type VectorEnv } from './vectors'

export interface EvaluationDraft {
  name: string
  dataset: string
  topK: string
  generate: boolean
  hybrid: boolean
  rerank: boolean
  baselineId: string
}

export const emptyEvaluationDraft = (env: VectorEnv): EvaluationDraft => ({
  name: '',
  dataset: '[\n  {"id":"example","query":"What is the deployment process?","expectedDocuments":["deploy"],"expectedKeywords":["docker"]}\n]',
  topK: '5',
  generate: false,
  hybrid: env.hybrid,
  rerank: env.rerank,
  baselineId: '',
})

const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)
const fixed = (value: number | null) => (value === null ? '—' : value.toFixed(3))

function metricsList(result: EvaluateResult): Html {
  return html`<ul class="list">
    <li><span class="subdued">Recall@k</span><span>${percent(result.metrics.recallAtK)}</span></li>
    <li><span class="subdued">MRR</span><span>${fixed(result.metrics.mrr)}</span></li>
    <li><span class="subdued">nDCG@k</span><span>${fixed(result.metrics.ndcgAtK)}</span></li>
    <li><span class="subdued">Context keyword coverage</span><span>${percent(result.metrics.contextKeywordCoverage)}</span></li>
    <li><span class="subdued">Answer keyword coverage</span><span>${percent(result.metrics.answerKeywordCoverage)}</span></li>
    <li><span class="subdued">Refusal accuracy</span><span>${percent(result.metrics.refusalAccuracy)}</span></li>
    <li><span class="subdued">Average latency</span><span>${Math.round(result.metrics.averageLatencyMs)} ms</span></li>
  </ul>`
}

function caseTable(result: EvaluateResult): Html {
  return html`<div class="scroll">
    <table>
      <thead><tr><th>Case</th><th class="num">Recall</th><th class="num">MRR</th><th class="num">nDCG</th><th class="num">Keywords</th><th class="num">Latency</th><th>Result</th></tr></thead>
      <tbody>
        ${result.cases.map(
          (entry) => html`<tr>
            <td><strong>${entry.id}</strong><div class="subdued clip">${entry.query}</div></td>
            <td class="num">${percent(entry.recallAtK)}</td>
            <td class="num">${fixed(entry.reciprocalRank)}</td>
            <td class="num">${fixed(entry.ndcgAtK)}</td>
            <td class="num">${percent(entry.answerKeywordCoverage ?? entry.contextKeywordCoverage)}</td>
            <td class="num">${entry.latencyMs} ms</td>
            <td>${entry.passed ? badge('Pass', 'success') : badge('Fail', 'critical')}${entry.error ? html`<div class="subdued">${entry.error}</div>` : ''}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`
}

function runRows(base: string, runs: EvaluationRunSummary[]): Html {
  return html`<div class="scroll">
    <table>
      <thead><tr><th>Run</th><th class="num">Cases</th><th class="num">Passed</th><th class="num">Recall</th><th class="num">nDCG</th><th class="hide-sm">Created</th><th class="actions-col"></th></tr></thead>
      <tbody>
        ${runs.map(
          (run) => html`<tr>
            <td><a href="${base}/evaluation?run=${encodeURIComponent(run.$id)}" class="mono">${run.name || run.$id}</a></td>
            <td class="num">${run.total}</td>
            <td class="num">${run.passed}/${run.total}</td>
            <td class="num">${percent(run.metrics.recallAtK)}</td>
            <td class="num">${fixed(run.metrics.ndcgAtK)}</td>
            <td class="hide-sm subdued">${when(run.$createdAt)}</td>
            <td class="actions-col">
              <form method="post" action="${base}/evaluation/${encodeURIComponent(run.$id)}/delete" data-confirm="Delete this evaluation run?" data-confirm-label="Delete" data-confirm-tone="critical">
                <button class="plain critical">Delete</button>
              </form>
            </td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`
}

export function evaluationView(
  env: VectorEnv,
  options: {
    collection: VectorCollection
    runs: EvaluationRunSummary[]
    draft: EvaluationDraft
    result?: EvaluateResult
    selected?: EvaluationRun
    error?: string
  },
): Html {
  const { collection, draft } = options
  const base = collectionUrl(collection.$id)
  const result = options.result ?? options.selected?.result
  const regression = result?.regression
  return collectionShell(
    collection,
    'evaluation',
    html`${options.error ? alert('critical', html`${options.error}`) : ''}
      ${regression
        ? alert(
            regression.passed ? 'success' : 'critical',
            html`${regression.passed ? 'No regression' : 'Regression against the baseline'} <span class="mono">${regression.baselineName || regression.baselineId}</span>${
              regression.failures.length ? html`: ${regression.failures.join(', ')}` : ''
            }`,
          )
        : ''}
      ${settingsSection(
        'Run an evaluation',
        'Paste a JSON array of golden cases. Expected documents are matched by document ID; expected keywords are checked in the answer when generated, otherwise in the retrieved context.',
        html`<form method="post" action="${base}/evaluation">
          <div class="fields">
            <label>Run name<input name="name" value="${draft.name}" placeholder="Generated if empty" /></label>
            <label>Top k<input name="topK" type="number" min="1" max="20" value="${draft.topK}" required /><small>Evaluation uses at most 20 retrieved chunks.</small></label>
          </div>
          <label>Cases JSON<textarea name="dataset" class="mono" rows="12" spellcheck="false" required>${draft.dataset}</textarea></label>
          <div class="fields">
            <label>Baseline<select name="baselineId">
              <option value="">No baseline</option>
              ${options.runs.map(
                (run) => html`<option value="${run.$id}" ${run.$id === draft.baselineId ? 'selected' : ''}>${run.name || run.$id} · recall ${percent(run.metrics.recallAtK)}</option>`,
              )}
            </select><small>Compares recall, MRR, nDCG and keyword coverage.</small></label>
            <label class="check"
              ><input type="checkbox" name="generate" ${draft.generate ? 'checked' : ''} /><span>Generate answers</span
              ><small>Answer keyword coverage and refusal accuracy need a chat model.</small></label
            >
          </div>
          <div class="fields">
            <label class="check"><input type="checkbox" name="hybrid" ${draft.hybrid ? 'checked' : ''} /><span>Hybrid search</span></label>
            <label class="check"><input type="checkbox" name="rerank" ${draft.rerank ? 'checked' : ''} /><span>Rerank</span></label>
          </div>
          <div class="foot"><button class="primary">Run evaluation</button></div>
        </form>`,
      )}
      ${result
        ? html`${settingsSection(
            result.name ? `Result · ${result.name}` : 'Result',
            result.saved === false ? 'Ad-hoc run; not saved.' : 'Saved to the evaluation history.',
            metricsList(result),
          )}
          ${settingsSection('Cases', 'Per-case retrieval and answer checks.', caseTable(result), { flush: true })}`
        : ''}
      ${settingsSection(
        'History',
        'Saved runs for this collection, newest first. Open a run to inspect its cases.',
        options.runs.length ? runRows(base, options.runs) : emptyState('No evaluation runs', 'Run a golden set above to create the first saved result.', undefined),
        { flush: true },
      )}`,
  )
}
