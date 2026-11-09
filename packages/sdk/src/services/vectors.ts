import { BunwriteException, Client, type Payload } from '../client';
import { InputFile } from '../inputFile';

export type VectorMetric = 'cosine' | 'dot' | 'euclidean';

export interface VectorCollection {
    $id: string;
    name: string;
    dimension: number;
    metric: VectorMetric;
    embedder: string;
    points: number;
    $createdAt: string;
    $updatedAt: string;
}

export interface VectorPoint {
    $id: string;
    $createdAt: string;
    $updatedAt: string;
    documentId: string;
    chunkIndex: number;
    content: string;
    metadata: Record<string, unknown>;
    /** Appwrite-style permissions; API keys bypass them. */
    permissions: string[];
}

export interface VectorMatch extends VectorPoint {
    /** Final ranking score; higher is better. Hybrid/rerank queries return the fused/reranked score. */
    score: number;
}

export interface VectorPointList {
    total: number;
    points: VectorPoint[];
}

export interface VectorSearchResult {
    total: number;
    points: VectorMatch[];
}

export interface VectorAuditEntry {
    $id: string;
    collectionId: string;
    userId: string | null;
    callerKind: string;
    query: string;
    answer: string;
    sourceIds: string[];
    security: {
        redactions: number;
        redactionKinds: string[];
        suspiciousSources: string[];
    };
    latencyMs: number;
    $createdAt: string;
}

export interface VectorAuditList {
    total: number;
    audit: VectorAuditEntry[];
}

export interface VectorCollectionList {
    total: number;
    collections: VectorCollection[];
}

export interface CreateVectorCollectionParams {
    collectionId: string;
    name?: string;
    /** Defaults to the project's configured embedding dimension. */
    dimension?: number;
    metric?: VectorMetric;
}

export interface VectorPointInput {
    /** Point ID. Omit to generate one. */
    id?: string;
    /** Explicit vector. Omit when `content` should be embedded. */
    vector?: number[];
    /** Text to embed when `vector` is omitted. */
    content?: string;
    metadata?: Record<string, unknown>;
    documentId?: string;
    chunkIndex?: number;
    /** Appwrite-style permissions; omitted points are API-key-only. */
    permissions?: string[];
}

export type UpsertVectorPointParams = Omit<VectorPointInput, 'id'> & {
    collectionId: string;
    /** Updating an existing point; omit to create one. */
    pointId?: string;
};

export interface UpsertVectorPointsParams {
    collectionId: string;
    points: VectorPointInput[];
}

export interface VectorSearchParams {
    collectionId: string;
    /** Query text, embedded with the collection's embedder. */
    text?: string;
    /** Alias for `text`. */
    query?: string;
    /** Explicit query vector; use this or text/query. */
    vector?: number[];
    topK?: number;
    /** Equality filter on metadata; values may be arrays or dotted paths. */
    filter?: Record<string, unknown>;
    /** Override the project's hybrid-search setting. */
    hybrid?: boolean;
    /** Override the project's rerank setting. */
    rerank?: boolean;
    /** Vector share of the hybrid score, 0..1. */
    alpha?: number;
}

export interface VectorListParams {
    collectionId: string;
    documentId?: string;
    limit?: number;
    offset?: number;
}

export interface VectorDocument {
    documentId: string;
    chunks: number;
    /** Metadata of the document's first chunk, including source/filename/format for uploads. */
    metadata: Record<string, unknown>;
    $createdAt: string;
    $updatedAt: string;
}

export interface VectorDocumentList {
    total: number;
    documents: VectorDocument[];
}

export interface VectorReindexResult {
    collectionId: string;
    points: number;
    embedder: string;
    dimension: number;
    /** Points mirrored to the external index, when one is configured. */
    indexed?: number | null;
    /** Why the external index could not be rebuilt; the SQL vectors are still updated. */
    indexError?: string;
}

export interface VectorIndexStatus {
    provider: 'builtin' | 'qdrant';
    configured: boolean;
    healthy: boolean;
    collectionId: string;
    sqlPoints: number;
    indexPoints: number | null;
    missing: number | null;
    status: 'builtin' | 'current' | 'missing' | 'stale' | 'error';
    blocked?: string | null;
    version?: string;
    latencyMs?: number;
    error?: string;
}

export interface VectorIndexRebuildResult {
    collectionId: string;
    provider: 'builtin' | 'qdrant';
    points: number;
}

export interface VectorIngestResult {
    collectionId: string;
    documentId: string;
    chunks: number;
    characters: number;
    /** Source format: pdf, markdown, html, docx, text, ... */
    format: string;
    pages?: number;
    $createdAt: string;
}

