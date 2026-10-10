# Single-image discovery: implementation and acceptance boundary

This stage makes existing Community single-image posts, and their plain-text
comments/replies, eligible for the existing text discovery paths. It does not
implement OCR, image embeddings, image captions, image-only publication,
nine-image publication, comment attachments, another Media owner, or a production
provider.

Integrated full local validation passed 5,944 tests on the frozen source tree;
hosted checks for this publication remain pending. Do not treat synthetic fixtures
as a production certificate. Upload-recovery V2
baseline retains all fifteen Media writer-source tables and their existing
statement-trigger/slot/overflow protocol.

## Conditional metadata and canonical order

`media/content-snapshot.facade.ts` reads an exact Community parent and ordered
approval identities. It returns only a versioned allow/deny/unknown fact, expiry,
and immutable attachment identity; no bytes, URLs or viewer authority. A single
metadata join covers up to 256 distinct image posts, within 768 ancestry nodes.
The caller's existing `SnapshotReadBudget` is shared, including its four MiB
combined wire allowance and cap-plus-one rejection. Additional, missing,
wrong-order or unsupported attachments do not become an empty set.

The batch and scalar repository use `media/current-facts.ts`: ready intent,
current head/event, exact manifest and policy identity, strict immutable manifest
validation, PostgreSQL-exact not-before/expiry, and conservatively floored JS
deadlines. A current held/revoked decision is known denial only after these facts
validate. Other missing or inconsistent evidence is unknown. Canonical earlier
structural/Review/Safety decisions retain their existing short-circuit order.

An explicitly empty Community definition requires no Media installation. The
Community source proof protects that definition against later attachment writes.
The batch API does not register required transaction facts or deadlines and never
locks rows. Its callers must prove the read interval using the appropriate owner
profile. Conditional batch facts alone cannot authorize a page or certificate.

## Optional count isolation

The legacy count collector still rejects a fourth owner. The explicit image-aware
profile binds Community, Safety, Campus and Media, capturing Media before source
enumeration. Only a complete traversal with no consumed image fact may use the
legacy three-owner final proof. A consumed image requires the early Media vector,
including consumed negative evidence and its deadline.

Final validation acquires all required NOWAIT SHARE fences before fresh vector
reads. Media includes `media_owner_states` and all fifteen current source tables.
Reader/reader compatibility and writer UPDATE/overflow admission are unchanged.
No count-only read enrolls mandatory Media state. Failure invalidates only that
optional total; previously proved page data, cursor and independent totals remain
independent.

The original 2,000 ms scan, 100 ms source statement/final vector proof, 25 ms lock,
two concurrent counts, 1,024-candidate/500 ms source-fenced fallback and four MiB
batch allowance remain unchanged. A high-capacity server may use only the
existing fully source-fenced small fallback, never claim slot completeness.

## Versioned semantic eligibility

An additive optional semantic migration introduces a separate v2 certificate
store. The v1 certificate rows, original seven-element source revision chain,
body digests and text vector identity remain unchanged. V2 adds a separately
versioned Media ancestry chain with explicit empty nodes and exact nonempty
binding/intent/head/event identity. No Media field is appended to the old tuple.

Current v1 authority is accepted only for a completely verified empty-image
ancestry. A new image requires v2. A changed current allow head, including
allow/deny/allow ABA, requires current v2 evidence even if text and manifest bytes
are unchanged. Current trustworthy denial remains a negative dependency with a
horizon. Such nodes and non-top-K nodes participate in full-scope
coverage and version-separated fingerprints. Missing eligibility or any required
text vector remains unavailable, never a truncated successful corpus.

The early Media owner capture precedes structural enumeration. Image dependency
consumption promotes that captured interval to required final proof, after
provider/deferred waits. Index writes retain their existing Community certificate
protocol rather than self-invalidating through a new pre-write Community proof.
Only synthetic fixed providers/profiles are used for acceptance; this stage does
not contact a model or external provider.

## Existing product contracts

Keyword scoped v3/federated v4, Profile v1, liked anchors, feed scan limits and
notification unread bookkeeping are unchanged. Search returns existing text
projections, not thumbnails or Media metadata. Media denial filters current
content; unknown remains unavailable. Explicit keyword fallback remains a
separate request/mode with keyword sorting and cursors.

