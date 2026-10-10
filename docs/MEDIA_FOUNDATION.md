# Shared Media local synthetic slice and remaining release gates

Baseline: `8de097faf2dc997498f0a235f6a99ec83d5a46dd` (includes C migrations
0066–0069 unchanged). Real synthetic decoding and focused PostgreSQL acceptance
have executed. Combined integrated local acceptance now passed 5,798 tests,
including the N1 authenticated native read bridge. Hosted CI remains pending.
This is a local synthetic Community single-image slice, not
production availability, complete all-owner media, or WeChat device parity.

## Written code

- Additive 0070–0072 schemas: private intents/reservations, exact original and
  derivative effect destinations, immutable manifests/variants, monotonic safety
  events/heads, draft-to-parent single consumption, bindings, jobs, cleanup and
  128-slot mandatory owner epochs/fences. No live provider or issuer is seeded.
- Strict v1 manifest binds exact locator/version and actual hash/MIME/dimensions/
  size for original, thumb-v1 and display-v1. JPEG/PNG, 5 MiB input, 24 MP, 8192
  edge, fixed 400/2048 variants and no-upscale rules are represented.
- Community issues an immutable server draft scope under current publication
  authority. Client draftId is only a correlation key. Current full publication
  scope is hashed; changed scope requires a new draft. Existing post UUID
  allocation is preserved: scope consumption and Media bindings occur inside the
  original content/Review/receipt/outbox publication transaction.
- Media prepare performs actor-serialized idempotency and quota reservation.
  Lifecycle handles observed finalize, lease/generation/token CAS, cancellation,
  expiry, bounded retries and exact durable cleanup obligations. It never makes
  an asset ready based only on upload progress or a successful network response.
- All Community serializer call sites pass viewer, typed parent and read purpose.
  A versioned authenticated descriptor replaces displayUrl/thumbnailUrl. A typed
  owner capability cannot survive transaction rollback or be reconstructed from
  JSON. Actual Media and business-owner final proofs remain separate.
- Delivery opens the exact object outside transactions, keeps the source paused,
  performs a second current session/owner/asset authorization with final proofs,
  then emits bounded/backpressured bytes. Range/redirect/public URL are absent.
  Headers include private/no-store, Vary Authorization and nosniff. Withdrawal
  stops later authorized requests; already sent bytes cannot be recalled and an
  already authorized in-flight stream is not promised immediate revocation.
- HTTP prepare/status/finalize/cancel/download routes are registered with a
  default application that authenticates and returns MEDIA_UNAVAILABLE. Normal
  AppModule does not wire storage, decoder, synthetic issuer or an enable flag.
  Provider-disabled owner deletion still atomically detaches exact bindings and
  stages pending cleanup; it never claims physical deletion without a provider.
- Test-only wiring opts the real Community/Identity/Safety/Review services into
  an actual local storage/processor flow. It accepts only explicitly registered
  synthetic digests, seals actual immutable bytes, runs sharp, writes actual
  variants and exact synthetic asset Review evidence. Content approval is a
  separate fixture ledger; missing approval remains CONTENT_REVIEW_UNAVAILABLE.
- Synthetic filesystem storage uses a fresh private temporary root, strict
  locators, atomic exclusive writes and exact replay verification. Irrevocable
  process-local writer retirement can prove cleanup quiescence for this adapter;
  it does not prove remote-provider or cross-process quiescence.
- Real sharp processing runs in a child process. The ordinary path requires a
  supported preprovisioned hard resource boundary and defaults unavailable.
  The exact-digest fixture path can test real decoding correctness without
  claiming hostile native-memory containment. sharp 0.35.5 is exactly pinned from
  the official npm registry with its lockfile; no provider SDK was installed.
- Native controller/gateway code includes account+epoch isolation, refresh-aware
  auth, same-key/status-first recovery, cancellation, transient preview cleanup
  and strict descriptor/status decoding. N1 adds authenticated temporary-file
  presentation for ordinary post detail and an official-platform-shaped adapter,
  validated through a synthetic SDK bridge. Real device activation remains off;
  upload transport, other surfaces and other owners remain unavailable.

## Disclosure and proof boundaries

- The exact content Review envelope remains independent of current Media safety.
  A separate leaf ContentMediaProof checks typed bindings, immutable manifest,
  policy/head and validity, and enrolls mandatory final Media proof. It cannot
  mint viewer authority. This avoids an owner/visibility recursion.
- Direct Community reads and ordinary feed candidates consume both business
  visibility and current Media evidence. A valid held/revoked Media decision is
  a known denial: detail not-found, list filtering. Its final proof and expiry
  remain required even when filtering. Missing, expired or mismatched evidence
  is unknown and cannot silently become an empty page.
- Exact aggregate count snapshots remain image-unknown because their existing
  conditional metadata does not carry Media safety revisions. This work does
  not claim image-aware exact counts or discovery-count acceptance.
- Persisted semantic eligibility certificates remain text-only, including
  ancestors. Their existing revision tuple does not bind Media state; ordinary
  current visibility cannot be reused to issue an image-backed certificate.
- Other hot/search/discovery/profile/notification consumers that reach canonical
  visibility and serializers also encounter the default unavailable or current
  Media port. Per-surface nonempty-image behavior is not yet fully accepted.
  In particular, routing through shared code is not evidence that fanout,
  recommendation, counts, or native presentation supports media end to end.
