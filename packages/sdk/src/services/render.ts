import { BunwriteException, Client, type Payload } from '../client';
import type { Models } from '../models';

/** Margin in millimetres: one value for every side, or each side on its own. */
export type RenderMargin = number | { top?: number; right?: number; bottom?: number; left?: number };

/** Save the result to a bucket instead of returning it. */
type SaveTo = {
    /** Save to this bucket; the call then resolves with the file. */
    bucketId?: string;
    /** File ID when saving to a bucket. Defaults to a unique ID. */
    fileId?: string;
    /** File permissions when saving to a bucket. */
    permissions?: string[];
    /** File name. The extension is added when missing. */
    fileName?: string;
};

export type RenderPdfParams = SaveTo & {
    /** A full HTML document, up to 5 MB. */
    html: string;
    format?: 'A3' | 'A4' | 'A5' | 'Letter' | 'Legal' | 'Tabloid';
    landscape?: boolean;
    printBackground?: boolean;
    margin?: RenderMargin;
    /** 0.1 to 2. */
    scale?: number;
    /** For example `"1-2"`. */
    pageRanges?: string;
    headerTemplate?: string;
    footerTemplate?: string;
};

export type RenderImageParams = SaveTo & {
    /** A full HTML document, up to 5 MB. */
    html: string;
    output?: 'png' | 'jpg' | 'jpeg' | 'webp' | 'avif' | 'gif';
    /** Viewport width in CSS pixels, 16 to 4000. */
    width?: number;
    /** Viewport height in CSS pixels, 16 to 16384. */
    height?: number;
    /** Capture the whole page (default) or only the viewport. */
    fullPage?: boolean;
    /** Capture only the first element matching this CSS selector. */
    selector?: string;
    /** Device pixel ratio, 0.1 to 3. Below 1 shrinks the bitmap, not the layout. */
    scale?: number;
    /** 1 to 100 for jpg, webp and avif. */
    quality?: number;
    /** Transparent page background (not for jpg). */
    transparent?: boolean;
};

export type RenderJobStatus = 'waiting' | 'processing' | 'completed' | 'failed';

/** A queued render (`pdfJob`, `imageJob`). The file is in the bucket once `status` is `completed`. */
export type RenderJob = {
    $id: string;
    $createdAt: string;
    $updatedAt: string;
    type: 'pdf' | 'image';
    status: RenderJobStatus;
    attempts: number;
    maxAttempts: number;
    bucketId: string;
    /** Fixed when the job is created, so you can store it before the render runs. */
    fileId: string;
    fileName: string;
    completedAt: string | null;
    /** Why the last attempt failed; empty when none did. */
    errors: string;
};

/**
 * HTML to PDF or image with headless Chromium. A Bunwrite extension: needs an
 * API key and HTML rendering turned on in the console (see docs/RENDER.md).
 */
export class Render {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /** Render HTML to a PDF. Resolves with the bytes, or the file when `bucketId` is set. */
    pdf(params: RenderPdfParams & { bucketId: string }): Promise<Models.File>;
    pdf(params: RenderPdfParams): Promise<ArrayBuffer>;
    pdf(params: RenderPdfParams): Promise<ArrayBuffer | Models.File> {
        return this.render('/pdf', params);
    }

    /** Render HTML to an image. Resolves with the bytes, or the file when `bucketId` is set. */
    image(params: RenderImageParams & { bucketId: string }): Promise<Models.File>;
    image(params: RenderImageParams): Promise<ArrayBuffer>;
    image(params: RenderImageParams): Promise<ArrayBuffer | Models.File> {
        return this.render('/image', params);
    }

    /**
     * Queue a PDF render and resolve at once with the job. The server renders
     * it when the line is free and saves it to `bucketId`; poll `getJob`.
     * Use it for bursts: queued renders never get 429.
     */
    pdfJob(params: RenderPdfParams & { bucketId: string }): Promise<RenderJob> {
        return this.render('/pdf', { ...params, async: true }, 'json');
    }

    /** Queue an image render; see `pdfJob`. */
    imageJob(params: RenderImageParams & { bucketId: string }): Promise<RenderJob> {
        return this.render('/image', { ...params, async: true }, 'json');
    }

    /** Read a queued render. */
    getJob(params: { jobId: string }): Promise<RenderJob> {
        if (typeof params?.jobId !== 'string' || !params.jobId) {
            throw new BunwriteException('Missing required parameter: "jobId"');
        }
        return this.client.call(
            'get',
            new URL(this.client.config.endpoint + `/render/jobs/${encodeURIComponent(params.jobId)}`),
            { 'X-Bunwrite-Project': this.client.config.project },
        );
    }

    private render(path: string, params: Payload, responseType = 'arrayBuffer'): Promise<any> {
        if (typeof params?.html !== 'string') {
            throw new BunwriteException('Missing required parameter: "html"');
        }
        const payload: Payload = {};
        for (const [key, value] of Object.entries(params)) if (value !== undefined) payload[key] = value;
        return this.client.call(
            'post',
            new URL(this.client.config.endpoint + path),
            { 'X-Bunwrite-Project': this.client.config.project, 'content-type': 'application/json' },
            payload,
            responseType,
        );
    }
}