export interface VectorIngestDocumentParams {
    collectionId: string;
    /** A PDF, Markdown, HTML, DOCX, ODT, EPUB, RTF, JSON, CSV, XML, YAML or text file. */
    file: File | Blob | InputFile;
    /** Used when a Blob has no name. */
    filename?: string;
    /** Re-ingesting the same ID replaces that document's chunks. */
    documentId?: string;
    metadata?: Record<string, unknown>;
    /** Appwrite-style permissions applied to every chunk. */
    permissions?: string[];
    /** Characters per chunk, 64 to 8000. */
    chunkSize?: number;
    /** Characters shared by adjacent chunks. */
    chunkOverlap?: number;
}

/**
 * Bunwrite's built-in vector store. A Bunwrite extension: points live beside
 * the project's SQLite or Postgres data, with local or OpenAI-compatible
 * embeddings. Needs an API key with `vectorsdb.*` scopes.
 */
export class Vectors {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /** Create a vector collection. */
    createCollection(params: CreateVectorCollectionParams): Promise<VectorCollection> {
        requireString(params?.collectionId, 'collectionId');
        return this._call('post', '/vectors', clean({
            collectionId: params.collectionId,
            name: params.name,
            dimension: params.dimension,
            metric: params.metric,
        }));
    }

    /** List every vector collection in the project. */
    listCollections(): Promise<VectorCollectionList> {
        return this._call('get', '/vectors');
    }

    /** Read one vector collection. */
    getCollection(params: { collectionId: string }): Promise<VectorCollection> {
        requireString(params?.collectionId, 'collectionId');
        return this._call('get', `/vectors/${encodeURIComponent(params.collectionId)}`);
    }

    /** Delete a collection and every point in it. */
    deleteCollection(params: { collectionId: string }): Promise<void> {
        requireString(params?.collectionId, 'collectionId');
        return this._call('delete', `/vectors/${encodeURIComponent(params.collectionId)}`).then(() => undefined);
    }

    /** Re-embed every point with the project's active embedder. */
    reindex(params: { collectionId: string }): Promise<VectorReindexResult> {
        requireString(params?.collectionId, 'collectionId');
        return this._call('post', `/vectors/${encodeURIComponent(params.collectionId)}/reindex`);
    }

    /** Compare the SQL point count with the configured external index. */
    indexStatus(params: { collectionId: string }): Promise<VectorIndexStatus> {
        requireString(params?.collectionId, 'collectionId');
        return this._call('get', `/vectors/${encodeURIComponent(params.collectionId)}/index`);
    }

    /** Recreate and refill the external index from the SQL points. */
    rebuildIndex(params: { collectionId: string }): Promise<VectorIndexRebuildResult> {
        requireString(params?.collectionId, 'collectionId');
        return this._call('post', `/vectors/${encodeURIComponent(params.collectionId)}/index/rebuild`);
    }

    /** List points, optionally only those belonging to one document. */
    listPoints(params: VectorListParams): Promise<VectorPointList> {
        requireString(params?.collectionId, 'collectionId');
        return this._call('get', `/vectors/${encodeURIComponent(params.collectionId)}/points`, clean({
            documentId: params.documentId,
            limit: params.limit,
            offset: params.offset,
        }));
    }

    /** Read one point. */
    getPoint(params: { collectionId: string; pointId: string }): Promise<VectorPoint> {
        requireString(params?.collectionId, 'collectionId');
        requireString(params?.pointId, 'pointId');
        return this._call('get', `/vectors/${encodeURIComponent(params.collectionId)}/points/${encodeURIComponent(params.pointId)}`);
    }

    /** Create a point, or update it when `pointId` is set. */
    upsertPoint(params: UpsertVectorPointParams): Promise<VectorPoint> {
        requireString(params?.collectionId, 'collectionId');
        const payload = clean({
            id: params.pointId,
            vector: params.vector,
            content: params.content,
            metadata: params.metadata,
            documentId: params.documentId,
            chunkIndex: params.chunkIndex,
            permissions: params.permissions,
        });
        if (typeof params.pointId === 'string' && params.pointId) {
            return this._call('put', `/vectors/${encodeURIComponent(params.collectionId)}/points/${encodeURIComponent(params.pointId)}`, payload);
        }
        // The collection-style endpoint answers with a batch wrapper.
        return this._call('post', `/vectors/${encodeURIComponent(params.collectionId)}/points`, payload).then((result) => result.points?.[0]);
    }

    /** Upsert several points in one transaction. */
    upsertPoints(params: UpsertVectorPointsParams): Promise<{ points: VectorPoint[] }> {
        requireString(params?.collectionId, 'collectionId');
        if (!Array.isArray(params.points)) throw new BunwriteException('Missing required parameter: "points"');
        return this._call('post', `/vectors/${encodeURIComponent(params.collectionId)}/points`, { points: params.points });
    }

