/**
 * Vectors and RAG page markup. Handlers load data and validate writes; every
 * function here takes plain values, like the other console views.
 */
import { html, type Html } from '~/console/html'
import { fileField } from '~/console/upload'
import {
  alert,
  badge,
  copyableId,
  destroy,
  emptyState,
  header,
  icon,
  listCard,
  pageFooter,
  pager,
  plural,
  settingsSection,
  tabs,
  when,
} from '~/console/ui'
import type { VectorCollection, VectorDocument, VectorMatch, VectorPoint } from '~/vectors/types'
import { MAX_FILE_BYTES } from '~/vectors/limits'

export const VECTORS = '/console/vectors'
export const VECTOR_SETTINGS = '/console/settings/vectors'
export const collectionUrl = (id: string) => `${VECTORS}/${encodeURIComponent(id)}`
export const pointUrl = (collectionId: string, pointId: string) => `${collectionUrl(collectionId)}/points/${encodeURIComponent(pointId)}`
export const documentPointsUrl = (collectionId: string, documentId: string) =>
  `${collectionUrl(collectionId)}?documentId=${encodeURIComponent(documentId)}`

export type CollectionTab = 'points' | 'rag' | 'evaluation' | 'settings'

/** The parts every vector page needs: the active embedder and whether answers are generated. */
export interface VectorEnv {
  embedder: string
  dimension: number
  canAnswer: boolean
  chatModel: string
  maxPoints: number
  hybrid: boolean
  rerank: boolean
  reranker: string
}

export interface CollectionDraft {
  name: string
  id: string
  dimension: string
  metric: string
}

export interface PointDraft {
  id: string
  content: string
  vector: string
  documentId: string
  chunkIndex: string
  metadata: string
}

export interface IngestDraft {
  text: string
  documentId: string
  chunkSize: string
  chunkOverlap: string
  metadata: string
}

export interface QueryDraft {
  query: string
  topK: string
  filter: string
  generate: boolean
}

export interface RagAnswer {
  query: string
  answer: string | null
  context: string
  sources: VectorMatch[]
  model: string | null
}

export interface PointsOptions {
  collection: VectorCollection
  points: VectorPoint[]
  matches?: VectorMatch[]
  total: number
  page: number
  pages: number
  query: string
  filter: string
  topK: string
  documentId?: string
  searchError?: string
}

export interface RagOptions {
  collection: VectorCollection
  documents: VectorDocument[]
  ingest: IngestDraft
  query: QueryDraft
  result?: RagAnswer
  error?: string
}

const METRICS: [string, string, string][] = [
  ['cosine', 'Cosine similarity', 'Best for normalised text embeddings.'],
  ['dot', 'Dot product', 'Raw inner product; larger vectors score higher.'],
  ['euclidean', 'Euclidean distance', 'Nearest points first; shown as a similarity.'],
]

const metricLabel = (metric: string) => METRICS.find(([id]) => id === metric)?.[1] ?? metric

export const emptyCollectionDraft = (env: VectorEnv): CollectionDraft => ({
  name: '',
  id: '',
  dimension: String(env.dimension),
  metric: 'cosine',
})

export const emptyPointDraft = (): PointDraft => ({ id: '', content: '', vector: '', documentId: '', chunkIndex: '0', metadata: '{}' })

export const emptyIngestDraft = (): IngestDraft => ({ text: '', documentId: '', chunkSize: '', chunkOverlap: '', metadata: '{}' })

export const emptyQueryDraft = (env: VectorEnv): QueryDraft => ({
  query: '',
  topK: '5',
  filter: '',
  generate: env.canAnswer,
})

const preview = (text: string, max = 160) => (text.length > max ? `${text.slice(0, max)}…` : text)
const scoreText = (score: number) => score.toFixed(3)

/** The uploaded file name, or a user-supplied source for text ingest. */
function documentLabel(document: VectorDocument): string {
  const filename = document.metadata.filename
  if (typeof filename === 'string' && filename && filename !== document.documentId) return filename
  const source = document.metadata.source
  if (typeof source === 'string' && source && source !== document.documentId) return source
  return ''
}

