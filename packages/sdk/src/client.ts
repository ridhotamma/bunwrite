// Based on the clients of Appwrite's Web SDK and SDK for Node.js (BSD-3-Clause,
// see LICENSE), merged into one that runs in browsers, Bun, Node.js 18+ and
// edge runtimes with no dependencies.
import type { Models } from './models';
import type { Channel, ActionableChannel, ResolvedChannel } from './channel';
import { ID } from './id';
import { InputFile } from './inputFile';
import { JSONbig } from './json';
import type { Query } from './query';

export const SDK_VERSION = '0.1.0';

// Runtime globals, declared here so the SDK compiles with or without DOM and Node types.
declare const process: { platform?: string; arch?: string } | undefined;
declare const window: any;
declare const document: unknown;

type KeyValueStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };


// ---- Types ----

type Payload = {
    [key: string]: any;
};

type Headers = {
    [key: string]: string;
};

type UploadProgress = {
    $id: string;
    progress: number;
    sizeUploaded: number;
    chunksTotal: number;
    chunksUploaded: number;
};

type RealtimeResponse = {
    type: 'error' | 'event' | 'connected' | 'response' | 'pong';
    data: RealtimeResponseAuthenticated | RealtimeResponseConnected | RealtimeResponseError | RealtimeResponseEvent<unknown> | undefined;
};

type RealtimeRequest = {
    type: 'authentication' | 'subscribe';
    data: RealtimeRequestAuthenticate | RealtimeRequestSubscribe[];
};

type RealtimeRequestSubscribe = {
    subscriptionId: string;
    channels: string[];
    queries: string[];
};

export type RealtimeResponseEvent<T> = {
    events: string[];
    channels: string[];
    timestamp: string;
    payload: T;
    subscriptions?: string[];
};

type RealtimeResponseError = {
    code: number;
    message: string;
};

type RealtimeResponseConnected = {
    channels: string[];
    user?: object;
};

type RealtimeResponseAuthenticated = {
    to: string;
    success: boolean;
    user: object;
};

type RealtimeRequestAuthenticate = {
    session: string;
};

type TimeoutHandle = ReturnType<typeof setTimeout>;

type Realtime = {
    socket?: WebSocket;
    timeout?: TimeoutHandle;
    heartbeat?: ReturnType<typeof setInterval>;
    url?: string;
    lastMessage?: RealtimeResponse;
    channels: Set<string>;
    subscriptions: Map<string, { channels: string[]; queries: string[]; callback: (payload: RealtimeResponseEvent<any>) => void }>;
    pendingSubscribes: Map<string, RealtimeRequestSubscribe>;
    reconnect: boolean;
    reconnectAttempts: number;
    getTimeout: () => number;
    connect: () => void;
    createSocket: () => void;
    createHeartbeat: () => void;
    sendPendingSubscribes: () => void;
    onMessage: (event: MessageEvent) => void;
};

// ---- Errors ----

class BunwriteException extends Error {
    code: number;
    response: string;
    type: string;

    constructor(message: string, code: number = 0, type: string = '', response: string = '') {
        super(message);
        this.name = 'BunwriteException';
        this.message = message;
        this.code = code;
        this.type = type;
        this.response = response;
    }
}

// ---- Environment ----

const inBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

function storage(): KeyValueStorage | undefined {
    try {
        return typeof window !== 'undefined' && window.localStorage ? window.localStorage : undefined;
    } catch {
        return undefined;
    }
}

function userAgent(): string {
    let ua = `BunwriteSDK/${SDK_VERSION}`;
    const platform: string[] = [];
    if (typeof process !== 'undefined') {
        if (typeof process.platform === 'string') platform.push(process.platform);
        if (typeof process.arch === 'string') platform.push(process.arch);
    }
    if (platform.length > 0) ua += ` (${platform.join('; ')})`;
    if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') ua += ` ${navigator.userAgent}`;
    return ua;
}

// ---- Client ----

class Client {
    static CHUNK_SIZE = 1024 * 1024 * 5;

    config = {
        endpoint: 'http://localhost:8080/v1',
        endpointRealtime: '',
        selfSigned: false,
        project: '',
        key: '',
        organization: '',
        jwt: '',
        locale: '',
        session: '',
        forwardeduseragent: '',
        cookie: '',
    };

