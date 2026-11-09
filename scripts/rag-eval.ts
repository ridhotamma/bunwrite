/**
 * Run a golden question set against a Bunwrite RAG collection.
 *
 *   BUNWRITE_ENDPOINT=https://api.example.com/v1 \
 *   BUNWRITE_PROJECT=my-project \
 *   BUNWRITE_KEY=standard_xxx \
 *   bun run rag:eval --dataset ./rag-eval.json
 *
 * Dataset:
 * {
 *   "collectionId": "handbook",
 *   "topK": 5,
 *   "generate": false,
 *   "hybrid": true,
 *   "rerank": true,
 *   "cases": [
 *     {"id":"deploy","query":"How do I deploy?","expectedDocuments":["deploy"],"expectedKeywords":["docker"]},
 *     {"id":"unknown","query":"Do you sell cars?","expectRefusal":true}
 *   ]
 * }
 *
 * The server returns recall@k, MRR, nDCG@k, keyword coverage, refusal accuracy
 * and latency. The command exits non-zero when any case fails, which makes it
 * usable in CI.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface Args {
  dataset?: string
  endpoint: string
  project?: string
  key?: string
  json: boolean
}

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const exact = args.indexOf(`--${name}`)
  if (exact >= 0) return args[exact + 1]
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function argsOf(argv: string[]): Args {
  const args = argv.slice(2)
  return {
    dataset: flag(args, 'dataset') ?? process.env.RAG_EVAL_DATASET,
    endpoint: (flag(args, 'endpoint') ?? process.env.BUNWRITE_ENDPOINT ?? 'http://localhost:8080/v1').replace(/\/+$/, ''),
    project: flag(args, 'project') ?? process.env.BUNWRITE_PROJECT,
    key: flag(args, 'key') ?? process.env.BUNWRITE_KEY,
    json: args.includes('--json'),
  }
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

function fixed(value: number | null): string {
  return value === null ? '—' : value.toFixed(3)
}

async function main(): Promise<void> {
  const args = argsOf(process.argv)
  if (!args.dataset) throw new Error('Pass --dataset <file> or set RAG_EVAL_DATASET.')
  if (!args.project) throw new Error('Pass --project <id> or set BUNWRITE_PROJECT.')
  if (!args.key) throw new Error('Pass --key <key> or set BUNWRITE_KEY.')

  const dataset = JSON.parse(readFileSync(resolve(args.dataset), 'utf8')) as Record<string, unknown>
  const response = await fetch(`${args.endpoint}/rag/evaluate`, {
    method: 'POST',
    headers: {
      'x-appwrite-project': args.project,
      'x-appwrite-key': args.key,
      'content-type': 'application/json',
    },
    body: JSON.stringify(dataset),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Evaluate failed (${response.status}): ${text}`)
  const result = JSON.parse(text) as {
    collectionId: string
    total: number
    passed: number
    failed: number
    metrics: Record<string, number | null>
    cases: Array<{
      id: string
      query: string
      passed: boolean
      recallAtK: number | null
      reciprocalRank: number | null
      ndcgAtK: number | null
      contextKeywordCoverage: number | null
      answerKeywordCoverage: number | null
      refused: boolean | null
      latencyMs: number
      error?: string
    }>
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`\nRAG evaluation: ${result.collectionId}`)
    console.log(`  cases     ${result.total}`)
    console.log(`  passed    ${result.passed}`)
    console.log(`  failed    ${result.failed}`)
    console.log(`  recall@k  ${percentage(result.metrics.recallAtK ?? null)}`)
    console.log(`  MRR       ${fixed(result.metrics.mrr ?? null)}`)
    console.log(`  nDCG@k    ${fixed(result.metrics.ndcgAtK ?? null)}`)
    console.log(`  context   ${percentage(result.metrics.contextKeywordCoverage ?? null)}`)
    console.log(`  answers   ${percentage(result.metrics.answerKeywordCoverage ?? null)}`)
    console.log(`  refusal   ${percentage(result.metrics.refusalAccuracy ?? null)}`)
    console.log(`  latency   ${Math.round(result.metrics.averageLatencyMs ?? 0)} ms average`)

    console.log('\nCases')
    for (const entry of result.cases) {
      const mark = entry.passed ? 'PASS' : 'FAIL'
      console.log(`  ${mark}  ${entry.id} — ${entry.query}`)
      console.log(
        `        recall ${percentage(entry.recallAtK)} · mrr ${fixed(entry.reciprocalRank)} · ndcg ${fixed(entry.ndcgAtK)} · ${entry.latencyMs} ms`,
      )
      if (entry.error) console.log(`        ${entry.error}`)
    }
    console.log('')
  }

  if (result.failed > 0) process.exitCode = 1
}

await main()
