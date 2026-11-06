import { BunwriteException, Client, type Payload } from '../client';
import type { VectorMatch } from './vectors';

export interface RAGIngestParams {
    collectionId: string;
    /** The full text to split, embed and store. */
    text: string;
    /** Re-ingesting the same ID replaces that document's chunks. */
    documentId?: string;
    metadata?: Record<string, unknown>;
    /** Characters per chunk, 64 to 8000. */
    chunkSize?: number;
    /** Characters shared by adjacent chunks. */
    chunkOverlap?: number;
}

export interface RAGIngestResult {
    collectionId: string;
    documentId: string;
    chunks: number;
    $createdAt: string;
}

export interface RAGQueryParams {
    collectionId: string;
    query: string;
    topK?: number;
    filter?: Record<string, unknown>;
    /** Set false to retrieve context without calling the configured chat model. */
    generate?: boolean;
}

export interface RAGQueryResult {
    query: string;
    /** `null` when generation is off, no chat provider is configured, or nothing matched. */
    answer: string | null;
    context: string;
    sources: VectorMatch[];
    model: string | null;
    usage?: unknown;
}

/**
 * Retrieval-augmented generation over a Bunwrite vector collection. A
 * Bunwrite extension: text is chunked, embedded and stored by the server.
 * Needs an API key with `vectorsdb.documents.*` scopes.
 */
export class RAG {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /** Chunk, embed and store a document. */
    ingest(params: RAGIngestParams): Promise<RAGIngestResult> {
        requireString(params?.collectionId, 'collectionId');
        requireString(params?.text, 'text');
        return this._call('/rag/ingest', clean({
            collectionId: params.collectionId,
            documentId: params.documentId,
            text: params.text,
            metadata: params.metadata,
            chunkSize: params.chunkSize,
            chunkOverlap: params.chunkOverlap,
        }));
    }

    /** Retrieve relevant chunks, and generate an answer when a chat provider is configured. */
    query(params: RAGQueryParams): Promise<RAGQueryResult> {
        requireString(params?.collectionId, 'collectionId');
        requireString(params?.query, 'query');
        return this._call('/rag/query', clean({
            collectionId: params.collectionId,
            query: params.query,
            topK: params.topK,
            filter: params.filter,
            generate: params.generate,
        }));
    }

    private _call(path: string, params: Payload): Promise<any> {
        return this.client.call(
            'post',
            new URL(this.client.config.endpoint + path),
            { 'X-Bunwrite-Project': this.client.config.project, accept: 'application/json', 'content-type': 'application/json' },
            params,
        );
    }
}

function requireString(value: unknown, name: string): void {
    if (typeof value !== 'string' || !value) throw new BunwriteException(`Missing required parameter: "${name}"`);
}

function clean(params: Payload): Payload {
    const out: Payload = {};
    for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value;
    return out;
}