    headers: Headers = {
        'x-sdk-name': 'Bunwrite',
        'x-sdk-platform': inBrowser() ? 'client' : 'server',
        'x-sdk-language': inBrowser() ? 'web' : 'nodejs',
        'x-sdk-version': SDK_VERSION,
        'X-Appwrite-Response-Format': '2.0.0',
        // Browsers set their own user agent and refuse this header.
        ...(inBrowser() ? {} : { 'user-agent': userAgent() }),
    };

    /**
     * Set Endpoint
     *
     * Your Bunwrite endpoint, for example `https://api.example.com/v1`.
     */
    setEndpoint(endpoint: string): this {
        if (!endpoint || typeof endpoint !== 'string') {
            throw new BunwriteException('Endpoint must be a valid string');
        }
        if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
            throw new BunwriteException('Invalid endpoint URL: ' + endpoint);
        }
        this.config.endpoint = endpoint;
        this.config.endpointRealtime = endpoint.replace('https://', 'wss://').replace('http://', 'ws://');
        return this;
    }

    /**
     * Set Realtime Endpoint
     *
     * Only needed when realtime is served from another address than the API.
     */
    setEndpointRealtime(endpointRealtime: string): this {
        if (!endpointRealtime || typeof endpointRealtime !== 'string') {
            throw new BunwriteException('Endpoint must be a valid string');
        }
        if (!endpointRealtime.startsWith('ws://') && !endpointRealtime.startsWith('wss://')) {
            throw new BunwriteException('Invalid realtime endpoint URL: ' + endpointRealtime);
        }
        this.config.endpointRealtime = endpointRealtime;
        return this;
    }

    /**
     * Set self-signed
     *
     * Accept self-signed TLS certificates. Works on Bun; other runtimes
     * ignore it with a warning.
     */
    setSelfSigned(selfSigned: boolean): this {
        if (selfSigned && typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
            console.warn('setSelfSigned is only supported on Bun.');
        }
        this.config.selfSigned = selfSigned;
        return this;
    }

    /** Add a header sent with every request. */
    addHeader(header: string, value: string): this {
        this.headers[header.toLowerCase()] = value;
        return this;
    }

    /**
     * Get Headers
     *
     * A copy of the current request headers, including authentication
     * headers. Handle with care.
     */
    getHeaders(): Headers {
        return { ...this.headers };
    }

    /** Set Project: your project ID. */
    setProject(value: string): this {
        this.headers['X-Appwrite-Project'] = value;
        this.config.project = value;
        return this;
    }

    /** Set Key: your secret API key. Server side only. */
    setKey(value: string): this {
        this.headers['X-Appwrite-Key'] = value;
        this.config.key = value;
        return this;
    }

    /** Set Organization: your organization ID. */
    setOrganization(value: string): this {
        this.headers['X-Appwrite-Organization'] = value;
        this.config.organization = value;
        return this;
    }

    /** Set JWT: a user's JSON Web Token. */
    setJWT(value: string): this {
        this.headers['X-Appwrite-JWT'] = value;
        this.config.jwt = value;
        return this;
    }

    /** Set Locale. */
    setLocale(value: string): this {
        this.headers['X-Appwrite-Locale'] = value;
        this.config.locale = value;
        return this;
    }

    /** Set Session: the session secret of a user, to act as them. */
    setSession(value: string): this {
        this.headers['X-Appwrite-Session'] = value;
        this.config.session = value;
        return this;
    }

    /** Set ForwardedUserAgent: the user agent of the client that made the request. */
    setForwardedUserAgent(value: string): this {
        this.headers['X-Forwarded-User-Agent'] = value;
        this.config.forwardeduseragent = value;
        return this;
    }

    /**
     * Set Cookie
     *
     * A Cookie header to send, for server-side code that forwards the
     * cookies of an incoming request.
     */
    setCookie(value: string): this {
        this.headers['Cookie'] = value;
        this.config.cookie = value;
        return this;
    }

    // ---- Realtime (deprecated; use the Realtime service) ----

    private realtime: Realtime = {
        socket: undefined,
        timeout: undefined,
        heartbeat: undefined,
        url: '',
        channels: new Set(),
        subscriptions: new Map(),
        pendingSubscribes: new Map(),
        reconnect: true,
        reconnectAttempts: 0,
        lastMessage: undefined,
        connect: () => {
            clearTimeout(this.realtime.timeout);
            this.realtime.timeout = setTimeout(() => {
                this.realtime.createSocket();
            }, 50);
        },
        getTimeout: () => {
            switch (true) {
                case this.realtime.reconnectAttempts < 5:
                    return 1000;
                case this.realtime.reconnectAttempts < 15:
                    return 5000;
                case this.realtime.reconnectAttempts < 100:
                    return 10_000;
                default:
                    return 60_000;
            }
        },
        createHeartbeat: () => {
            if (this.realtime.heartbeat) clearInterval(this.realtime.heartbeat);
            this.realtime.heartbeat = setInterval(() => {
                this.realtime.socket?.send(JSONbig.stringify({ type: 'ping' }));
            }, 20_000);
        },
        createSocket: () => {
            if (this.realtime.subscriptions.size < 1) {
                this.realtime.reconnect = false;
                this.realtime.socket?.close();
                if (this.realtime.heartbeat) clearInterval(this.realtime.heartbeat);
                return;
            }

            // The URL carries only the project; channels and queries go in subscribe messages.
            let queryParams = 'project=' + encodeURIComponent(this.config.project ?? '');
            if (this.config.jwt) queryParams += '&jwt=' + encodeURIComponent(this.config.jwt);
            const url = this.config.endpointRealtime + '/realtime?' + queryParams;

            if (url !== this.realtime.url || !this.realtime.socket || this.realtime.socket.readyState > WebSocket.OPEN) {
                if (this.realtime.socket && this.realtime.socket.readyState < WebSocket.CLOSING) {
                    this.realtime.reconnect = false;
                    this.realtime.socket.close();
                }

                this.realtime.url = url;
                this.realtime.socket = new WebSocket(url);
                this.realtime.socket.addEventListener('message', this.realtime.onMessage);
                this.realtime.socket.addEventListener('open', () => {
                    this.realtime.reconnectAttempts = 0;
                    this.realtime.createHeartbeat();
                });
                this.realtime.socket.addEventListener('close', (event) => {
                    if (
                        !this.realtime.reconnect ||
                        (this.realtime.lastMessage?.type === 'error' &&
                            (this.realtime.lastMessage.data as RealtimeResponseError).code === 1008)
                    ) {
                        this.realtime.reconnect = true;
                        return;
                    }

                    const timeout = this.realtime.getTimeout();
                    console.error(`Realtime got disconnected. Reconnect will be attempted in ${timeout / 1000} seconds.`, event.reason);
                    setTimeout(() => {
                        this.realtime.reconnectAttempts++;
                        this.realtime.createSocket();
                    }, timeout);
                });
            } else if (this.realtime.socket.readyState === WebSocket.OPEN) {
                this.realtime.sendPendingSubscribes();
            }
        },
        sendPendingSubscribes: () => {
            if (!this.realtime.socket || this.realtime.socket.readyState !== WebSocket.OPEN) return;
            if (this.realtime.pendingSubscribes.size < 1) return;
            const rows = Array.from(this.realtime.pendingSubscribes.values());
            this.realtime.pendingSubscribes.clear();
            this.realtime.socket.send(JSONbig.stringify(<RealtimeRequest>{ type: 'subscribe', data: rows }));
        },
        onMessage: (event) => {
            try {
                const message: RealtimeResponse = JSONbig.parse(event.data);
                this.realtime.lastMessage = message;
                switch (message.type) {
                    case 'connected': {
                        const messageData = <RealtimeResponseConnected>message.data;
                        let session = this.config.session;
                        if (!session) {
                            const cookie = JSONbig.parse(storage()?.getItem('cookieFallback') ?? '{}');
                            session = cookie?.[`a_session_${this.config.project}`];
                        }
                        if (session && !messageData?.user) {
                            this.realtime.socket?.send(
                                JSONbig.stringify(<RealtimeRequest>{ type: 'authentication', data: { session } }),
                            );
                        }
                        this.realtime.subscriptions.forEach((sub, subscriptionId) => {
                            this.realtime.pendingSubscribes.set(subscriptionId, {
                                subscriptionId,
                                channels: sub.channels,
                                queries: sub.queries ?? [],
                            });
                        });
                        this.realtime.sendPendingSubscribes();
                        break;
                    }
                    case 'response':
                        break;
                    case 'event': {
                        const data = <RealtimeResponseEvent<unknown>>message.data;
                        if (!data?.channels) break;
                        const eventSubIds = data.subscriptions;
                        if (eventSubIds && eventSubIds.length > 0) {
                            for (const subscriptionId of eventSubIds) {
                                const subscription = this.realtime.subscriptions.get(subscriptionId);
                                if (subscription) setTimeout(() => subscription.callback(data));
                            }
                        } else {
                            const isSubscribed = data.channels.some((channel) => this.realtime.channels.has(channel));
                            if (!isSubscribed) break;
                            this.realtime.subscriptions.forEach((subscription) => {
                                if (data.channels.some((channel) => subscription.channels.includes(channel))) {
                                    setTimeout(() => subscription.callback(data));
                                }
                            });
                        }
                        break;
                    }
                    case 'pong':
                        break;
                    case 'error':
                        throw message.data;
                    default:
                        break;
                }
            } catch (e) {
                console.error(e);
            }
        },
    };

    /**
     * Subscribes to events and passes you the payload in realtime.
     *
     * @deprecated Use the Realtime service instead.
     *
     * Channels: `account`, `databases.[ID].collections.[ID].documents`,
     * `documents`, `documents.[ID]`, `files`, `files.[ID]`, `executions`,
     * `teams`, `memberships`, or Channel builders such as
     * `Channel.database('db').collection('col').document('doc').create()`.
     *
     * @returns {() => void} Unsubscribes from events.
     */
    subscribe<T>(
        channels:
            | string
            | string[]
            | Channel<any>
            | ActionableChannel
            | ResolvedChannel
            | (Channel<any> | ActionableChannel | ResolvedChannel)[],
        callback: (payload: RealtimeResponseEvent<T>) => void,
        queries: (string | Query)[] = [],
    ): () => void {
        const channelArray = Array.isArray(channels) ? channels : [channels];
        const channelStrings = channelArray.map((ch) => (typeof ch === 'string' ? ch : String(ch.toString())));
        channelStrings.forEach((channel) => this.realtime.channels.add(channel));

        const queryStrings = (queries ?? []).map((q) => (typeof q === 'string' ? q : q.toString()));

        let subscriptionId = '';
        const attempts = this.realtime.subscriptions.size + 1;
        for (let i = 0; i < attempts; i++) {
            const candidate = ID.unique();
            if (!this.realtime.subscriptions.has(candidate)) {
                subscriptionId = candidate;
                break;
            }
        }
        if (subscriptionId === '') throw new BunwriteException('Failed to generate unique subscription id');

        this.realtime.subscriptions.set(subscriptionId, { channels: channelStrings, queries: queryStrings, callback });
        this.realtime.pendingSubscribes.set(subscriptionId, { subscriptionId, channels: channelStrings, queries: queryStrings });
        this.realtime.connect();

        return () => {
            this.realtime.subscriptions.delete(subscriptionId);
            this.realtime.pendingSubscribes.delete(subscriptionId);
            const stillUsed = new Set<string>();
            this.realtime.subscriptions.forEach((sub) => sub.channels.forEach((channel) => stillUsed.add(channel)));
            this.realtime.channels.forEach((channel) => {
                if (!stillUsed.has(channel)) this.realtime.channels.delete(channel);
            });
            this.realtime.connect();
        };
    }

    // ---- Requests ----

    prepareRequest(method: string, url: URL, headers: Headers = {}, params: Payload = {}): { uri: string; options: RequestInit } {
        method = method.toUpperCase();
        headers = Object.assign({}, this.headers, headers);

        const cookieFallback = storage()?.getItem('cookieFallback');
        if (cookieFallback) headers['X-Fallback-Cookies'] = cookieFallback;

        const options: RequestInit & { tls?: { rejectUnauthorized: boolean } } = { method, headers };
        if (inBrowser()) options.credentials = 'include';
        if (this.config.selfSigned) options.tls = { rejectUnauthorized: false };

        if (method === 'GET') {
            for (const [key, value] of Object.entries(Client.flatten(params))) {
                url.searchParams.append(key, value);
            }
        } else {
            switch (headers['content-type']) {
                case 'application/json':
                    options.body = JSONbig.stringify(params);
                    break;

                case 'multipart/form-data': {
                    const formData = new FormData();
                    for (const [key, value] of Object.entries(params)) {
                        if (value instanceof File) {
                            formData.append(key, value, value.name);
                        } else if (Array.isArray(value)) {
                            for (const nestedValue of value) formData.append(`${key}[]`, nestedValue);
                        } else if (value !== undefined) {
                            formData.append(key, typeof value === 'object' && value !== null ? JSONbig.stringify(value) : String(value));
                        }
                    }
                    options.body = formData;
                    delete headers['content-type'];
                    break;
                }
            }
        }

        return { uri: url.toString(), options };
    }

    /**
     * Upload a file in 5 MB chunks (`Content-Range`, `x-appwrite-id`), up to 8 at a time.
     * Accepts a `File` or an `InputFile`.
     */
    async chunkedUpload(
        method: string,
        url: URL,
        headers: Headers = {},
        originalPayload: Payload = {},
        onProgress?: (progress: UploadProgress) => void,
    ) {
        const [fileParam, input] =
            Object.entries(originalPayload).find(([_, value]) => value instanceof File || value instanceof InputFile) ?? [];
        if (!input || !fileParam) throw new Error('File not found in payload');

        const name: string = input instanceof InputFile ? input.filename : (input as File).name;
        const size: number = input instanceof InputFile ? await input.size() : (input as File).size;
        const slice = async (start: number, end: number): Promise<Blob | Uint8Array> =>
            input instanceof InputFile ? await input.slice(start, end) : (input as File).slice(start, end);

        if (size <= Client.CHUNK_SIZE) {
            const payload = { ...originalPayload };
            payload[fileParam] = input instanceof InputFile ? await input.toFile() : input;
            return await this.call(method, url, headers, payload);
        }

        const totalChunks = Math.ceil(size / Client.CHUNK_SIZE);

        // The first chunk goes alone; its response carries the upload ID.
        const firstChunkEnd = Math.min(Client.CHUNK_SIZE, size);
        const firstPayload = { ...originalPayload };
        firstPayload[fileParam] = new File([(await slice(0, firstChunkEnd)) as any], name);
        const response = await this.call(method, url, { ...headers, 'content-range': `bytes 0-${firstChunkEnd - 1}/${size}` }, firstPayload);
        const uploadId = response?.$id;

        onProgress?.({
            $id: uploadId,
            progress: Math.round((firstChunkEnd / size) * 100),
            sizeUploaded: firstChunkEnd,
            chunksTotal: totalChunks,
            chunksUploaded: 1,
        });

        if (totalChunks === 1) return response;

        const chunks: { start: number; end: number }[] = [];
        for (let i = 1; i < totalChunks; i++) {
            const start = i * Client.CHUNK_SIZE;
            chunks.push({ start, end: Math.min(start + Client.CHUNK_SIZE, size) });
        }

        const CONCURRENCY = 8;
        let completedCount = 1;
        let uploadedBytes = firstChunkEnd;
        let lastResponse = response;
        let finalResponse = null;
        let failed = false;

        const isUploadComplete = (chunkResponse: any) => {
            const chunksUploaded = chunkResponse?.chunksUploaded;
            const chunksTotal = chunkResponse?.chunksTotal ?? totalChunks;
            return typeof chunksUploaded === 'number' && typeof chunksTotal === 'number' && chunksUploaded >= chunksTotal;
        };

        const uploadChunk = async (chunk: { start: number; end: number }) => {
            const chunkHeaders: Headers = { ...headers, 'content-range': `bytes ${chunk.start}-${chunk.end - 1}/${size}` };
            if (uploadId) chunkHeaders['x-appwrite-id'] = uploadId;
            const chunkPayload = { ...originalPayload };
            chunkPayload[fileParam] = new File([(await slice(chunk.start, chunk.end)) as any], name);

            const chunkResponse = await this.call(method, url, chunkHeaders, chunkPayload);
            if (failed) return chunkResponse;

            completedCount++;
            uploadedBytes += chunk.end - chunk.start;
            lastResponse = chunkResponse;
            if (isUploadComplete(chunkResponse)) finalResponse = chunkResponse;

            onProgress?.({
                $id: uploadId,
                progress: Math.round((uploadedBytes / size) * 100),
                sizeUploaded: uploadedBytes,
                chunksTotal: totalChunks,
                chunksUploaded: completedCount,
            });
            return chunkResponse;
        };

        const queue = [...chunks];
        const workers: Promise<void>[] = [];
        for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
            workers.push(
                (async () => {
                    while (!failed && queue.length > 0) {
                        const chunk = queue.shift()!;
                        try {
                            await uploadChunk(chunk);
                        } catch (error) {
                            failed = true;
                            throw error;
                        }
                    }
                })(),
            );
        }
        await Promise.all(workers);

        return finalResponse ?? lastResponse;
    }

    /** Check that the server answers. Resolves with its health status. */
    async ping(): Promise<unknown> {
        return this.call('GET', new URL(this.config.endpoint + '/health'), { accept: 'application/json' });
    }

    /** Make the request and return where the server redirects to. */
    async redirect(method: string, url: URL, headers: Headers = {}, params: Payload = {}): Promise<string> {
        const { uri, options } = this.prepareRequest(method, url, headers, params);
        const response = await fetch(uri, { ...options, redirect: 'manual' });
        if (response.status !== 301 && response.status !== 302) {
            throw new BunwriteException('Invalid redirect', response.status);
        }
        return response.headers.get('location') || '';
    }

    async call(method: string, url: URL, headers: Headers = {}, params: Payload = {}, responseType = 'json'): Promise<any> {
        const { uri, options } = this.prepareRequest(method, url, headers, params);

        let data: any = null;
        const response = await fetch(uri, options);

        // No-CORS response from another origin.
        if (response.type === 'opaque') {
            throw new BunwriteException(
                `Invalid Origin. Add ${typeof window !== 'undefined' ? window.location.host : 'this origin'} to the allowed origins in the Bunwrite console`,
                403,
                'forbidden',
                '',
            );
        }

        const warnings = response.headers.get('x-appwrite-warning');
        if (warnings) warnings.split(';').forEach((warning) => console.warn('Warning: ' + warning));

        const isJson = response.headers.get('content-type')?.includes('application/json');
        if (isJson) {
            const text = await response.text();
            data = text ? JSONbig.parse(text) : {};
        } else if (responseType === 'arrayBuffer') {
            data = await response.arrayBuffer();
        } else {
            data = { message: await response.text() };
        }

        if (400 <= response.status) {
            const responseText = isJson || responseType === 'arrayBuffer' ? JSONbig.stringify(data) : data?.message;
            throw new BunwriteException(data?.message ?? responseText, response.status, data?.type, responseText);
        }

        const cookieFallback = response.headers.get('X-Fallback-Cookies');
        const local = storage();
        if (local && cookieFallback) {
            console.warn('Bunwrite is using localStorage for session management. Serve the API from your own domain to use cookies instead.');
            local.setItem('cookieFallback', cookieFallback);
        }

        if (data && typeof data === 'object' && !(data instanceof ArrayBuffer)) {
            Object.defineProperty(data, 'toString', {
                value: () => JSONbig.stringify(data),
                writable: true,
                enumerable: false,
                configurable: true,
            });
        }

        return data;
    }

    static flatten(data: Payload, prefix = ''): Payload {
        let output: Payload = {};
        for (const [key, value] of Object.entries(data)) {
            const finalKey = prefix ? prefix + '[' + key + ']' : key;
            if (Array.isArray(value)) {
                output = { ...output, ...Client.flatten(value, finalKey) };
            } else {
                output[finalKey] = value;
            }
        }
        return output;
    }
}

export { Client, BunwriteException, BunwriteException as AppwriteException, JSONbig };
export { Query } from './query';
export type { Models, Payload, UploadProgress };
export type { QueryTypes, QueryTypesList } from './query';
