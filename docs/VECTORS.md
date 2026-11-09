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
  point to see its content and metadata, and delete it. Search uses hybrid
  retrieval and reranking by default.
- **RAG** — upload a PDF, Markdown, HTML, DOCX, ODT, EPUB, RTF, JSON,
  CSV, XML, YAML or text file (or paste text) to chunk/embed a document, see
  ingested documents, ask a question, and review the generated answer, sources
  and context.
- **Settings** — inspect the collection's fixed facts, open the project's
  Vectors & RAG settings for hybrid search, reranking, embeddings, answers and
  limits, and delete the collection.

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
| System prompt | grounded | Requires answers to come from context, forbids inferring safety/eligibility/prices from missing information, and points medical, legal and financial questions to a qualified professional. |
| Temperature | `0.2` | Chat temperature (0–2). |
| Maximum answer tokens | `800` | Maximum generated answer length. |
| Context characters | `12000` | Retrieved context sent to the chat model. |
| Hybrid search | on | Fuse lexical BM25 with vector similarity for text queries. |
| Vector weight | `0.55` | Share of the hybrid score from vector similarity; lexical gets the rest. |
| Rerank | on | Reorder the best hybrid candidates before returning the final top-k. |
| Rerank endpoint | unset | Cohere/Jina-compatible rerank URL; empty uses the local lexical reranker. |
| Rerank candidates | `0` | Candidate pool passed to the reranker; 0 derives it from top-k. |
| PII redaction | off | Replace emails, phones, cards, NIK, SSN and IBAN before context reaches the chat model. |
| Prompt-injection guard | on | Mark context as untrusted and report suspicious sources. |
| Audit retrieval | off | Store query, answer, sources, redaction and injection metadata. |
| Multi-hop planning | off | Use the chat model to split a question into multiple retrieval queries. |
| Planned queries | `3` | Maximum queries, including the original question. |
| Chunk size | `1000` | Default characters per ingested chunk (64–8000). |
| Chunk overlap | `200` | Default overlap between chunks. |

The default prompt is a grounding baseline, not a compliance control. For
medical, legal, financial or other high-stakes workflows, write the domain
policy into the source documents, keep a human in the loop, and evaluate the
answers against a reviewed question set before production use.

## Hybrid search and reranking

Text queries use two signals by default:

1. **Vector similarity** from the configured embedder.
2. **BM25 lexical relevance** over the chunk text.

The scores are normalised within the candidate pool and fused with the
configured vector weight. This catches exact names, product codes, prices and
rare terms that a semantic model can miss, while the vector side handles
paraphrases and intent.

A **reranker** then reorders the best candidates. With no rerank endpoint
configured, Bunwrite uses a deterministic local reranker that rewards exact
phrases, query-term coverage, adjacent query terms and repeated matches. For a
neural cross-encoder, configure a Cohere/Jina-compatible endpoint; the service
falls back to the local reranker if that provider fails.

Every search accepts per-request overrides:

```json
{
  "text": "3 bedroom house in Kemang with a pool",
  "topK": 5,
  "hybrid": true,
  "rerank": true,
  "alpha": 0.55
}
```

Set `hybrid` to `false` for vector-only retrieval, `rerank` to `false` to keep
the fused order, or `alpha` to `0`/`1` for pure lexical/vector ranking. Hybrid
search makes one extra statistics pass over the filtered collection; the
default point cap keeps that predictable.

### Multi-hop query planning

When **Plan multi-hop queries** is enabled, `/rag/query` asks the configured
chat model for up to five standalone search queries, runs them, and fuses the
results with reciprocal-rank fusion before generating the answer. The original
question is always included. The response includes `plannedQueries` when
planning was used. This costs one extra chat call per question and requires
`generate: true`.

### Retrieval guardrails

- **PII redaction** replaces emails, phone numbers, card numbers, NIK, SSN and
  IBAN in the context before it reaches the chat model. Returned sources remain
  the authorized originals.
- **Prompt-injection guard** tells the model that retrieved context is untrusted
  and reports source documents containing instruction-like text in
  `security.suspiciousSources`. It does not modify the source content.
- **Audit retrieval** stores the query, answer, source IDs, security metadata
  and latency in `_vector_audit_logs`. Read or clear it with:

```bash
curl "$API/vectors/handbook/audit?limit=50" ...
curl -X DELETE "$API/vectors/handbook/audit" ...
```

The default prompt is a grounding baseline, not a compliance control. For
high-stakes workflows, combine it with reviewed source policy, human review and
audit retention.

## RAG evaluation

`POST /rag/evaluate` runs a golden question set and returns standard retrieval
and answer metrics:

- **recall@k** — how many expected documents appeared in the top-k
- **MRR** — reciprocal rank of the first expected document
- **nDCG@k** — ranking quality with binary relevance
- **keyword coverage** — expected facts present in context or answer
- **refusal accuracy** — out-of-scope questions correctly refused
- **latency** — per case and average

Example:

```bash
curl -X POST "$API/rag/evaluate" \
  -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{
    "collectionId":"handbook",
    "topK":5,
    "generate":false,
    "cases":[
      {"id":"deploy","query":"How do I deploy?","expectedDocuments":["deploy"],"expectedKeywords":["docker"]},
      {"id":"homes","query":"Which house has a pool?","expectedDocuments":["casa-blanca"]}
    ]
  }'
```

`generate:true` also checks answer keyword coverage and refusal behavior. Refusal
cases require `generate:true` and a configured chat model:

```json
{
  "collectionId":"handbook",
  "generate":true,
  "cases":[
    {"id":"outside","query":"Do you sell cars?","expectRefusal":true}
  ]
}
```

`expectRefusal` is matched against English and Indonesian refusal language; use
`expectedKeywords` for domain-specific phrasings.

Evaluation runs are saving by default. Set `"save": false` for an ad-hoc run.
Pass `"baselineId": "<run-id>"` to compare against an earlier run in the same
collection; the response includes a `regression` object with metric deltas and
failed checks. Add `"failOnRegression": true` when the runner should treat a
regression as a failure.

```bash
curl "$API/rag/evaluations?collectionId=handbook" ...
curl "$API/rag/evaluations/<run-id>" ...
curl -X DELETE "$API/rag/evaluations/<run-id>" ...
```

The console's **Evaluation** tab runs a pasted golden set, shows the metrics,
lists saved runs, opens a previous run, and lets you delete runs.

The repository includes a CI-friendly runner:

```bash
BUNWRITE_ENDPOINT=http://localhost:8080/v1 \
BUNWRITE_PROJECT=my-project \
BUNWRITE_KEY=standard_... \
bun run rag:eval --dataset ./rag-eval.json
```

Use `--json` for machine-readable output. The command exits non-zero when any
case fails, so it can gate a deployment. The dataset format is the same object
accepted by `/rag/evaluate`.

Retrieval metrics are not a substitute for human review. For high-stakes
answers, keep a reviewed golden set, version the source corpus, and compare
hybrid/rerank settings before changing models.

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

### Point and document permissions

Every point can carry Appwrite-style permissions. Ingest applies them to every
chunk of a document:

```json
{
  "collectionId": "handbook",
  "documentId": "hr-policy",
  "text": "Internal HR policy...",
  "permissions": ["read(\"users\")", "read(\"team:hr\")"]
}
```

`POST /vectors/:collectionId/points` accepts the same `permissions` field.
API keys and console admins bypass point ACLs. A signed-in user can read only
points where a `read(...)` grant matches their roles (`users`, `user:<id>`,
`team:<id>`, `team:<id>/<role>`, `label:<name>`, `member:<membershipId>`).

This is the tenant-isolation primitive:

- Keep each tenant in its own project, or
- use `read("team:<tenantId>")` and make users members of that team.

Search, point lists, document lists, `/rag/query` and `/rag/evaluate` all
filter before anything is scored or returned. Ingestion and writes remain
API-key-only; the application backend is expected to attach permissions when it
indexes documents.

```bash
# API key: sees everything
curl -X POST "$API/vectors/handbook/search" ...

# User session: only points whose read ACL matches the user's roles
curl -X POST "$API/vectors/handbook/search" \
  -H "x-appwrite-project: $PROJECT" \
  -H "x-appwrite-session: $USER_SESSION" ...
```

### RAG ingest

`POST /rag/ingest` accepts JSON text, a multipart `file`, or a raw request body.
It splits the text on word boundaries, embeds each chunk and stores it in the
collection. Re-ingesting the same `documentId` replaces its chunks.

```bash
# Text in JSON
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

# A file: PDF, Markdown, HTML, DOCX, ODT, EPUB, RTF, JSON, CSV, XML, YAML or text
curl -X POST "$API/rag/ingest" \
  -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY" \
  -F collectionId=handbook \
  -F file=@handbook.pdf \
  -F metadata='{"source":"handbook.pdf"}'

# A raw body with the collection and file name in the query
curl -X POST "$API/rag/ingest?collectionId=handbook&filename=notes.md" \
  -H "x-appwrite-project: $PROJECT" -H "x-appwrite-key: $KEY" \
  -H 'content-type: text/markdown' \
  --data-binary @notes.md
```

Response:

```json
{
  "collectionId": "handbook",
  "documentId": "handbook",
  "chunks": 12,
  "characters": 11480,
  "format": "pdf",
  "pages": 8,
  "$createdAt": "2026-01-01T00:00:00.000+00:00"
}
```

When no `documentId` is given for a file, it is derived from the file name, so
uploading `handbook.pdf` again replaces the previous `handbook` document. File
metadata (`source`, `filename`, `mimeType`, `format`, `size`, and `pages` for
PDFs) is stored with each chunk unless the request's `metadata` overrides it.
Uploads are limited to 25 MB and PDFs to 1000 pages. A scanned PDF without a
text layer is refused; run OCR first.

The document routes are equivalent and make CRUD clearer:

```bash
curl "$API/vectors/handbook/documents" ...                     # list documents
curl -X POST "$API/vectors/handbook/documents" -F file=@guide.md ...  # ingest/upload
curl -X PUT "$API/vectors/handbook/documents/guide" -F file=@guide.md ...  # replace
curl "$API/vectors/handbook/documents/guide" ...               # chunks of one document
curl -X DELETE "$API/vectors/handbook/documents/guide" ...     # delete its chunks
```

Markdown ingestion is heading-aware: each chunk records a `section` metadata
path such as `Handbook / Deploy`, and the heading path is included in the text
sent to the embedder. This keeps section context after a long section is split.

After changing the embedder or dimension, re-embed every point in place:

```bash
curl -X POST "$API/vectors/handbook/reindex" ...
```

The call is synchronous. For large collections, run it during a maintenance
window or from the console's collection Settings tab.

Ingestion can also be queued:

```bash
curl -X POST "$API/rag/ingest" ... -d '{..., "async":true}'
# 202 {"jobId":"...","status":"waiting","collectionId":"handbook","documentId":"guide"}
curl "$API/rag/jobs/<job-id>" ...
```

The API extracts text synchronously, queues chunking/embedding, and works
through jobs in the leader process. Jobs survive a restart through the durable
queue. The console's **Upload** form always uses synchronous ingestion.

The SDK mirrors this with `RAG.enqueueIngest()` and `RAG.getJob()`.

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
const matches = await vectors.search({ collectionId: 'handbook', text: 'what does it run on?', topK: 5, hybrid: true, rerank: true })

const rag = new RAG(client)
await rag.ingest({ collectionId: 'handbook', documentId: 'guide', text: 'Long document text...' })
const result = await rag.query({ collectionId: 'handbook', query: 'What does it run on?', generate: false })

const evaluation = await rag.evaluate({
  collectionId: 'handbook',
  generate: false,
  topK: 5,
  cases: [{ id: 'runtime', query: 'What does Bunwrite run on?', expectedDocuments: ['guide'], expectedKeywords: ['Bun'] }],
})

// Upload a file and let the server extract, chunk and embed its text.
await vectors.ingestDocument({
  collectionId: 'handbook',
  file: new File([bytes], 'handbook.pdf', { type: 'application/pdf' }),
})
await rag.ingestFile({ collectionId: 'handbook', file: fileFromAnInput })
```

The `bunwrite vectors ...` and `bunwrite rag ...` CLI commands call the same
methods. A file path is accepted too:

```bash
bunwrite vectors ingest-document --collection-id handbook --file ./handbook.pdf
bunwrite rag ingest-file --collection-id handbook --file ./notes.md
```

The MCP catalog includes `vectors_*` and `rag_*` operations.

## Limits and operations

- Search scans every point in the collection in pages and keeps only the best
  `topK` in memory. The point cap in **Settings → Vectors & RAG** (default
  50,000) keeps the scan bounded. Hybrid search makes an extra statistics pass
  for BM25. For larger corpora, lower the cap or use a dedicated vector database.
- Evaluation is synchronous: each case performs its own retrieval and optional
  chat request. Keep golden sets small enough for the request timeout, or run
  them from the CLI where a long-running process is expected.
- User-session reads scan points in memory to enforce point ACLs before
  pagination. API keys and console admins keep the SQL-paged path.
- Async ingestion queues chunking and embedding, but text extraction stays in the
  request so invalid files fail immediately. There is no OCR or PDF table
  extraction yet; scanned PDFs without a text layer are refused and should be
  OCR'd before upload. Re-indexing is synchronous.
- Point ACLs are applied to every chunk created by one ingest. Manually added
  points can have different permissions, but there is no separate document ACL
  object or permission inheritance beyond that.
- The built-in store still uses a bounded scan; an external ANN adapter
  (pgvector, Qdrant, OpenSearch or Vespa) is not implemented yet.
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
