import { BunwriteException, Client, type Payload } from '../client';

export type QueueMessageStatus = 'waiting' | 'processing' | 'completed' | 'failed';

export type QueueMessage<T = unknown> = {
    $id: string;
    $createdAt: string;
    $updatedAt: string;
    queue: string;
    status: QueueMessageStatus;
    /** How many times this message has been claimed (including the current claim). */
    attempts: number;
    maxAttempts: number;
    availableAt: string;
    /** When the current claim expires; null when nobody holds it. */
    leaseUntil: string | null;
    completedAt: string | null;
    idempotencyKey: string | null;
    /** The payload sent to `createMessage`, parsed from JSON when possible. */
    data: T;
    result: string;
    errors: string;
};

export type QueueMessageList = {
    total: number;
    messages: QueueMessage[];
};

export type QueueStats = {
    waiting: number;
    processing: number;
    completed: number;
    failed: number;
    total: number;
};

export type CreateQueueMessageParams<T = unknown> = {
    /** The queue name, 1 to 64 chars: letters, digits, dot, hyphen or underscore. */
    queue: string;
    data?: T;
    /** Message ID; `ID.unique()` or omitted for a new one. */
    id?: string;
    /** Seconds before the message becomes claimable. */
    delay?: number;
    /** Times the message may be claimed before it stays failed (1 to 100, default 3). */
    maxAttempts?: number;
    /** Enqueueing the same key twice returns the first message instead of a second one. */
    idempotencyKey?: string;
};

export type ClaimQueueMessagesParams = {
    queue: string;
    /** How many messages to claim at once (1 to 100, default 1). */
    count?: number;
    /** Lease length in seconds (1 to 86400, default 60). */
    lease?: number;
};

export type QueueMessageParams = {
    queue: string;
    messageId: string;
    /** The claimed message's `attempts` value: the claim token. Required for ack, fail and heartbeat. */
    attempt: number;
    /** Lease length in seconds, for `heartbeatMessage`. */
    lease?: number;
    /** The handler's return value, stored on the message, for `ackMessage`. */
    result?: unknown;
    /** Why the handler failed, for `failMessage`. */
    error?: string;
    /** Seconds before a failed message is retried, for `failMessage`. */
    delay?: number;
};

/**
 * The built-in job queue. A Bunwrite extension: workers claim messages, run
 * the handler in their own process, then ack or fail them (see docs/QUEUE.md).
 * Needs an API key.
 */
export class Queue {
    client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /** Enqueue a message. Resolves with the message, including its `$id`. */
    createMessage<T = unknown>(params: CreateQueueMessageParams<T>): Promise<QueueMessage<T>> {
        if (typeof params?.queue !== 'string' || !params.queue) {
            throw new BunwriteException('Missing required parameter: "queue"');
        }
        return this.call('post', `/queue/${encodeURIComponent(params.queue)}/messages`, clean({ ...params, queue: undefined }));
    }

    /** Claim up to `count` due messages for `lease` seconds. */
    claimMessages<T = unknown>(params: ClaimQueueMessagesParams): Promise<{ messages: QueueMessage<T>[] }> {
        if (typeof params?.queue !== 'string' || !params.queue) {
            throw new BunwriteException('Missing required parameter: "queue"');
        }
        return this.call('post', `/queue/${encodeURIComponent(params.queue)}/claim`, clean({ count: params.count, lease: params.lease }));
    }

    /** Read one message. */
    getMessage<T = unknown>(params: { queue: string; messageId: string }): Promise<QueueMessage<T>> {
        return this.call('get', `/queue/${encodeURIComponent(params.queue)}/messages/${encodeURIComponent(params.messageId)}`);
    }

    /** List a queue's messages, newest first. Pass SDK `Query` values in `queries`. */
    listMessages(params: { queue: string; queries?: string[]; status?: QueueMessageStatus }): Promise<QueueMessageList> {
        const query: Payload = clean({ status: params.status });
        if (params.queries?.length) query.queries = params.queries;
        return this.call('get', `/queue/${encodeURIComponent(params.queue)}/messages`, query);
    }

