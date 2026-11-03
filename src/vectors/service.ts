/**
 * Built-in vector store and retrieval-augmented generation.
 *
 * Vectors live in two ordinary tables (`_vector_collections` and
 * `_vector_points`) so the feature works on SQLite and Postgres without a
 * native extension or a second service. Search is a bounded in-process scan:
 * portable, predictable, and the right trade-off for the tens of thousands of
 * chunks a small self-hosted app normally keeps.
 *
 * Embeddings are either local feature hashes (offline, lexical) or an
 * OpenAI-compatible HTTP provider. Answer generation is optional; without a
 * chat provider, `/rag/query` returns the retrieved context and sources.
 */
import type { SqlDatabase, SqlExecutor } from '~/db/driver'
import { now } from '~/lib/datetime'
import { err } from '~/lib/errors'
import { resolveId, uniqueId } from '~/lib/ids'
import { chunkText } from './chunk'
import type { ChatProvider } from './chat'
import { HttpChat } from './chat'
import type { VectorsConfig } from './config'
import type { EmbeddingProvider } from './embedder'
import { HttpEmbedding, LocalEmbedding } from './embedder'
import {
  DEFAULT_LIST_LIMIT,
  MAX_BATCH,
  MAX_CONTENT,
  MAX_INGEST_TEXT,
  MAX_LIST_LIMIT,
  MAX_RAG_TOP_K,
  MAX_TOP_K,
  SCAN_BATCH,
} from './limits'
import { answerPrompt, buildContext } from './rag'
import { TopK } from './rank'
import { parseRowMetadata, pointModel } from './rows'
import { norm, parseMetric, parseVector, score, type VectorMetric } from './similarity'
import { VectorStore } from './store'
import type {
  CreateCollectionInput,
  IngestInput,
  PointInput,
  QueryInput,
  SearchInput,
  StoredPoint,
  VectorCollection,
  VectorCollectionRow,
  VectorDocument,
  VectorMatch,
  VectorPoint,
  VectorPointRow,
} from './types'
import { integer, invalid, matchesFilter, metadataOf, optionalText, pathId, textOf } from './validate'

interface PendingPoint extends Omit<StoredPoint, 'vector'> {
  vector: number[] | null
}

export class VectorService {
  private embedder: EmbeddingProvider
  private chat: ChatProvider | null
  private readonly store: VectorStore

  constructor(
    db: SqlDatabase,
    private config: VectorsConfig,
  ) {
    this.store = new VectorStore(db)
    this.embedder = this.makeEmbedder()
    this.chat = this.makeChat()
  }

  /** Apply settings saved in the console without restarting the server. */
  reload(config: VectorsConfig): void {
    this.config = config
    this.embedder = this.makeEmbedder()
    this.chat = this.makeChat()
  }

  private makeEmbedder(): EmbeddingProvider {
    const config = this.config
    return config.embedder === 'http'
      ? new HttpEmbedding({
          url: config.embeddingUrl,
          apiKey: config.embeddingApiKey,
          model: config.embeddingModel,
          dimension: config.dimension,
          sendDimensions: config.sendDimensions,
          batchSize: config.embeddingBatchSize,
          timeoutMs: config.timeoutMs,
        })
      : new LocalEmbedding(config.dimension)
  }

  private makeChat(): ChatProvider | null {
    const config = this.config
    return config.chatUrl
      ? new HttpChat({
          url: config.chatUrl,
          apiKey: config.chatApiKey,
          model: config.chatModel,
          temperature: config.chatTemperature,
          maxTokens: config.chatMaxTokens,
          timeoutMs: config.timeoutMs,
        })
      : null
  }

  /** The provider a new collection records; changing it requires re-indexing. */
  get embedderName(): string {
    return this.embedder.name
  }

  get canAnswer(): boolean {
    return this.chat !== null
  }

  // ---------------------------------------------------------------------------
  // Collections
  // ---------------------------------------------------------------------------

  listCollections(): Promise<VectorCollection[]> {
    return this.store.listCollections()
  }

  async getCollection(id: string): Promise<VectorCollection> {
    const collection = await this.store.collectionWithCount(pathId(id, 'Collection ID'))
    if (!collection) throw err('collection_not_found', undefined, [id])
    return collection
  }