    /** Delete one point. */
    deletePoint(params: { collectionId: string; pointId: string }): Promise<void> {
        requireString(params?.collectionId, 'collectionId');
        requireString(params?.pointId, 'pointId');
        return this._call('delete', `/vectors/${encodeURIComponent(params.collectionId)}/points/${encodeURIComponent(params.pointId)}`).then(() => undefined);
    }

    /** Similarity search. Higher scores are better for cosine, dot and euclidean. */
    search(params: VectorSearchParams): Promise<VectorSearchResult> {
        requireString(params?.collectionId, 'collectionId');
        if (typeof params.text !== 'string' && typeof params.query !== 'string' && !Array.isArray(params.vector)) {
            throw new BunwriteException('A search needs "text", "query" or "vector"');
        }
        return this._call('post', `/vectors/${encodeURIComponent(params.collectionId)}/search`, clean({
            text: params.text,
            query: params.query,
            vector: params.vector,
            topK: params.topK,
            filter: params.filter,
            hybrid: params.hybrid,
            rerank: params.rerank,
            alpha: params.alpha,
        }));
    }

    /** Ingested documents in this collection. */
    listDocuments(params: { collectionId: string; limit?: number }): Promise<VectorDocumentList> {
        requireString(params?.collectionId, 'collectionId');
        return this._call('get', `/vectors/${encodeURIComponent(params.collectionId)}/documents`, clean({ limit: params.limit }));
    }

    /**
     * Upload a document (PDF, Markdown, HTML, DOCX, ODT, EPUB, RTF, JSON, CSV,
     * XML, YAML or text), extract its text, chunk and embed it.
     */
    async ingestDocument(params: VectorIngestDocumentParams): Promise<VectorIngestResult> {
        requireString(params?.collectionId, 'collectionId');
        const file = await fileOf(params.file, params.filename);
        return this.client.call(
            'post',
            new URL(this.client.config.endpoint + `/vectors/${encodeURIComponent(params.collectionId)}/documents`),
            { 'X-Bunwrite-Project': this.client.config.project, accept: 'application/json', 'content-type': 'multipart/form-data' },
            clean({
                file,
                documentId: params.documentId,
                metadata: params.metadata,
                permissions: params.permissions,
                chunkSize: params.chunkSize,
                chunkOverlap: params.chunkOverlap,
            }),
        );
    }

    /** Chunks of one ingested document. */
    listDocumentPoints(params: VectorListParams & { documentId: string }): Promise<VectorPointList> {
        requireString(params?.collectionId, 'collectionId');
        requireString(params?.documentId, 'documentId');
        return this._call(
            'get',
            `/vectors/${encodeURIComponent(params.collectionId)}/documents/${encodeURIComponent(params.documentId)}`,
            clean({ limit: params.limit, offset: params.offset }),
        );
    }

    /** Recent retrieval audit rows for this collection (API key only). */
    listAudit(params: { collectionId: string; limit?: number }): Promise<VectorAuditList> {
        requireString(params?.collectionId, 'collectionId');
        return this._call('get', `/vectors/${encodeURIComponent(params.collectionId)}/audit`, clean({ limit: params.limit }));
    }

    /** Delete the audit trail for this collection. */
    deleteAudit(params: { collectionId: string }): Promise<{ deleted: number }> {
        requireString(params?.collectionId, 'collectionId');
        return this._call('delete', `/vectors/${encodeURIComponent(params.collectionId)}/audit`);
    }

    /** Delete every chunk belonging to one document. */
    deleteDocument(params: { collectionId: string; documentId: string }): Promise<{ deleted: number }> {
        requireString(params?.collectionId, 'collectionId');
        requireString(params?.documentId, 'documentId');
        return this._call(
            'delete',
            `/vectors/${encodeURIComponent(params.collectionId)}/documents/${encodeURIComponent(params.documentId)}`,
        );
    }

    private _call(method: string, path: string, params: Payload = {}): Promise<any> {
        return this.client.call(
            method,
            new URL(this.client.config.endpoint + path),
            { 'X-Bunwrite-Project': this.client.config.project, accept: 'application/json', 'content-type': 'application/json' },
            params,
        );
    }
}

function requireString(value: unknown, name: string): void {
    if (typeof value !== 'string' || !value) throw new BunwriteException(`Missing required parameter: "${name}"`);
}

async function fileOf(value: File | Blob | InputFile, filename?: string): Promise<File> {
    if (value instanceof InputFile) return value.toFile();
    if (typeof File !== 'undefined' && value instanceof File) return value;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return new File([value], filename || 'upload', { type: value.type });
    throw new BunwriteException('Missing required parameter: "file"');
}

function clean(params: Payload): Payload {
    const out: Payload = {};
    for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value;
    return out;
}