    /** Mark a claimed message done. Send the claim's `attempt`; a stale claim gets 409. */
    ackMessage(params: QueueMessageParams): Promise<QueueMessage> {
        return this.call('post', `/queue/${encodeURIComponent(params.queue)}/messages/${encodeURIComponent(params.messageId)}/ack`, clean({ attempt: params.attempt, result: params.result }));
    }

    /** Report a failure. The message is retried with backoff until `maxAttempts`. */
    failMessage(params: QueueMessageParams): Promise<QueueMessage> {
        return this.call('post', `/queue/${encodeURIComponent(params.queue)}/messages/${encodeURIComponent(params.messageId)}/fail`, clean({ attempt: params.attempt, error: params.error, delay: params.delay }));
    }

    /** Extend a running message's lease. */
    heartbeatMessage(params: QueueMessageParams): Promise<QueueMessage> {
        return this.call('post', `/queue/${encodeURIComponent(params.queue)}/messages/${encodeURIComponent(params.messageId)}/heartbeat`, clean({ attempt: params.attempt, lease: params.lease }));
    }

    /** Delete a message, whatever its status. */
    deleteMessage(params: { queue: string; messageId: string }): Promise<void> {
        return this.call('delete', `/queue/${encodeURIComponent(params.queue)}/messages/${encodeURIComponent(params.messageId)}`);
    }

    /** Counts by status. */
    getStats(params: { queue: string }): Promise<QueueStats> {
        return this.call('get', `/queue/${encodeURIComponent(params.queue)}/stats`);
    }

    /** Delete every message in a queue, or only those in one status. */
    purgeQueue(params: { queue: string; status?: QueueMessageStatus }): Promise<{ deleted: number }> {
        return this.call('delete', `/queue/${encodeURIComponent(params.queue)}`, clean({ status: params.status }));
    }

    private call(method: string, path: string, params: Payload = {}): Promise<any> {
        return this.client.call(
            method,
            new URL(this.client.config.endpoint + path),
            { 'X-Bunwrite-Project': this.client.config.project, 'content-type': 'application/json' },
            params,
        );
    }
}

/** Drop undefined values so they are not sent as "undefined". */
function clean(params: Payload): Payload {
    const out: Payload = {};
    for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value;
    return out;
}

export type QueueWorkerContext = {
    /** Keep the claim alive while the handler runs; the worker does this for you. */
    heartbeat(): Promise<void>;
    /** Aborted when the worker stops or loses the lease. */
    signal: AbortSignal;
};

export type QueueWorkerOptions<T = unknown> = {
    queue: string;
    /** Messages handled at the same time (default 1). */
    concurrency?: number;
    /** Lease length in seconds (default 60). The worker heartbeats at half of it. */
    lease?: number;
    /** Milliseconds to wait between claims when the queue is empty (default 1000). */
    pollInterval?: number;
    /** Runs the job. Throwing (or rejecting) fails the message. */
    handler(message: QueueMessage<T>, context: QueueWorkerContext): unknown | Promise<unknown>;
    /** Called when claiming, acking or failing fails. No message for claim errors. */
    onError?(error: unknown, message?: QueueMessage<T>): void;
};

export type QueueWorker = {
    /** Begin claiming. Safe to call twice. */
    start(): void;
    /** Stop claiming and wait for in-flight handlers. */
    stop(): Promise<void>;
    /** How many handlers are running right now. */
    readonly running: number;
};

/** A 409 from ack/fail/heartbeat means another worker owns the message now. */
function isLeaseConflict(error: unknown): boolean {
    return error instanceof BunwriteException && (error.type === 'queue_message_conflict' || error.code === 409);
}

