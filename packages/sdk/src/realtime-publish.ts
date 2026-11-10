import type { Client } from './client'

export interface PublishRealtimeEventParams {
    /** `custom.*` channels, for example `custom.team.ops`. */
    channels: string[]
    /** A JSON object (or array) delivered as `event.payload`. */
    payload: Record<string, unknown> | unknown[]
    /** Event names delivered as `event.events`. Defaults to the channels. */
    events?: string[]
}

export interface PublishRealtimeEventResult {
    channels: string[]
    events: string[]
    timestamp: string
    /** Replay sequence; absent when history is disabled. */
    seq?: number
}

/**
 * Publish a server-side custom realtime event.
 *
 * Requires an API key with the `realtime.write` scope. Browsers and ordinary
 * user sessions cannot publish custom events; use this on your server or in a
 * function.
 *
 * Bunwrite extension: `POST /v1/realtime/publish`.
 */
export async function publishRealtimeEvent(
    client: Client,
    params: PublishRealtimeEventParams,
): Promise<PublishRealtimeEventResult> {
    const endpoint = client.config.endpoint.replace(/\/+$/, '')
    return (await client.call(
        'POST',
        new URL(`${endpoint}/realtime/publish`),
        { 'content-type': 'application/json' },
        { channels: params.channels, events: params.events, payload: params.payload },
    )) as PublishRealtimeEventResult
}

export interface ListRealtimeEventsParams {
    channels?: string[]
    /** Return events with a sequence greater than this one. */
    after?: number
    /** 1–500, default 100. */
    limit?: number
}

export interface RealtimeEventRecord {
    seq: number
    channels: string[]
    events: string[]
    payload: unknown
    timestamp: string
}

export interface ListRealtimeEventsResult {
    total: number
    events: RealtimeEventRecord[]
    next: number
}

/**
 * Replay custom events kept by the server. The caller only sees channels its
 * roles may subscribe to; API keys need the `realtime.read` scope.
 *
 * Bunwrite extension: `GET /v1/realtime/events`.
 */
export async function listRealtimeEvents(
    client: Client,
    params: ListRealtimeEventsParams = {},
): Promise<ListRealtimeEventsResult> {
    const endpoint = client.config.endpoint.replace(/\/+$/, '')
    const query: Record<string, unknown> = {}
    if (params.channels?.length) query.channels = params.channels
    if (params.after !== undefined) query.after = params.after
    if (params.limit !== undefined) query.limit = params.limit
    return (await client.call('GET', new URL(`${endpoint}/realtime/events`), {}, query)) as ListRealtimeEventsResult
}