  async createCollection(input: CreateCollectionInput): Promise<VectorCollection> {
    const id = resolveId(input.id, 'Collection ID')
    const name = optionalText(input.name) ?? id
    const dimension = integer(input.dimension, this.config.dimension, 1, 8192, 'dimension')
    let metric: VectorMetric
    try {
      metric = parseMetric(input.metric)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : 'Unknown vector metric.')
    }
    const created = await this.store.insertCollection({
      id,
      name,
      dimension,
      metric,
      embedder: this.embedder.name,
    })
    if (!created) throw err('collection_already_exists', undefined, [id])
    return this.getCollection(id)
  }

  async deleteCollection(id: string): Promise<void> {
    const collectionId = pathId(id, 'Collection ID')
    const deleted = await this.store.transaction((tx) => this.store.deleteCollection(collectionId, tx))
    if (!deleted) throw err('collection_not_found', undefined, [collectionId])
  }

  private async collectionRow(id: string): Promise<VectorCollectionRow> {
    const collectionId = pathId(id, 'Collection ID')
    const row = await this.store.collectionRow(collectionId)
    if (!row) throw err('collection_not_found', undefined, [collectionId])
    return row
  }

  // ---------------------------------------------------------------------------
  // Points
  // ---------------------------------------------------------------------------

  async getPoint(collectionId: string, pointId: string): Promise<VectorPoint> {
    const collection = await this.collectionRow(collectionId)
    const point = await this.store.point(collection.id, pathId(pointId, 'Point ID'))
    if (!point) throw err('document_not_found', undefined, [pointId])
    return point
  }

  async listPoints(
    collectionId: string,
    options: { documentId?: string; limit?: number; offset?: number } = {},
  ): Promise<{ total: number; points: VectorPoint[] }> {
    const collection = await this.collectionRow(collectionId)
    const limit = integer(options.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT, 'limit')
    const offset = integer(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
    const page = await this.store.listPoints(collection.id, {
      documentId: options.documentId ? pathId(options.documentId, 'Document ID') : undefined,
      limit,
      offset,
    })
    return { total: page.total, points: page.rows.map(pointModel) }
  }

  async listDocumentPoints(
    collectionId: string,
    documentId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ total: number; points: VectorPoint[] }> {
    return this.listPoints(collectionId, { ...options, documentId })
  }

  /** Ingested documents for the console and any client that wants a document index. */
  async listDocuments(collectionId: string, limit = 100): Promise<VectorDocument[]> {
    const collection = await this.collectionRow(collectionId)
    return this.store.listDocuments(collection.id, integer(limit, 100, 1, 1000, 'limit'))
  }

  async upsertPoints(collectionId: string, inputs: PointInput[]): Promise<VectorPoint[]> {
    const collection = await this.collectionRow(collectionId)
    if (inputs.length === 0) return []
    if (inputs.length > MAX_BATCH) throw invalid(`A batch may contain at most ${MAX_BATCH} points.`)

    const prepared = inputs.map((input) => this.preparePoint(input, collection))
    const seen = new Set<string>()
    for (const point of prepared) {
      if (seen.has(point.id)) throw invalid(`Point ID "${point.id}" appears more than once in the batch.`)
      seen.add(point.id)
    }
    const pending = prepared.filter((point) => point.vector === null)
    if (pending.length > 0) {
      const vectors = await this.embed(
        collection,
        pending.map((point) => point.content),
      )
      pending.forEach((point, index) => {
        const vector = vectors[index]
        if (!vector) throw err('general_unknown', 'Embedding provider returned fewer vectors than inputs.')
        point.vector = vector
      })
    }
    const points: StoredPoint[] = prepared.map((point) => ({ ...point, vector: point.vector! }))
    for (const point of points) this.assertDimension(collection, point.vector)

    await this.store.transaction(async (tx) => {
      await this.assertCapacity(tx, collection, points)
      await this.store.insertPoints(tx, collection.id, points)
    })
    return this.store.pointsByIds(
      collection.id,
      points.map((point) => point.id),
    )
  }

  async deletePoint(collectionId: string, pointId: string): Promise<void> {
    const collection = await this.collectionRow(collectionId)
    const id = pathId(pointId, 'Point ID')
    if (!(await this.store.deletePoint(collection.id, id))) throw err('document_not_found', undefined, [id])
  }

  async deleteDocument(collectionId: string, documentId: string): Promise<number> {
    const collection = await this.collectionRow(collectionId)
    return this.store.deleteDocument(collection.id, pathId(documentId, 'Document ID'))
  }

  private preparePoint(input: PointInput, collection: VectorCollectionRow): PendingPoint {
    const id = resolveId(input.id, 'Point ID')
    const documentId =
      input.documentId === undefined || input.documentId === null || input.documentId === ''
        ? ''
        : resolveId(input.documentId, 'Document ID')
    if (input.content !== undefined && input.content !== null && typeof input.content !== 'string') {
      throw invalid('Param "content" must be a string.')
    }
    const content = typeof input.content === 'string' ? input.content : ''
    if (content.length > MAX_CONTENT) throw invalid(`Param "content" must be at most ${MAX_CONTENT} characters.`)
    const chunkIndex = integer(input.chunkIndex, 0, 0, 1_000_000_000, 'chunkIndex')
    let vector: number[] | null = null
    if (input.vector !== undefined && input.vector !== null) {
      try {
        vector = parseVector(input.vector)
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : 'Invalid vector.')
      }
      this.assertDimension(collection, vector)
    } else if (content.trim() === '') {
      throw invalid('A point needs either "vector" or "content".')
    }
    return { id, documentId, chunkIndex, content, metadata: metadataOf(input.metadata), vector }
  }

  private assertDimension(collection: VectorCollectionRow, vector: readonly number[]): void {
    const expected = Number(collection.dimension)
    if (vector.length !== expected) {
      throw invalid(`Vector has ${vector.length} dimensions, but collection "${collection.id}" expects ${expected}.`)
    }
  }

  private async assertCapacity(exec: SqlExecutor, collection: VectorCollectionRow, points: StoredPoint[]): Promise<void> {
    if (points.length === 0) return
    const existing = await this.store.countPoints(collection.id, exec)
    const updates = await this.store.existingPointIds(
      collection.id,
      points.map((point) => point.id),
      exec,
    )
    if (existing - updates.size + points.length > this.config.maxPoints) {
      throw invalid(`Collection "${collection.id}" would exceed the configured point limit (${this.config.maxPoints}).`)
    }
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  private async embed(collection: VectorCollectionRow, texts: string[]): Promise<number[][]> {
    if (collection.embedder !== this.embedder.name) {
      throw invalid(
        `Collection "${collection.id}" was indexed with ${collection.embedder}, but this server now uses ${this.embedder.name}. Re-index the collection or restore the old embedder configuration.`,
      )
    }
    if (this.embedder.dimension !== null && this.embedder.dimension !== Number(collection.dimension)) {
      throw invalid(
        `Collection "${collection.id}" has ${collection.dimension} dimensions, but ${this.embedder.name} returns ${this.embedder.dimension}. Re-index with a matching embedding dimension.`,
      )
    }
    try {
      return await this.embedder.embed(texts)
    } catch (error) {
      throw err('general_unknown', error instanceof Error ? error.message : 'Embedding failed.')
    }
  }

  private async queryVector(collection: VectorCollectionRow, input: SearchInput): Promise<number[]> {
    const text = optionalText(input.text) ?? optionalText(input.query)
    if (text !== undefined) {
      const [vector] = await this.embed(collection, [text])
      if (!vector) throw err('general_unknown', 'Embedding provider returned no vector.')
      this.assertDimension(collection, vector)
      return vector
    }
    if (input.vector === undefined || input.vector === null) throw invalid('Provide "text", "query" or "vector".')
    let vector: number[]
    try {
      vector = parseVector(input.vector)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : 'Invalid vector.')
    }
    this.assertDimension(collection, vector)
    return vector
  }

  async search(collectionId: string, input: SearchInput): Promise<{ total: number; points: VectorMatch[] }> {
    const collection = await this.collectionRow(collectionId)
    const vector = await this.queryVector(collection, input)
    const queryNorm = norm(vector)
    const topK = integer(input.topK, 5, 1, MAX_TOP_K, 'topK')
    let metric: VectorMetric = 'cosine'
    try {
      metric = parseMetric(collection.metric)
    } catch {
      // A malformed stored value keeps the default.
    }

    // Validate the filter even when the collection has no points yet.
    matchesFilter({}, input.filter)
    const ranker = new TopK<VectorPointRow>(topK)
    let total = 0
    let afterSeq = 0
    for (;;) {
      const batch = await this.store.scanPoints(collection.id, afterSeq, SCAN_BATCH)
      if (batch.length === 0) break
      for (const row of batch) {
        if (!matchesFilter(parseRowMetadata(row.metadata), input.filter)) continue
        let embedding: number[]
        try {
          embedding = parseVector(JSON.parse(row.embedding))
        } catch {
          continue
        }
        if (embedding.length !== vector.length) continue
        const value = score(metric, vector, embedding, Number(row.norm) || norm(embedding), queryNorm)
        if (!Number.isFinite(value)) continue
        ranker.push(row, value)
        total++
      }
      afterSeq = Number(batch[batch.length - 1]!.seq)
      if (batch.length < SCAN_BATCH) break
    }

    return {
      total,
      points: ranker.values().map(({ item, score: value }) => ({ ...pointModel(item), score: value })),
    }
  }

  // ---------------------------------------------------------------------------
  // RAG
  // ---------------------------------------------------------------------------

  async ingest(input: IngestInput): Promise<{ collectionId: string; documentId: string; chunks: number; $createdAt: string }> {
    const collection = await this.collectionRow(typeof input.collectionId === 'string' ? input.collectionId : '')
    const text = textOf(input.text, 'text', MAX_INGEST_TEXT)
    const documentId =
      input.documentId === undefined || input.documentId === null || input.documentId === ''
        ? uniqueId()
        : resolveId(input.documentId, 'Document ID')
    const metadata = metadataOf(input.metadata)
    const chunkSize = integer(input.chunkSize, this.config.chunkSize, 64, 8000, 'chunkSize')
    const chunkOverlap = integer(input.chunkOverlap, this.config.chunkOverlap, 0, Math.floor(chunkSize / 2), 'chunkOverlap')
    const chunks = chunkText(text, { size: chunkSize, overlap: chunkOverlap })
    if (chunks.length === 0) throw invalid('Param "text" does not contain any words.')
    if (chunks.length > MAX_BATCH * 50) throw invalid('The document is too large; split it into smaller ingest requests.')

    const vectors = await this.embed(
      collection,
      chunks.map((chunk) => chunk.text),
    )
    if (vectors.length !== chunks.length) throw err('general_unknown', 'Embedding provider returned fewer vectors than chunks.')
    const points: StoredPoint[] = chunks.map((chunk, index) => ({
      id: `${documentId}.${index}`,
      documentId,
      chunkIndex: index,
      content: chunk.text,
      metadata: { ...metadata, documentId, chunkIndex: index },
      vector: vectors[index]!,
    }))
    for (const point of points) this.assertDimension(collection, point.vector)

    await this.store.transaction(async (tx) => {
      await this.store.deleteDocument(collection.id, documentId, tx)
      await this.assertCapacity(tx, collection, points)
      await this.store.insertPoints(tx, collection.id, points)
    })
    return { collectionId: collection.id, documentId, chunks: points.length, $createdAt: now() }
  }

  async query(input: QueryInput): Promise<{
    query: string
    answer: string | null
    context: string
    sources: VectorMatch[]
    model: string | null
    usage?: unknown
  }> {
    const collectionId = typeof input.collectionId === 'string' ? input.collectionId : ''
    const question = textOf(input.query !== undefined ? input.query : input.text, 'query', 20_000)
    const found = await this.search(collectionId, { text: question, topK: input.topK ?? 5, filter: input.filter })
    const { context, sources } = buildContext(found.points.slice(0, MAX_RAG_TOP_K), this.config.contextChars)

    const generate = input.generate === undefined ? true : input.generate === true || input.generate === 'true' || input.generate === 1
    if (!generate || !this.chat || sources.length === 0) {
      return { query: question, answer: null, context, sources, model: this.chat?.name ?? null }
    }
    try {
      const result = await this.chat.complete(this.config.chatSystemPrompt, answerPrompt(context, question))
      return { query: question, answer: result.answer, context, sources, model: this.chat.name, usage: result.usage }
    } catch (error) {
      throw err('general_unknown', error instanceof Error ? error.message : 'Answer generation failed.')
    }
  }
}