- Historical publication receipt replay records a completed command only. It
  does not reauthorize content, descriptors or bytes after a later denial.

## Validation evidence (2026-10-10)

- sharp 0.35.5 actual bytes: focused API 36/36, native focused 38/38, all zero
  skips/TODOs. JPEG/PNG full decode, all eight orientations, GPS/EXIF/ICC/XMP
  stripping, measured no-upscale dimensions/hashes, APNG/MPO/truncation/MIME,
  pixel/edge limits and actual >5 MiB output expansion rejection executed.
- Official Media OpenAPI generated and drift checked; offline metadata tests
  3/3. The export forbids live PG/network/listen/timer initialization.
- Focused PostgreSQL foundation/pipeline/publication initially 23/23 after
  resolving the legacy content visibility's blanket image prohibition. Genuine
  ordinary AppModule after fixture publication supports authorized DB-only
  deletion with foreign-account rejection, outbox rollback and stable replay.
- Final frozen `npm run check`, `format:check` and `git diff --check` passed:
  API 1374/1374, native 2000/2000, stats 5/5 and eval 20/20, all zero skips/TODOs;
  lint, both typechecks, official OpenAPI checks and both builds passed.
- Final focused PG 23/23 passed after the deny/unknown refinement. Valid held and
  revoked filter the feed and return detail not-found; expired denial remains
  unavailable. A deny-to-allow change after savepoint lock release fails the
  mandatory final proof, and denial expiry fails transaction finalization.
- Cleanup acceptance waited the entire real two-minute retention. Every planned
  exact fixture object was irreversibly retired, deleted and measured absent;
  every obligation had confirmed_deleted_at. Time alone was not quiescence.
- 24 affected PostgreSQL regression files passed 264/264, zero skips/TODOs:
  Community/runtime/client, liked/saved/updates, hot read/proof/native/processing,
  current search metadata, discovery counts, PM owner proofs and Errands. Each
  run used the approved PG18 loopback wrapper and it stopped PostgreSQL normally.
  This selected regression set is not the repository's complete PG integration
  matrix; the combined root release gate still needs its own final acceptance.

The early preflight's 30 passes/1 sharp skip/4 TODOs are superseded by mandatory
real tests, not relabelled as passed. No credentials/.env, real providers, user
images, production, commits or pushes were used by this implementation task.

## Remaining mandatory acceptance and implementation

1. Hosted CI for the combined publication remains pending. Integrated local
   checks passed after both lock-ordering repairs and N1 integration; further
   implementation changes require a new exact-tree gate.
2. Retain default mandatory decoder/pipeline/publication coverage under pinned
   sharp and disposable loopback whaleu_test. No opt-in skip mode is used.
3. Full atomicity/race matrix: every Review/content/binding/receipt/outbox failure,
   current parent/ancestor/Safety/session/head changes, deferred waits/expiry,
   raw writers/final fences, fact capacity/savepoints, ordering and replay.
4. Actual process death, all late effects, original/derived orphan reconciliation,
   quota/TTL recovery, long-retention collection and attach-versus-GC acceptance.
   Actual planned-object physical cleanup is covered; injected exceptions still
   do not replace process-death or unknown-version orphan acceptance.
5. N1 authenticated temporary-file presentation is locally verified for the
   ordinary single-image post detail only. Real platform picker/compression/
   upload, other surfaces, domain setup and independent account/device testing
   remain open; the real-device activation gate stays closed.
6. Distributed runtime rate/concurrency/bandwidth policy and the complete root
   integration gate. Official OpenAPI and the selected old empty-image/text/PM/
   Errands/Community regression set above have passed.
7. Real COS, actual image/content review issuer, provider permissions/versions/
   budgets, hostile-input hard-RSS/temp-disk containment, retention approvals,
   device testing, historical import and production activation remain separate
   release gates. They are not authorized or satisfied by this static patch.

PM, Errands, Ratings, Activities and Profile media are not enabled. Internal
private-owner rejection cases do not constitute those owners' integration.

## Combined integrated acceptance and lock-ordering corrections

The final local gate passed 5,798 tests: 5 stats, 20 search evaluations, 1,374 API
units, 2,165 native units, 2,207 main PostgreSQL and 27 semantic tests. There were
zero failures, skips, cancellations or TODOs. Lint, all typechecks, OpenAPI, both
builds/emitted smoke, formatting and diff checks passed on frozen source bytes.
The complete PostgreSQL stage took 47 minutes 52 seconds.

The first full attempt exposed a genuine deletion-order regression: newly added
exclusive Safety gates caused contact reads to wait before their canonical parent
row. Those two exclusive calls were removed without weakening the original
parent-row assertion. Native Page concurrency then exposed two independent
read/read conflicts: intent rows used exclusive locks and the final Media reader
fence used an exclusive advisory gate. Reads now use shared intent locks; writes
retain exclusive locks. Final readers use the epoch/source relation SHARE NOWAIT
fences while retaining the existing writer slot/overflow protocol, exact vectors,
limits, deadlines and facts. Concurrent readers, writer ordering, zero-row writes,
overflow, rollback and final-proof failures have real PostgreSQL coverage.
Relation maintenance can still cause conservative unavailable outcomes.

The hosted verification job budget increases from 60 to 75 minutes because the
preceding accepted job took 56 minutes 3 seconds and this slice adds mandatory
real retention/decode/native tests. Individual statement and test thresholds are
unchanged. This is scheduling headroom, not a capacity or performance claim.
