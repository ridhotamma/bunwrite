import { BunwriteException, Client, type Payload } from '../client';
import { InputFile } from '../inputFile';
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

export interface RAGIngestFileParams {
    collectionId: string;
    /** A PDF, Markdown, HTML, DOCX, ODT, EPUB, RTF, JSON, CSV, XML, YAML or text file. */
    file: File | Blob | InputFile;
    /** Used when a Blob has no name. */
    filename?: string;
    documentId?: string;
    metadata?: Record<string, unknown>;
    chunkSize?: number;
    chunkOverlap?: number;
}

export interface RAGIngestResult {
    collectionId: string;
    documentId: string;
    chunks: number;
    characters: number;
    /** Source format: pdf, markdown, html, docx, text, ... */
    format: string;
    pages?: number;
    $createdAt: string;
}

export interface RAGQueryParams {
    collectionId: string;
    query: string;
    topK?: number;
    filter?: Record<string, unknown>;
    /** Set false to retrieve context without calling the configured chat model. */
    generate?: boolean;
    /** Override the project's hybrid-search setting. */
    hybrid?: boolean;
    /** Override the project's rerank setting. */
    rerank?: boolean;
    /** Vector share of the hybrid score, 0..1. */
    alpha?: number;
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

export interface RAGEvalCase {
    id?: string;
    query: string;
    expectedDocuments?: string[];
    expectedKeywords?: string[];
    expectRefusal?: boolean;
}

export interface RAGEvaluateParams {
    collectionId: string;
    cases: RAGEvalCase[];
    topK?: number;
    filter?: Record<string, unknown>;
    /** Required for expectRefusal cases when using a chat provider. */
    generate?: boolean;
    hybrid?: boolean;
    rerank?: boolean;
    alpha?: number;
}

export interface RAGEvalCaseResult {
    id: string;
    query: string;
    passed: boolean;
    expectedRefusal: boolean;
    recallAtK: number | null;
    reciprocalRank: number | null;
    ndcgAtK: number | null;
    contextKeywordCoverage: number | null;
    answerKeywordCoverage: number | null;
    refused: boolean | null;
    answer: string | null;
    sources: VectorMatch[];
    latencyMs: number;
    error?: string;
}

export interface RAGEvaluateResult {
    collectionId: string;
    total: number;
    passed: number;
    failed: number;
    metrics: {
        recallAtK: number | null;
        mrr: number | null;
        ndcgAtK: number | null;
        contextKeywordCoverage: number | null;
        answerKeywordCoverage: number | null;
        refusalAccuracy: number | null;
        averageLatencyMs: number;
    };
    cases: RAGEvalCaseResult[];
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

    /** Upload a file, extract its text, chunk and embed it. */
    async ingestFile(params: RAGIngestFileParams): Promise<RAGIngestResult> {
        requireString(params?.collectionId, 'collectionId');
        const file = await fileOf(params.file, params.filename);
        return this.client.call(
            'post',
            new URL(this.client.config.endpoint + '/rag/ingest'),
            { 'X-Bunwrite-Project': this.client.config.project, accept: 'application/json', 'content-type': 'multipart/form-data' },
            clean({
                collectionId: params.collectionId,
                file,
                documentId: params.documentId,
                metadata: params.metadata,
                chunkSize: params.chunkSize,
                chunkOverlap: params.chunkOverlap,
            }),
        );
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
            hybrid: params.hybrid,
            rerank: params.rerank,
            alpha: params.alpha,
        }));
    }

    /** Run a golden question set through retrieval and optional generation. */
    evaluate(params: RAGEvaluateParams): Promise<RAGEvaluateResult> {
        requireString(params?.collectionId, 'collectionId');
        if (!Array.isArray(params?.cases) || params.cases.length === 0) {
            throw new BunwriteException('Missing required parameter: "cases"');
        }
        return this._call('/rag/evaluate', clean({
            collectionId: params.collectionId,
            cases: params.cases,
            topK: params.topK,
            filter: params.filter,
            generate: params.generate,
            hybrid: params.hybrid,
            rerank: params.rerank,
            alpha: params.alpha,
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