/**
 * A polling worker for the built-in queue. It claims messages, heartbeats the
 * lease while your handler runs, then acks on success and fails on a throw.
 * Delivery is at-least-once, so handlers should be idempotent.
 *
 *     const worker = createQueueWorker(client, {
 *       queue: 'render',
 *       concurrency: 4,
 *       handler: async (message) => render(message.data),
 *     })
 *     worker.start()
 */
export function createQueueWorker<T = unknown>(client: Client, options: QueueWorkerOptions<T>): QueueWorker {
    const queue = new Queue(client);
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    const lease = Math.max(1, Math.floor(options.lease ?? 60));
    const pollInterval = Math.max(50, Math.floor(options.pollInterval ?? 1000));
    const inflight = new Set<Promise<void>>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let claiming = false;

    async function handle(message: QueueMessage<T>): Promise<void> {
        const controller = new AbortController();
        const attempt = message.attempts;
        let leaseLost = false;
        const loseLease = () => {
            leaseLost = true;
            controller.abort();
        };
        const beat = Math.max(1000, (lease * 1000) / 2);
        const heartbeat = setInterval(() => {
            queue.heartbeatMessage({ queue: options.queue, messageId: message.$id, attempt, lease }).catch(loseLease);
        }, beat);
        (heartbeat as { unref?: () => void }).unref?.();
        try {
            const result = await options.handler(message, {
                signal: controller.signal,
                heartbeat: async () => {
                    try {
                        await queue.heartbeatMessage({ queue: options.queue, messageId: message.$id, attempt, lease });
                    } catch (error) {
                        loseLease();
                        throw error;
                    }
                },
            });
            // The handler may ignore the abort signal. If the lease is gone,
            // another worker owns the message; never overwrite its result.
            if (leaseLost) return;
            try {
                await queue.ackMessage({ queue: options.queue, messageId: message.$id, attempt, result });
            } catch (error) {
                // Only the ack can have lost the claim here; a handler's own
                // 409 is still a job failure and must go through failMessage.
                if (!isLeaseConflict(error)) throw error;
                options.onError?.(error, message);
            }
        } catch (error) {
            if (leaseLost) {
                options.onError?.(error, message);
                return;
            }
            try {
                await queue.failMessage({
                    queue: options.queue,
                    messageId: message.$id,
                    attempt,
                    error: error instanceof Error ? error.message : String(error),
                });
            } catch (failure) {
                options.onError?.(failure, message);
            }
        } finally {
            clearInterval(heartbeat);
        }
    }

    /** Run the next claim after `delay` ms, replacing any claim already planned. */
    function schedule(delay: number): void {
        if (stopped) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void tick();
        }, delay);
    }

    async function tick(): Promise<void> {
        if (stopped || claiming) return;
        claiming = true;
        // A full batch means more may be waiting: claim again right away
        // instead of sleeping for pollInterval.
        let busy = false;
        try {
            const free = concurrency - inflight.size;
            if (free > 0) {
                const { messages } = await queue.claimMessages<T>({ queue: options.queue, count: free, lease });
                // Run these even when stop() was called meanwhile: they are
                // claimed, and stop() waits for them. Dropping them would hold
                // each one until its lease ran out.
                for (const message of messages) {
                    const job = handle(message).finally(() => {
                        inflight.delete(job);
                        // A slot opened: fill it now rather than at the next poll.
                        schedule(0);
                    });
                    inflight.add(job);
                }
                busy = messages.length === free;
            }
        } catch (error) {
            options.onError?.(error);
        } finally {
            claiming = false;
        }
        if (inflight.size >= concurrency) return; // a finishing job schedules the next claim
        schedule(busy ? 0 : pollInterval);
    }

    return {
        start() {
            if (!stopped && timer === null && !claiming) void tick();
        },
        async stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
            // Let a claim that is already in flight finish before draining.
            while (claiming) await new Promise((resolve) => setTimeout(resolve, 10));
            await Promise.allSettled([...inflight]);
        },
        get running() {
            return inflight.size;
        },
    };
}