Existing notices can become unavailable without becoming read. Fresh valid
Media evidence can restore their allowed preview; no historical external
notification is replayed. Saved/liked membership, notice identity and read state
are not replaced with counts of currently visible image targets.

Ordinary `ContentReviewModule` installs the unavailable batch implementation,
matching its unavailable scalar Media port. The local synthetic Media fixture
explicitly enables both. No production enable flag, provider, credential, real
device release or public availability is introduced.

The existing post HTTP and canonical Review contracts require nonempty text, even
when an image is attached. This stage preserves that rule: image-only posts are
not supported. Acceptance uses lawful image-and-text parents with plain-text
comments/replies, and regression tests reject attempts to bypass the canonical
empty-post constraint. Empty-body or otherwise invalid records cannot obtain
Media-backed authority merely through a v2 certificate.

## Validation coverage

Focused development checks passed: API typecheck, lint, API/native builds,
75 targeted unit tests, 64 count/cross-surface PostgreSQL tests and 34 semantic
PostgreSQL tests, all with zero skips/TODOs. A real 4,097-post count including a
current image returned known in approximately 952 ms, using 18 count batch
queries, a maximum 1,169,697-byte batch and a maximum 256-ID bind array. These are
local measurements, not a guaranteed availability envelope; all existing runtime
timeouts and capacity bounds remain unchanged.

The semantic race fixture retains the real Safety shared gate. A competing
writer holds its source RowExclusiveLock while waiting for that gate; the final
Media SHARE NOWAIT fails, rolls back the reader, and lets the writer complete.
It does not remove the real policy lock to manufacture a concurrency scenario.

Required final-tree coverage:

- `media-content-snapshot.test.ts`: metadata identities, pure shared validator,
  allow/deny/unknown, exact-time rejection, cardinality and shared byte budget.
- Count unit suites: fixed profiles, late images across 4,097 candidates, negative
  horizons, original three-owner compatibility, optional rollback and fallback.
- `integration/media-discovery.test.ts`: real synthetic image publication with
  plain children, keyword/Profile/feed/liked/saved, off-page unknown totals,
  cursor continuation and notification unread-state preservation.
- Focused Media/count proof integration: fifteen source writers, reader/fence
  compatibility, initial-to-final churn and preservation of mandatory page facts.
- Semantic v1/v2 evaluator/proof and synthetic PostgreSQL suites: exact ancestry,
  mixed old/new certificates, branding/savepoints, ABA, negative/full-scope
  fingerprints, vector completeness and unchanged text vector bytes.
- Final formatter, lint, typechecks, complete existing local/hosted gates and
  PostgreSQL matrix after all changes have frozen. Focused passes are not a full
  release gate. Record exact tree and commit alongside every acceptance result.

## Integrated exact-tree local acceptance

The final gate passed 5 stats, 20 search evaluations, 1,412 API units, 2,224 native
units, 2,249 main PostgreSQL tests and 34 semantic tests (5,944 total). Every group
had zero failures, skips, cancellations and TODOs. All lint/typechecks, OpenAPI,
build/emitted smoke and repository format checks passed. The main PostgreSQL
stage ran for 51 minutes 26 seconds; the semantic stage ran separately afterward.
All 1,977 source hashes and the staged tree were checked before and after every
stage and matched at integration. The tested tree was
`8bec98f046c5beaddd7ac0fa3743bc7dd043b503`, based on signed `c1b3c24`.
Only documentation status changes followed, with formatting checked again.

Historical main migrations 0001–0073 and semantic migration 0001 remain unchanged.
Only additive semantic migration 0002 is introduced. No model/provider calls or
production activation occurred. Hosted [Verify](https://github.com/Xauryan/whaleu-next/actions/runs/38045376032)
and [stats](https://github.com/Xauryan/whaleu-next/actions/runs/38045376103) passed
on signed `a1fbcf1`. The main job took 60 minutes 45 seconds. Hosted Verify
test-level counts were not independently retrieved; the 5,944 count above is
the verified local result. Real-device and real-provider acceptance remain
outstanding.
