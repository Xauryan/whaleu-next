# Community semantic search: exact baseline and activation gates

## Implemented boundary

The existing `GET /v1/community/search` remains literal Unicode substring search
with newest-first navigation and its unchanged strict response/cursors.
`GET /v1/community/search/semantic` is a separate, default-disabled endpoint.
It accepts the same scope, type, date, discussion and category filters, but rejects
`cursor`. Its successful response is exactly:

```json
{
  "mode": "semantic",
  "indexStatus": "current",
  "ranking": "embedding-top32-reranked",
  "items": []
}
```

The array contains at most `limit` (1–10) current lightweight search hits. It has
no total, next cursor, continuation, provider diagnostics or raw scores. The
ranking label means exact embedding retrieval over the current allowed scope,
then reranking the first **32** embedding candidates. It does not mean global
reranker scoring of every document. Plain-text snippets only highlight actual
literal substrings; a semantic match may have all `matched:false` segments.
Guests receive post search; explicit comment/reply requests require a session.
The native search page exposes keyword/semantic selection without silently
falling back between engines or inventing semantic pagination.

Disabled returns HTTP 503 `SEMANTIC_SEARCH_DISABLED`. Missing current index
coverage, unknown canonical authority, a changed ranking snapshot, failed
proofs, provider errors and operational limits fail unavailable, not a successful
empty array. A successful empty array means the currently proved eligible text
set is empty. Invalid supplied credentials never become guest access.

## Models, gateway and index space

The configured pair is `Qwen/Qwen3-Embedding-8B` with **4096** dimensions and
`Qwen/Qwen3-Reranker-8B`. No silent dimensional reduction or claim of leaderboard
quality at a different dimension is made. These model choices are not a measured
winner on WhaleU queries.