function collectionTabs(collection: VectorCollection, active: CollectionTab): Html {
  const base = collectionUrl(collection.$id)
  return tabs(
    [
      { key: 'points', label: 'Points', href: base },
      { key: 'rag', label: 'RAG & documents', href: `${base}/rag` },
      { key: 'evaluation', label: 'Evaluation', href: `${base}/evaluation` },
      { key: 'settings', label: 'Settings', href: `${base}/settings` },
    ],
    active,
  )
}

export function collectionShell(
  collection: VectorCollection,
  active: CollectionTab,
  body: Html,
  options: { error?: string; actions?: Html } = {},
): Html {
  return html`${header(collection.name, { back: VECTORS, actions: options.actions })}${collectionTabs(collection, active)}
    ${options.error ? alert('critical', html`${options.error}`) : ''}${body}`
}

/** The list page. */
export function vectorsView(collections: VectorCollection[]): Html {
  const create = html`<a class="btn primary" href="${VECTORS}/new">${icon('plus')}<span>Create collection</span></a>`
  const settings = html`<a class="btn" href="${VECTOR_SETTINGS}">${icon('gear-six')}<span>Settings</span></a>`
  const body = collections.length
    ? html`<div class="scroll">
        <table>
          <thead><tr><th>Collection</th><th class="num">Points</th><th class="num hide-sm">Dimensions</th><th class="hide-sm">Metric</th><th class="hide-sm">Embedder</th><th class="hide-sm">Updated</th></tr></thead>
          <tbody>
            ${collections.map(
              (collection) => html`<tr class="row-link" onclick="location='${collectionUrl(collection.$id)}'">
                <td><a href="${collectionUrl(collection.$id)}">${collection.name}</a><div class="mono subdued cell-sub">${collection.$id}</div></td>
                <td class="num">${collection.points.toLocaleString('en-US')}</td>
                <td class="num hide-sm">${collection.dimension}</td>
                <td class="hide-sm">${badge(metricLabel(collection.metric))}</td>
                <td class="mono hide-sm clip" title="${collection.embedder}">${collection.embedder}</td>
                <td class="hide-sm subdued">${when(collection.$updatedAt)}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`
    : emptyState(
        'No vector collections yet',
        'Create a collection to store embeddings for semantic search, recommendations or RAG.',
        create,
      )
  return html`${header('Vectors', { actions: html`${settings}${collections.length ? create : ''}` })}
    ${listCard('vectors', { body })}`
}

/** Create-collection page. */
export function collectionCreateView(env: VectorEnv, options: { draft?: CollectionDraft; error?: string } = {}): Html {
  const draft = options.draft ?? emptyCollectionDraft(env)
  return html`${header('Create collection', { back: VECTORS })}
    ${options.error ? alert('critical', html`${options.error}`) : ''}
    <form method="post" action="${VECTORS}">
      ${settingsSection(
        'General',
        'A collection holds points with the same number of vector dimensions.',
        html`<div class="fields">
            <label>Name<input name="name" value="${draft.name}" required data-slug-source autofocus placeholder="Knowledge base" /></label>
            <label>ID<input name="id" value="${draft.id}" class="mono" required data-slug-from="name" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" placeholder="knowledge" /><small>Apps use this ID. Filled in from the name; it cannot change later.</small></label>
          </div>
          <div class="fields">
            <label>Dimensions<input name="dimension" type="number" min="1" max="8192" value="${draft.dimension}" required /><small>Must match the embedder when you add points from text. ${env.embedder} returns ${env.dimension}.</small></label>
            <label>Similarity metric<select name="metric">
              ${METRICS.map(([id, label]) => html`<option value="${id}" ${id === draft.metric ? 'selected' : ''}>${label}</option>`)}
            </select><small>${METRICS.find(([id]) => id === draft.metric)?.[2] ?? ''}</small></label>
          </div>`,
      )}
      ${settingsSection(
        'Embedding',
        'Points added from text are embedded with this project\'s configured provider. Points with an explicit vector are stored as given.',
        html`<ul class="list">
          <li><span class="subdued">Embedder</span><span class="mono">${env.embedder}</span></li>
          <li><span class="subdued">Dimensions</span><span>${env.dimension}</span></li>
          <li><span class="subdued">Answer generation</span><span>${env.canAnswer ? badge(env.chatModel, 'success') : badge('Not configured')}</span></li>
        </ul>
        <p class="help">
          Configured in <a href="${VECTOR_SETTINGS}">Vectors &amp; RAG settings</a>. Changing the embedder or its dimensions later means re-indexing the collection.
        </p>`,
      )}
      ${pageFooter(VECTORS, 'Create collection')}
    </form>`
}

/** Points tab: browse or search this collection. */
export function pointsView(env: VectorEnv, options: PointsOptions): Html {
  const { collection } = options
  const base = collectionUrl(collection.$id)
  const searching = Boolean(options.query.trim() || options.filter.trim())
  const actions = html`<a class="btn" href="${base}/rag">${icon('upload-simple')}<span>Upload documents</span></a><a class="btn primary" href="${base}/points/new">${icon('plus')}<span>Add point</span></a>`
  const toolbar = html`<form
    class="toolbar"
    method="get"
    action="${base}"
    hx-get="${base}"
    hx-target="#points"
    hx-select="#points"
    hx-swap="outerHTML"
    hx-push-url="true"
    hx-trigger="submit"
  >
    <input type="search" name="q" value="${options.query}" placeholder="Search points by text" autocomplete="off" />
    <input type="text" name="filter" value="${options.filter}" class="mono" placeholder='Filter JSON, e.g. {"source":"guide"}' title='Metadata equality filter, for example {"lang":"en"}' />
    <select name="topK" aria-label="Results">
      ${['5', '10', '20', '50'].map((value) => html`<option value="${value}" ${value === options.topK ? 'selected' : ''}>Top ${value}</option>`)}
    </select>
    <button>Search</button>
    ${searching ? html`<a class="btn" href="${base}">Clear</a>` : ''}
  </form>`

  const documentNotice = options.documentId
    ? alert(
        'info',
        html`Showing chunks for <span class="mono">${options.documentId}</span>. <a href="${base}">Show all points</a>.`,
      )
    : ''

  let body: Html
  if (options.searchError) {
    body = alert('critical', html`${options.searchError}`)
  } else if (searching) {
    const matches = options.matches ?? []
    body = matches.length
      ? html`<div class="scroll">
          <table>
            <thead><tr><th class="num">Score</th><th>Point</th><th>Document</th><th>Content</th></tr></thead>
            <tbody>
              ${matches.map(
                (match) => html`<tr class="row-link" onclick="location='${pointUrl(collection.$id, match.$id)}'">
                  <td class="num mono">${scoreText(match.score)}</td>
                  <td><a href="${pointUrl(collection.$id, match.$id)}" class="mono">${match.$id}</a></td>
                  <td class="mono clip">${match.documentId || '—'}</td>
                  <td class="clip" title="${match.content}">${preview(match.content)}</td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`
      : emptyState(
          'No matching points',
          'Try different words or a simpler metadata filter.',
          html`<a class="btn" href="${base}">Clear search</a>`,
        )
  } else {
    body = options.points.length
      ? html`<div class="scroll">
          <table>
            <thead><tr><th>Point</th><th>Document</th><th class="num hide-sm">Chunk</th><th>Content</th><th class="hide-sm">Updated</th></tr></thead>
            <tbody>
              ${options.points.map(
                (point) => html`<tr class="row-link" onclick="location='${pointUrl(collection.$id, point.$id)}'">
                  <td><a href="${pointUrl(collection.$id, point.$id)}" class="mono">${point.$id}</a></td>
                  <td class="mono clip">${point.documentId || '—'}</td>
                  <td class="num hide-sm">${point.chunkIndex}</td>
                  <td class="clip" title="${point.content}">${preview(point.content) || html`<span class="subdued">Vector only</span>`}</td>
                  <td class="hide-sm subdued">${when(point.$updatedAt)}</td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`
      : emptyState(
          'No points yet',
          'Add a text point to embed it, or paste a vector made elsewhere.',
          html`<a class="btn primary" href="${base}/points/new">${icon('plus')}<span>Add point</span></a>`,
        )
  }

  const footer = searching
    ? html`<div class="pager"><span class="subdued">${plural(options.total, 'matching point')} · showing ${options.matches?.length ?? 0}</span></div>`
    : pager({
        page: options.page,
        pages: options.pages,
        params: { documentId: options.documentId ?? '' },
        always: options.total > 0,
        label: `Page ${options.page} of ${options.pages} · ${plural(options.total, 'point')}`,
      })

  return collectionShell(collection, 'points', html`${documentNotice}
    ${listCard('points', { toolbar, body, footer })}`, { actions })
}

/** Add-point page. */
export function pointCreateView(
  env: VectorEnv,
  collection: VectorCollection,
  options: { draft?: PointDraft; error?: string } = {},
): Html {
  const draft = options.draft ?? emptyPointDraft()
  const base = collectionUrl(collection.$id)
  return collectionShell(
    collection,
    'points',
    html`${options.error ? alert('critical', html`${options.error}`) : ''}
      <form method="post" action="${base}/points">
        ${settingsSection(
          'Content',
          `Text is embedded with ${env.embedder} (${collection.dimension} dimensions) and stored as one point.`,
          html`<label>Content<textarea name="content" rows="8" placeholder="Paste the text to embed…">${draft.content}</textarea><small>Leave this empty when you provide a vector below.</small></label>`,
        )}
        ${settingsSection(
          'Vector',
          'For embeddings made in another system, or when you want to control the vector exactly.',
          html`<label>Vector JSON<textarea name="vector" class="mono" rows="4" spellcheck="false" placeholder="[0.12, -0.04, …]">${draft.vector}</textarea><small>A JSON array of exactly ${collection.dimension} finite numbers. When both are filled, the vector wins.</small></label>`,
        )}
        ${settingsSection(
          'Metadata',
          'Point IDs are optional; document IDs group chunks from the same source.',
          html`<div class="fields">
              <label>Point ID<input name="id" value="${draft.id}" class="mono" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}" placeholder="Generated if empty" /></label>
              <label>Document ID<input name="documentId" value="${draft.documentId}" class="mono" placeholder="Optional" /></label>
            </div>
            <div class="fields">
              <label>Chunk index<input name="chunkIndex" type="number" min="0" value="${draft.chunkIndex}" /></label>
              <label>Metadata JSON<textarea name="metadata" class="mono" rows="3" spellcheck="false">${draft.metadata}</textarea></label>
            </div>`,
        )}
        ${pageFooter(base, 'Add point')}
      </form>`,
  )
}

/** A single point: its content, metadata and a delete action. */
export function pointView(collection: VectorCollection, point: VectorPoint): Html {
  const base = collectionUrl(collection.$id)
  const metadata = JSON.stringify(point.metadata, null, 2)
  return collectionShell(
    collection,
    'points',
    html`${settingsSection(
      'Content',
      'The text stored with this point. It is what search and RAG return.',
      point.content ? html`<pre>${point.content}</pre>` : html`<p class="subdued" style="margin:0">This point has no content; it is vector-only.</p>`,
    )}
    ${settingsSection(
      'Point',
      'Stable identifiers and timestamps.',
      html`<ul class="list">
        <li><span class="subdued">Point ID</span><span>${copyableId(point.$id, 'vector-point-id')}</span></li>
        <li><span class="subdued">Document</span><span class="mono">${point.documentId || '—'}</span></li>
        <li><span class="subdued">Chunk</span><span>${point.chunkIndex}</span></li>
        <li><span class="subdued">Created</span><span>${when(point.$createdAt)}</span></li>
        <li><span class="subdued">Updated</span><span>${when(point.$updatedAt)}</span></li>
      </ul>`,
    )}
    ${settingsSection('Metadata', 'Filters compare these values.', html`<pre>${metadata}</pre>`)}
    ${settingsSection(
      'Delete point',
      'Removes this point from search and RAG immediately. This cannot be undone.',
      html`<div class="foot" style="justify-content:flex-start"><a class="btn" href="${base}/points/new">Add another</a></div>
        ${destroy(`${base}/points/${encodeURIComponent(point.$id)}/delete`, 'Delete point', `Delete point ${point.$id}?`)}`,
    )}`,
  )
}

function sourceTable(collectionId: string, sources: VectorMatch[]): Html {
  return html`<div class="scroll">
    <table>
      <thead><tr><th class="num">#</th><th class="num">Score</th><th>Source</th><th>Content</th></tr></thead>
      <tbody>
        ${sources.map(
          (source, index) => html`<tr class="row-link" onclick="location='${pointUrl(collectionId, source.$id)}'">
            <td class="num">${index + 1}</td>
            <td class="num mono">${scoreText(source.score)}</td>
            <td class="mono clip">${source.documentId || source.$id}</td>
            <td class="clip" title="${source.content}">${preview(source.content, 220)}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`
}

/** RAG tab: ingest, ask, answer and the ingested document index. */
export function ragView(env: VectorEnv, options: RagOptions): Html {
  const { collection } = options
  const base = collectionUrl(collection.$id)
  const answer = options.result
  const chatHint = env.canAnswer
    ? `Answers are generated with ${env.chatModel}.`
    : 'Context and sources are returned without a generated answer.'

  const answerSections = answer
    ? html`
      ${settingsSection(
        'Answer',
        answer.answer ? chatHint : 'No model answer was generated; use the context and sources below.',
        answer.answer ? html`<p style="margin:0;white-space:pre-wrap">${answer.answer}</p>` : html`<p class="subdued" style="margin:0">No generated answer.</p>`,
      )}
      ${settingsSection('Sources', `${plural(answer.sources.length, 'source')} returned for “${answer.query}”.`, sourceTable(collection.$id, answer.sources), { flush: true })}
      ${settingsSection('Context', 'The exact context sent to the model.', html`<pre>${answer.context || 'No context returned.'}</pre>`)}
    `
    : ''

  const documents = options.documents.length
    ? html`<div class="scroll">
        <table>
          <thead><tr><th>Document</th><th class="num">Chunks</th><th class="hide-sm">Updated</th><th class="actions-col"></th></tr></thead>
          <tbody>
            ${options.documents.map(
              (document) => html`<tr>
                <td>
                  <a href="${documentPointsUrl(collection.$id, document.documentId)}" class="mono">${document.documentId}</a>
                  ${documentLabel(document)
                    ? html`<div class="subdued mono" style="font-size:12px">${documentLabel(document)}${typeof document.metadata.format === 'string' ? ` · ${document.metadata.format}` : ''}</div>`
                    : ''}
                </td>
                <td class="num">${document.chunks}</td>
                <td class="hide-sm subdued">${when(document.$updatedAt)}</td>
                <td class="actions-col">${destroy(
                  `${base}/documents/${encodeURIComponent(document.documentId)}/delete`,
                  'Delete',
                  `Delete every chunk of ${document.documentId}?`,
                  {},
                  { asButton: true },
                )}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`
    : emptyState('No ingested documents', 'Upload a file or paste text below to chunk and embed a document.', undefined)

  return collectionShell(
    collection,
    'rag',
    html`${options.error ? alert('critical', html`${options.error}`) : ''}
      ${settingsSection(
        'Ask a question',
        'Retrieve the closest chunks, then optionally ask the configured chat model to answer with them.',
        html`<form method="post" action="${base}/rag/query">
          <label>Question<textarea name="query" rows="3" required placeholder="What does the handbook say about deployment?">${options.query.query}</textarea></label>
          <div class="fields">
            <label>Results<select name="topK">${['3', '5', '10', '20'].map((value) => html`<option value="${value}" ${value === options.query.topK ? 'selected' : ''}>Top ${value}</option>`)}</select></label>
            <label>Metadata filter<input name="filter" value="${options.query.filter}" class="mono" placeholder='Optional JSON, e.g. {"lang":"en"}' /></label>
          </div>
          ${env.canAnswer
            ? html`<label class="check"><input type="checkbox" name="generate" ${options.query.generate ? 'checked' : ''} /><span>Generate an answer with ${env.chatModel}</span><small>Turn off to return only the retrieved context and sources.</small></label>`
            : ''}
          <div class="foot"><button class="primary">Ask</button></div>
        </form>`,
      )}
      ${answerSections}
      ${settingsSection(
        'Ingest a document',
        'Upload a file or paste text. Bunwrite extracts the text, splits it on word boundaries, embeds it and stores it. Re-ingesting the same document ID or filename replaces its chunks.',
        html`<form method="post" action="${base}/rag/ingest" enctype="multipart/form-data" hx-boost="false">
          ${fileField({
            name: 'file',
            label: 'File',
            accept: '.pdf,.md,.markdown,.txt,.html,.htm,.docx,.odt,.epub,.rtf,.json,.jsonl,.csv,.tsv,.xml,.yaml,.yml,.log',
            title: 'Drag and drop a document here',
            hint: `PDF, Markdown, HTML, DOCX, ODT, EPUB, RTF, JSON, CSV, XML, YAML or text — up to ${MAX_FILE_BYTES / 1024 / 1024} MB`,
            help: 'Or paste text below. A file takes precedence when both are provided.',
          })}
          <label>Text<textarea name="text" rows="8" placeholder="Paste a handbook section, support article or notes…">${options.ingest.text}</textarea></label>
          <div class="fields">
            <label>Document ID<input name="documentId" value="${options.ingest.documentId}" class="mono" placeholder="Generated from the file name" /></label>
            <label>Metadata JSON<textarea name="metadata" class="mono" rows="3" spellcheck="false">${options.ingest.metadata}</textarea></label>
          </div>
          <div class="fields">
            <label>Chunk size<input name="chunkSize" type="number" min="64" max="8000" value="${options.ingest.chunkSize}" placeholder="Project default" /><small>Characters per chunk.</small></label>
            <label>Chunk overlap<input name="chunkOverlap" type="number" min="0" value="${options.ingest.chunkOverlap}" placeholder="Project default" /><small>Characters shared by adjacent chunks.</small></label>
          </div>
          <div class="foot"><button class="primary">Ingest document</button></div>
        </form>`,
      )}
      ${settingsSection(
        'Documents',
        'Ingested documents grouped by document ID. Points added one by one are visible in Points.',
        documents,
        { flush: true },
      )}`,
  )
}

/** Settings tab: collection facts and destructive actions. */
export function collectionSettingsView(env: VectorEnv, collection: VectorCollection): Html {
  const base = collectionUrl(collection.$id)
  return collectionShell(
    collection,
    'settings',
    html`${settingsSection(
        'Collection',
        'These values are fixed for the life of the collection.',
        html`<ul class="list">
          <li><span class="subdued">ID</span><span>${copyableId(collection.$id, 'vector-collection-id')}</span></li>
          <li><span class="subdued">Name</span><span>${collection.name}</span></li>
          <li><span class="subdued">Points</span><span>${collection.points.toLocaleString('en-US')} / ${env.maxPoints.toLocaleString('en-US')}</span></li>
          <li><span class="subdued">Dimensions</span><span>${collection.dimension}</span></li>
          <li><span class="subdued">Metric</span><span>${metricLabel(collection.metric)}</span></li>
          <li><span class="subdued">Embedder</span><span class="mono">${collection.embedder}</span></li>
          <li><span class="subdued">Retrieval</span><span>${env.hybrid ? 'Hybrid BM25 + vector' : 'Vector only'} · ${env.rerank ? env.reranker : 'no rerank'}</span></li>
          <li><span class="subdued">Created</span><span>${when(collection.$createdAt)}</span></li>
          <li><span class="subdued">Updated</span><span>${when(collection.$updatedAt)}</span></li>
        </ul>`,
      )}
      ${settingsSection(
        'Embedding and answers',
        'The project-level configuration new text points and RAG answers use.',
        html`<ul class="list">
          <li><span class="subdued">Active embedder</span><span class="mono">${env.embedder}</span></li>
          <li><span class="subdued">Answer model</span><span>${env.canAnswer ? env.chatModel : badge('Not configured')}</span></li>
          <li><span class="subdued">Point limit</span><span>${env.maxPoints.toLocaleString('en-US')}</span></li>
        </ul>
        <p class="help">If the active embedder changes, add the points again or they will not match text queries.</p>
        <div class="foot" style="justify-content:flex-start">
          <a class="btn" href="${VECTOR_SETTINGS}">Open Vectors &amp; RAG settings</a>
          <form method="post" action="${base}/reindex" data-confirm="Re-embed every point in this collection with the active embedder?" data-confirm-label="Re-index" data-confirm-tone="critical">
            <button class="plain">Re-index all points</button>
          </form>
        </div>`,
      )}
      ${settingsSection(
        'Delete collection',
        'Removes every point and removes the collection from search and RAG. This cannot be undone.',
        html`<p class="hint" style="margin:0 0 12px">${plural(collection.points, 'point')} will be deleted with it.</p>
          ${destroy(`${base}/delete`, 'Delete collection', `Delete ${collection.name} and all its points?`)}`,
      )}`,
  )
}
