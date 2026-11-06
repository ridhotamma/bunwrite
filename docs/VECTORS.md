# Vectors and RAG

Bunwrite includes a small vector store and a retrieval-augmented generation
(RAG) endpoint. It is a Bunwrite extension, not part of the Appwrite API.

The design goal is the same as the rest of Bunwrite: **no second service and no
native database extension.** Points live in two ordinary tables, so the same
code runs on SQLite and Postgres:

- `_vector_collections` — collection ID, name, dimension, metric, embedder.
- `_vector_points` — one vector, its text and metadata, grouped by collection and
  optional document.

Search ranks a bounded set of points in the Bun process. That is a brute-force
scan, which is predictable and fast enough for a small knowledge base (tens of
thousands of chunks). It is not an HNSW/IVF index; for millions of vectors use a
dedicated vector database.

## Embeddings

By default Bunwrite uses a **local, deterministic embedder**. It lower-cases
text, extracts words and word bigrams, hashes them into signed buckets and
normalises the result. It is lexical rather than semantic, but it needs no API
key, no model download and no network, and it keeps the feature lightweight.

Set an embedding endpoint in **Console → Settings → Vectors & RAG** to use a
model instead. Any OpenAI-compatible `/embeddings` API works (OpenAI, a
gateway, Ollama, LocalAI, ...). The URL may be a base URL (`.../v1`) or the
complete endpoint (`.../v1/embeddings`). The API key is stored with the project
settings, not in `.env`.

A collection records the embedder name that created it. If you change the model
or dimension later, **re-index the collection**; Bunwrite refuses to mix vectors
from different embedders rather than returning quietly wrong results.

## Console

Open **Vectors** in the project sidebar. It has:

- **Collections** — list, create and delete vector collections, with their
  dimension, metric, embedder and point count.
- **Points** — browse and search, add a text point or an explicit vector, open a
  point to see its content and metadata, and delete it.
- **RAG** — paste text to chunk/embed a document, see ingested documents, ask a
  question, and review the generated answer, sources and context.
- **Settings** — inspect the collection's fixed facts, open the project's
  Vectors & RAG settings, and delete the collection.

Embedding, answer generation, ingest defaults and limits are edited in
**Settings → Vectors & RAG** and stored in the project database, so no restart
or `.env` edit is needed. The console calls the same `VectorService` as the API,
so anything visible there is stored in the project's normal SQLite or Postgres
database.

## Configuration

Everything is edited in **Console → Settings → Vectors & RAG** and stored in
the project database. There are no environment variables for these settings.
The built-in defaults are:

| Setting | Default | Meaning |
| --- | --- | --- |
| Embedder | `local` | Local deterministic embeddings; switch to `http` for an OpenAI-compatible endpoint. |
| Embedding URL | unset | OpenAI-compatible base URL or full endpoint. |
| Embedding model | `text-embedding-3-small` | Model name sent to the provider. |
| Dimension | `384` local, `1536` HTTP | Vector width. Must match the model. |
| Send dimensions | off | Send `dimensions` in the request (OpenAI v3 models); leave off for gateways that reject unknown fields. |
| Embedding batch size | `64` | Texts per embeddings request (1–256). |
| Request timeout | `30000` ms | Outbound embeddings/chat timeout. |
| Maximum points | `50000` | Maximum points per collection. |
| Chat URL | unset | OpenAI-compatible chat completions endpoint; empty means no generated answer. |
| Chat model | `gpt-4o-mini` | Chat model name. |
| System prompt | built in | System prompt for generated answers. |
| Temperature | `0.2` | Chat temperature (0–2). |
| Maximum answer tokens | `800` | Maximum generated answer length. |
| Context characters | `12000` | Retrieved context sent to the chat model. |
| Chunk size | `1000` | Default characters per ingested chunk (64–8000). |
| Chunk overlap | `200` | Default overlap between chunks. |

## HTTP API

All routes are under `/v1`, need an API key, and are available on SQLite and
Postgres. Scopes:

- `vectorsdb.collections.read` / `vectorsdb.collections.write`
- `vectorsdb.documents.read` / `vectorsdb.documents.write`

A key without scopes (legacy keys) has full access.

### Collections

```bash
# Create (dimension defaults to the configured embedding dimension)
curl -X POST "$API/vectors" \
  -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"collectionId":"handbook","name":"Handbook","metric":"cosine"}'

# List / read / delete
curl "$API/vectors" -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY"
curl "$API/vectors/handbook" -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY"
curl -X DELETE "$API/vectors/handbook" -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY"
```

