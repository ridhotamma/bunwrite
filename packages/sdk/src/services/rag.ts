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
    /** Appwrite-style permissions applied to every chunk. */
    permissions?: string[];
    /** Characters per chunk, 64 to 8000. */
    chunkSize?: number;
    /** Characters shared by adjacent chunks. */
    chunkOverlap?: number;
}

export interface RAGIngestFileParams {
    collectionId: string;
    /** A PDF, image, Markdown, HTML, DOCX, ODT, EPUB, RTF, JSON, CSV, XML, YAML or text file. */
    file: File | Blob | InputFile;
    /** Used when a Blob has no name. */
    filename?: string;
    documentId?: string;
    metadata?: Record<string, unknown>;
    permissions?: string[];
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
    /** PDF pages that were OCR'd. */
    ocrPages?: number[];
    /** Markdown tables found during extraction. */
    tables?: number;
    $createdAt: string;
}

export interface RAGIngestJob {
    jobId: string;
    status: string;
    collectionId: string;
    documentId: string;
}

export interface RAGJobStatus {
    id: string;
    status: string;
    attempts: number;
    result: unknown;
    errors: string;
    createdAt: string;
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
    /** Ask the chat model to plan multiple retrieval queries (requires generation). */
    multiHop?: boolean;
}

export interface RAGQueryResult {
    query: string;
    /** `null` when generation is off, no chat provider is configured, or nothing matched. */
    answer: string | null;
    context: string;
    sources: VectorMatch[];
    model: string | null;
    security?: {
        redactions: number;
        redactionKinds: string[];
        suspiciousSources: string[];
    };
    plannedQueries?: string[];
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
    /** Display name for a saved run. */
    name?: string;
    /** Save the run; defaults to true. */
    save?: boolean;
    /** Compare against an earlier run in the same collection. */
    baselineId?: string;
    /** Record whether the result should fail a regression gate. */
    failOnRegression?: boolean;
    /** Plan multiple retrieval queries per case. */
    multiHop?: boolean;
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

export interface RAGEvaluationRegression {
    baselineId: string;
    baselineName: string;
    deltas: Record<string, number | null>;
    failures: string[];
    passed: boolean;
}

export interface RAGEvaluateResult {
    $id?: string;
    collectionId: string;
    name?: string;
    saved?: boolean;
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
    regression?: RAGEvaluationRegression;
    cases: RAGEvalCaseResult[];
}

export interface RAGEvaluationSummary {
    $id: string;
    collectionId: string;
    name: string;
    total: number;
    passed: number;
    failed: number;
    metrics: RAGEvaluateResult['metrics'];
    $createdAt: string;
    $updatedAt: string;
}

export interface RAGEvaluationRun extends RAGEvaluationSummary {
    dataset: unknown;
    result: RAGEvaluateResult;
}

export interface RAGEvaluationList {
    total: number;
    evaluations: RAGEvaluationSummary[];
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
            permissions: params.permissions,
            chunkSize: params.chunkSize,
            chunkOverlap: params.chunkOverlap,
        }));
    }

    /** Queue a text ingest; poll getJob for completion. */
    enqueueIngest(params: RAGIngestParams): Promise<RAGIngestJob> {
        requireString(params?.collectionId, 'collectionId');
        requireString(params?.text, 'text');
        return this._call('/rag/ingest', clean({
            collectionId: params.collectionId,
            documentId: params.documentId,
            text: params.text,
            metadata: params.metadata,
            permissions: params.permissions,
            chunkSize: params.chunkSize,
            chunkOverlap: params.chunkOverlap,
            async: true,
        }));
    }

    /** Status of an asynchronous ingest job. */
    getJob(params: { jobId: string }): Promise<RAGJobStatus> {
        requireString(params?.jobId, 'jobId');
        return this._request('get', `/rag/jobs/${encodeURIComponent(params.jobId)}`);
    }

    /** Queue a file ingest; extraction/OCR runs in the worker. */
    async enqueueIngestFile(params: RAGIngestFileParams): Promise<RAGIngestJob> {
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
                permissions: params.permissions,
                chunkSize: params.chunkSize,
                chunkOverlap: params.chunkOverlap,
                async: true,
            }),
        );
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
                permissions: params.permissions,
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
            multiHop: params.multiHop,
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
            name: params.name,
            save: params.save,
            baselineId: params.baselineId,
            failOnRegression: params.failOnRegression,
            multiHop: params.multiHop,
        }));
    }

    /** Saved evaluation runs, newest first. */
    listEvaluations(params: { collectionId: string; limit?: number }): Promise<RAGEvaluationList> {
        requireString(params?.collectionId, 'collectionId');
        return this._request('get', '/rag/evaluations', clean({ collectionId: params.collectionId, limit: params.limit }));
    }

    /** Read one saved evaluation run, including case results. */
    getEvaluation(params: { evaluationId: string }): Promise<RAGEvaluationRun> {
        requireString(params?.evaluationId, 'evaluationId');
        return this._request('get', `/rag/evaluations/${encodeURIComponent(params.evaluationId)}`);
    }

    /** Delete a saved evaluation run. */
    deleteEvaluation(params: { evaluationId: string }): Promise<void> {
        requireString(params?.evaluationId, 'evaluationId');
        return this._request('delete', `/rag/evaluations/${encodeURIComponent(params.evaluationId)}`).then(() => undefined);
    }

    private _request(method: string, path: string, params: Payload = {}): Promise<any> {
        return this.client.call(
            method,
            new URL(this.client.config.endpoint + path),
            { 'X-Bunwrite-Project': this.client.config.project, accept: 'application/json', 'content-type': 'application/json' },
            params,
        );
    }

    private _call(path: string, params: Payload): Promise<any> {
        return this._request('post', path, params);
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