The user-selected transport is fixed to `https://router.tumuer.me`, with only
`/v1/embeddings` and `/v1/rerank`. Its official
[embedding](https://embedding-docs.tumuer.me/api/embeddings) and
[reranking](https://embedding-docs.tumuer.me/api/rerank) protocols were read;
**no real inference request or credential was used for implementation/testing**.
The separately tested SiliconFlow adapter is not a fallback, and Tumuer profiles
or credentials cannot be routed there. Both adapters reject redirects and
unapproved origins, bound response sizes and timeouts, redact failures, and do
not automatically retry a potentially billable request. HTTP 429 is not retried.

A validated immutable profile hashes provider/deployment identity, pinned model
revision labels, model ID, dimension, query instruction, preprocessing and
normalization into `indexSpaceKey`. The reranker revision also binds the broader
profile identity. Changing embedding settings creates a separate index space;
old vectors cannot silently mix with the new query vector. Queries use the Qwen
instruction prefix; documents contain only their own canonical text. Provider
responses validate model where supplied, batch cardinality, unique indices,
4096 finite nonzero values and exact document identities. Normalization is
numerically bounded. Reranker logits need not be probabilities.

Hosted responses expose model aliases, not immutable weight-revision
attestations. Revision labels must be verified and maintained operationally;
a label in configuration does not prove remote weights are pinned. Index rebuild
and comparison are required when the actual embedding deployment changes.

## Authorization before distance and before transmission

1. Metadata-only actor/scope preflight completes before query embedding. HTTP
   also uses the official Nest throttler with the existing PostgreSQL storage:
   10 attempts/minute per account across sessions, or per guest address.
2. A short read-committed transaction captures required community, Safety and
   Campus owner epochs. The content-review owner resolves the whole structural
   scope through no-body certificates and current lifecycle/review metadata.
3. The coordinator preserves scalar order: post base → post Safety → root base
   → root Safety → reply base → reply Safety. Post hits use `list_projection`;
   a child requires parent `direct_post`. Anonymous/self/guest bypass applies
   only to the particular node. Named list checks retain the existing
   viewer-head rule; direct checks require both heads. Relevant unknown facts
   fail closed. Deadlines include consulted denied facts too.
4. An allowed relation is materialized **before** joining or ranking vectors.
   Every allowed searchable source must have a current exact-profile vector.
   Missing vectors for denied sources cannot alter the rank window or coverage.
   Known non-text sources use a canonical `has_searchable_text` certificate.
5. PostgreSQL computes full-4096 cosine distances, returning at most 128 metadata
   candidates. Only those enter the existing parent → root → reply ordered
   locks, canonical source/approval/Safety reads and public projection budget.
   No corpus vectors are loaded into JavaScript.
6. The committed result gives the reranker only authorized candidate text, the
   query and local ordinal IDs. No source UUIDs, contacts, parent body context,
   full review envelope or target-reply identity is included. Model calls occur
   **between transactions**, with no source locks retained across network waits.
7. A second independent transaction reevaluates the entire eligibility/revision
   fingerprint and exact ranked slate, not just returned hits. Any change
   invalidates the whole response. Fresh canonical reads produce final snippets;
   provider-returned text is never rendered. Required epoch fences, current
   sessions, relationship checks and deadlines remain mandatory through commit.

Canonical per-source body validation is performed at certificate creation, not
repeated for every corpus row on every query. Query-time metadata checks reuse
the owner approval validator rather than duplicating its semantics as loose SQL
flags. A certificate or vector is never itself permission to read a source.

## Source lifecycle and explicit backfill

The optional schema stores embeddings, no-body certificates and source-owned
incarnation UUIDs. A source transition advances its own token; ancestor tokens
and monotonic review-head event IDs are included in every descendant revision.
Hide/restore and revoke/restore cycles cannot revive stale embedding work even
when the text is unchanged. Index queries compare the whole current chain.
There is no source-trigger cascade locking descendant vectors. Physical cleanup
of logically stale derived records is a remaining retention task.

Direct insertion/update/deletion/truncation of incarnation metadata is rejected.
Certificate creation requires committed canonical source facts. Definition
TRUNCATE is blocked while the optional schema is installed: a query's temporary
epoch alone cannot invalidate a persistent certificate after such maintenance.
Normal immutable-definition guards remain in force. Derived-table mutations
participate in the existing community epoch protocol.

`SemanticSearchEngine.indexSources(token, query, [{kind,id}, ...])` is an explicit
bounded actor-authorized indexing operation (maximum 128 sources per batch).
It reads source snapshots in one transaction, embeds authorized nonempty bodies
outside a transaction, then independently reauthorizes and compares exact
revisions before certificate/vector writes. Unknown evidence fails; known review
denial can receive a no-body denial certificate without model input or a vector.
A swallowed certificate or vector write fails the transaction, including its
other derived writes. This is not an unrestricted background service identity.

`indexNextSemanticBatch(searches, engine, token, query, checkpoint)` provides
structural enumeration and a resumable scope-bound checkpoint. It never uses
body matches or vector values for enumeration. The caller must explicitly run
and retain checkpoints; no automatic scheduler, history import or production
backfill is enabled. Repeating a batch is safe through current-revision upserts.
The end of enumeration is **not** a coverage certificate: intervening insertions,
permission changes and revisions require reconciliation. Search itself verifies
complete current allowed-set coverage and fails unavailable when it is absent.

## Optional local installation and configuration

Ordinary migrations, PostgreSQL-only CI, and disabled runtime do not require
pgvector. The optional installer requires all current base migrations, a local
`whaleu_test` or `whaleu_dev` database, PostgreSQL 18.6+ 18.x and pgvector 0.8.7
in `public`. It uses the migration lock, validates base history, installs in one
transaction and records a checksum. Partial failure rolls back. A mismatched
existing extension namespace/version or optional checksum is rejected.

```sh
npm run search:install-local -w @whaleu/api
npm run test:semantic:integration -w @whaleu/api
```

The second command requires `TEST_DATABASE_URL` naming a disposable loopback
`whaleu_test`. It is a distinct required optional-feature test gate, not a skipped
part of the ordinary PostgreSQL suite. The suite does not drop an extension it
did not create. The default Compose PostgreSQL image has no extension installed;
use an explicitly reviewed pgvector-capable local environment for this gate.

Defaults remain:

```text
COMMUNITY_SEMANTIC_SEARCH=disabled
COMMUNITY_SEMANTIC_TRANSMISSION=disabled
COMMUNITY_SEMANTIC_TIMEOUT_MS=5000
```

Enabling the runtime requires `COMMUNITY_SEMANTIC_SEARCH=enabled`, a separately
approved transmission setting `COMMUNITY_SEMANTIC_TRANSMISSION=approved`, and
non-floating deployment, embedding and reranker revision labels in the three
`COMMUNITY_SEMANTIC_*_REVISION` settings. The Tumuer key is resolved lazily from
`WHALEU_TUMUER_SEMANTIC_API_KEY`; it is not a repository config value or log field.
Install capability, reconcile index coverage, confirm data-sharing/cost authority
and verify the actual hosted deployment before enabling these settings. Writing
adapter support does not authorize or imply those operational actions.

## Performance and acceptance limits

The baseline uses mature pgvector exact distance operations. Full 4096 vectors
are supported for storage; direct HNSW `vector` indexes support at most 2000
and `halfvec` at most 4000. Therefore this implementation does **not** pretend to
have a full-4096 HNSW index. Binary quantization with full-vector reranking is a
possible future measured approximation, but a shared ANN graph can let denied
vectors affect another viewer's recall. It is not enabled here. See the official
[pgvector documentation](https://github.com/pgvector/pgvector).

Exact distance work is O(allowed vectors × 4096), plus O(scope metadata)
canonical eligibility work. The metadata operational ceiling is 100,000 rows;
exhaustion/timeouts fail unavailable. That ceiling is not a claim of acceptable
100k-corpus production latency. The database still needs CPU, memory and storage
although hosted models remove the need to self-host inference GPUs.

Current focused real-PG tests prove batch backfill and retrieval beyond 128
sources, oldest-source and reply retrieval, pre-rank Safety exclusion, missing
coverage, current source/review incarnations, entire-slate invalidation, final
canonical proof, no source locks during model waits, strict HTTP behavior and
shared request budgets. All model outputs in these tests are deterministic
synthetic fixtures. They demonstrate wiring/correctness, **not** Chinese semantic
quality, hosted availability, real latency/cost or a Qwen/Voyage/Cohere winner.
The 140-source correctness fixture is not a large-scale performance benchmark.
See [offline evaluation protocol](search-evaluation.md). Production-size
benchmarks, real-provider acceptance, physical derived-data retention and actual
native-device acceptance remain release gates.