Metrics are `cosine` (default), `dot` and `euclidean`. Search scores are always
"higher is better": cosine similarity, the raw dot product, and
`1 / (1 + euclideanDistance)`.

### Points

A point may carry `content` (embedded by the configured provider) or an explicit
`vector` (for vectors made elsewhere). Upserting the same point ID updates it.

```bash
curl -X POST "$API/vectors/handbook/points" \
  -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{
    "points": [
      {"id":"p1","content":"SQLite stores everything in one file.","metadata":{"topic":"storage"}},
      {"id":"p2","vector":[0.1,0.2,0.3],"metadata":{"topic":"custom"}}
    ]
  }'

curl -X POST "$API/vectors/handbook/search" \
  -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"text":"where is data stored?","topK":5,"filter":{"topic":"storage"}}'
```

`filter` compares metadata fields for equality. A value may be an array (matches
any item) and a key may be a dotted path (`{"author.role":"admin"}`).

List, read and delete points:

```bash
curl "$API/vectors/handbook/points?limit=25&documentId=guide" ...
curl "$API/vectors/handbook/points/p1" ...
curl -X DELETE "$API/vectors/handbook/points/p1" ...
```

### RAG ingest

`POST /rag/ingest` splits text on word boundaries, embeds each chunk and stores
it in the collection. Re-ingesting the same `documentId` replaces its chunks.

```bash
curl -X POST "$API/rag/ingest" \
  -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{
    "collectionId":"handbook",
    "documentId":"guide",
    "text":"Paste the document text here...",
    "metadata":{"source":"guide.md"},
    "chunkSize":1000,
    "chunkOverlap":200
  }'
```

Response: `{ "collectionId", "documentId", "chunks", "$createdAt" }`.

### RAG query

`POST /rag/query` retrieves the top chunks. If a chat URL is configured in the
console, it also asks the model to answer with the
context. Without a chat provider, `answer` is `null`; use `context` and `sources`
with your own model.

```bash
curl -X POST "$API/rag/query" \
  -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"collectionId":"handbook","query":"Where is data stored?","topK":5}'
```

```json
{
  "query": "Where is data stored?",
  "answer": "SQLite stores everything in one file [1].",
  "context": "[1]SQLite stores everything in one file.",
  "sources": [
    {"$id":"guide.0","documentId":"guide","chunkIndex":0,"score":0.82,"content":"...","metadata":{}}
  ],
  "model": "gpt-4o-mini"
}
```

Set `"generate": false` to skip the chat call even when a provider is
configured.

Document routes:

```bash
curl "$API/vectors/handbook/documents/guide" ...        # chunks of one document
curl -X DELETE "$API/vectors/handbook/documents/guide" ...  # delete its chunks
```

## SDK

The Bunwrite SDK exposes the same API as `Vectors` and `RAG`:

```ts
import { Client, RAG, Vectors } from '@bunwrite/sdk'

const client = new Client()
  .setEndpoint('https://api.example.com/v1')
  .setProject('my-project')
  .setKey(process.env.BUNWRITE_KEY!)

const vectors = new Vectors(client)
await vectors.createCollection({ collectionId: 'handbook', name: 'Handbook', dimension: 384 })
await vectors.upsertPoints({
  collectionId: 'handbook',
  points: [{ id: 'intro', content: 'Bunwrite runs on Bun.' }],
})
const matches = await vectors.search({ collectionId: 'handbook', text: 'what does it run on?', topK: 5 })

const rag = new RAG(client)
await rag.ingest({ collectionId: 'handbook', documentId: 'guide', text: 'Long document text...' })
const result = await rag.query({ collectionId: 'handbook', query: 'What does it run on?', generate: false })
```

The `bunwrite vectors ...` and `bunwrite rag ...` CLI commands call the same
methods. The MCP catalog includes `vectors_*` and `rag_*` operations.

## Limits and operations

- Search scans every point in the collection in pages and keeps only the best
  `topK` in memory. The point cap in **Settings → Vectors & RAG** (default
  50,000) keeps the scan bounded. For larger corpora, lower the cap or use a
  dedicated vector database.
- Vectors are stored as JSON text. A 384-dimension vector is a few kilobytes;
  the default local embedder keeps collections small.
- Writes are transactional. Ingest embeds first, then replaces a document's
  points in one transaction, so a failed provider call never leaves half a
  document behind.
- There is no background re-index job. Change the embedder/model, then ingest
  the documents again.
- The feature is deliberately not an Appwrite VectorsDB implementation. It is a
  separate `/vectors` and `/rag` extension, like `/queue` and `/pdf`; the SDK
  exposes it as `Vectors` and `RAG`.
