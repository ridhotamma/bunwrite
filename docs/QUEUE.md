# Job queue: durable background work for SDK workers

The built-in queue runs long jobs **in your own process**, outside the request
that created them. A worker claims a message through the SDK (or plain HTTP),
runs your handler, then acks it. The message, its attempts and its lease live
in SQLite, so a crash retries instead of losing the job.

This is a Bunwrite extension, not part of Appwrite's API. It is opt-in: nothing
runs a queue for you until you start a worker.

## When to use the queue instead of a function

| Use a **function** when | Use the **queue** when |
| --- | --- |
| The job is defined as a deployment (Appwrite-compatible) | The handler lives in your app: your DB pool, env and dependencies |
| It can finish within the function timeout | It may run for minutes or hours |
| You want Appwrite's sync/async execution API | You want retries, leases and backoff without wiring a broker |
| It is a cron task | You have many small jobs and want a concurrency cap |

Async function executions now use the same durable machinery (see
[Functions](#functions) below), so use them when you want a deployable job and
the queue when you want the handler next to your app code.

## Enqueue

```bash
curl -X POST https://api.example.com/v1/queue/emails/messages \
  -H "X-Bunwrite-Project: $PROJECT_ID" \
  -H "X-Bunwrite-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"data": {"to": "ada@example.com"}, "idempotencyKey": "welcome-ada"}'
```

| Field | Meaning |
| --- | --- |
| `data` | Any JSON value. Stored as text and returned parsed. |
| `id` | Message ID (Appwrite-style IDs); omitted for a unique one. |
| `delay` | Seconds before it can be claimed (max 604800). |
| `maxAttempts` | 1 to 100, default 3, before it stays `failed`. |
| `idempotencyKey` | Unique per queue. Enqueueing the same key returns the first message (HTTP 200 instead of 201). |

The response is the message:

```json
{
  "$id": "68f...",
  "queue": "emails",
  "status": "waiting",
  "attempts": 0,
  "maxAttempts": 3,
  "availableAt": "2026-10-29T00:00:00.000+00:00",
  "leaseUntil": null,
  "idempotencyKey": "welcome-ada",
  "data": { "to": "ada@example.com" },
  "result": "",
  "errors": ""
}
```

## Run a worker

```ts
import { Client, createQueueWorker } from '@bunwrite/sdk'

const client = new Client()
  .setEndpoint('https://api.example.com/v1')
  .setProject(process.env.PROJECT_ID!)
  .setKey(process.env.API_KEY!)

const worker = createQueueWorker<{ to: string }>(client, {
  queue: 'emails',
  concurrency: 4,
  lease: 60,          // seconds; heartbeated at half
  pollInterval: 1000, // ms between empty claims
  handler: async (message, { signal }) => {
    await sendEmail(message.data.to, { signal })
    return { delivered: true } // stored as message.result
  },
})

worker.start()

// On SIGTERM/SIGINT, stop claiming and let in-flight handlers finish.
process.on('SIGTERM', async () => {
  await worker.stop()
  process.exit(0)
})
```

Throwing (or rejecting) fails the message. It is retried with exponential
backoff until `maxAttempts`, then stays `failed` with `errors` set.

The worker claims again as soon as a handler finishes or a full batch comes
back, so `pollInterval` only applies while the queue is empty. Messages
claimed just before `stop()` still run; `stop()` waits for them.

### Without the worker helper

`Queue` exposes the primitives, so any language or process can be a worker:

```ts
import { Queue } from '@bunwrite/sdk'
const queue = new Queue(client)

const { messages } = await queue.claimMessages({ queue: 'emails', count: 10, lease: 60 })
for (const message of messages) {
  try {
    const result = await sendEmail(message.data.to)
    await queue.ackMessage({ queue: 'emails', messageId: message.$id, result })
  } catch (error) {
    await queue.failMessage({ queue: 'emails', messageId: message.$id, error: String(error) })
  }
}
```

## Endpoints

All of them need an API key. The queue is for servers, not browsers.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/queue/:queue/messages` | Enqueue |
| `POST` | `/v1/queue/:queue/claim` | Claim 1–100 messages (`count`, `lease`) |
| `POST` | `/v1/queue/:queue/messages/:id/ack` | Complete (`result`) |
| `POST` | `/v1/queue/:queue/messages/:id/fail` | Fail (`error`, `delay`) |
| `POST` | `/v1/queue/:queue/messages/:id/heartbeat` | Extend the lease (`lease`) |
| `GET` | `/v1/queue/:queue/messages` | List (`queries`, `status`) |
| `GET` | `/v1/queue/:queue/messages/:id` | Read one |
| `DELETE` | `/v1/queue/:queue/messages/:id` | Delete one |
| `GET` | `/v1/queue/:queue/stats` | Counts by status |
| `DELETE` | `/v1/queue/:queue` | Purge (`status`; everything without it) |

## Semantics

- **At-least-once.** A claim moves the message to `processing` and increments
  `attempts`. If the worker dies, the lease expires and the message is
  delivered again. Make handlers idempotent.
- **Leases.** A claim lasts `lease` seconds (default 60). The SDK worker
  heartbeats at half of it. `409 queue_message_conflict` means the lease was
  lost; do not ack.
- **Ordering.** Messages are claimed oldest-first, but with `concurrency > 1`
  handlers finish out of order.
- **Retention.** Completed and failed messages are pruned after 30 days, like
  execution history. A message you never ack is retried, not pruned.
- **System queues.** Names starting with `_` (such as `_render`, used by
  [async HTML rendering](RENDER.md)) belong to Bunwrite and are not reachable
  from these endpoints.
- **Payload size.** Bounded by the server's request body limit, like any JSON
  request. Keep jobs small and put large blobs in storage.

## Functions

Async and scheduled function executions use the same durable model. The
relevant settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FUNCTIONS_CONCURRENCY` | `4` | Runs executing at once per project. Others wait as `waiting`. |
| `FUNCTIONS_MAX_ATTEMPTS` | `1` | Attempts a failed async run gets. `1` keeps Appwrite's behaviour: no retry. |

A run that is still `processing` when the server restarts is returned to the
queue after its lease expires (or immediately at startup, if the lease already
passed), and a run out of attempts is marked `failed` with a message saying it
was interrupted.
