# Generic Ratings target cover, candidate protocol

Status: the accepted target-cover slice passed all 6,320 tests on one frozen local tree, including 2,392 real PostgreSQL cases and 42 semantic cases. The signed commit is `2b25fc28ae4ab37d5d9cacb9e03097932d8f0d9d`; its hosted Verify and Statistics checks passed. Production providers, Review issuers, COS resources and native device transfers remain unavailable unless explicitly supplied through local synthetic test DI.

## Business scope

One target cover belongs to the target's complete immutable definition, alongside required `name` and the textual `description` (which may be empty). Target edit remains creator-only. This is not a Profile avatar or a discussion author's named/anonymous face. All existing Category administration capabilities remain independent and unchanged.

The source behavior is `WhaleUCampus/WhaleU@57cf169c11123acf249909a1a7215b8cb1ec1f8e`: target creation/update stored one `avatar`; actual target update enforced creator ownership. Category `icon`/`cover_image`, root discussion API nine images and reply three images, and specialist course/canteen/dish images remain separate open work. The old shared root/reply UI was three/three; none of those discussion limits are enabled by this slice.

## Protocol boundaries

- Original scoped target operations are retained: `create_target_scoped` / `edit_target_scoped`.
- New target command version 3 has an independent canonical hash domain. Version 2 and its `assetIds: []` codec/hash are unchanged.
- New exact Review version 6 contains `cover: null | { appearanceId, assetId, manifestDigest }`. Body, CAS, identity, context, source and cover share one hash and consumption.
- Ratings journal 11 stays in the existing per-origin/per-account Ratings pending slot. Old journals 1–10 are not migrated or reinterpreted.
- Media uses `ratings-target-media-v1`, internal protocol 6. Media v1–v4 and Profile protocol 5 retain their exact request and hash definitions.
- Additive migrations 0081/0082 provide explicit dispatch rather than editing historical migration bytes.

Only `target_definition_heads` defines the current body/cover. `target_cover_appearances` is immutable attachment identity. `keep` references the same appearance and binding; `replace` creates a new appearance/asset; `clear` explicitly seals null. CAS precedes noop. An old fresh v2/M2 edit cannot silently clear a v6 definition, while original old receipt recovery still runs before current scope checks.

## Capability and context

A target-cover capability attestation is bound to the existing adopted protocol version, exact old capability source ID/revision/digest, route/native digests and exact compatibility/adoption digests. It does not relabel the old source payload or the Category compiler. No capability is issued by normal runtime configuration.

Context3 has an independent strict codec, persistent authority brand and digest domains. Its authority records the complete additional capability vector, including absent/invalid registrations. Context2 issuance, response and hash remain unchanged and do not query or imply the optional cover capability. Both versions reject cross-route context reuse. Text-only v3 scopes may use the original complete proof; every actual covered definition additionally requires its exact current scope capability. Registration epochs, including zero-row writes and absent-to-present changes, are retained through a bounded final shared fence. Upload scopes retain original actor/session, exact context, category and target-definition CAS, independent upload request, final command request and draft revision. Upload readiness never publishes a target.

## Current reads

Authenticated current reads preserve Ratings' existing viewer Session, Identity, Safety, source, topology, exact scope, every Category ancestor, target lifecycle and Review checks, then verify the complete cover's binding, manifest and asset Safety. A denied cover is a denied target; unknown cover evidence is unavailable. Neither case becomes `cover: null`.

Creator action restriction is not automatically a visibility restriction on existing Ratings targets. This slice does not add a creator block/Profile-decoration gate to generic target content.

Legacy and scoped current-definition dispatch support Review6. New v3 target/detail/list/subscriptions/random responses expose an opaque authenticated descriptor, never a provider URL or original storage key. Download rechecks the entire current owner both before and after staging exact bytes, including the exact context. Public Profile guest routes cannot authorize Ratings images.

Original v2 auxiliary reads and existing score/text-comment/reply/like/subscription operations retain their original intent/hash/receipt and journal. Covered targets impose an additional current scope capability and complete Review/Media check; this does not grant media write or complete cover projection to v2. Full v1/v2 target/list/random/subscription projections fail rather than return body with hidden cover. Owner deletion continues through its metadata-only owner authority. No wrapper or journal12 exists.

Complete random sampling validates every candidate and all negative/unselected facts before the uniform draw. It does not draw a bad image and retry. A selected v3 result includes a separate current read3 context for its selected locator and an exact descriptor (or explicit null cover), so aggregate random context credentials never masquerade as a single-scope read token. Media metadata is read in bounded vectors, using the same 64 MiB Ratings scan ledger as source/category/target metadata. Existing target/path/category limits are unchanged. Mandatory final proofs remain after deferred SQL waits; shared reader fences are not exclusive global reader locks.

## Lock and finalization order

1. Existing Safety policy and current Identity/session authority
2. Shared Ratings claim/request, exact context/source/catalog/category and target/head/CAS
3. Exact Review decision and current Review head
4. Gather all old/new immutable Media routing hints
5. All Media batches, then intents, then assets, then bindings, each sorted
6. Write owner definition/head and immutable appearance, consume exact Review, bind new media, detach old media and queue cleanup
7. Finish the replacement capability once, after the last Media write, then capture final Media epoch and retain Ratings after-state
8. Existing database finalizer: deferred constraints immediate, required proofs, optional proofs, fresh deadline fence

A replacement capability is transaction/savepoint-bound and cannot be reused or left unfinished. Previously retained outer Media facts are append-only: a replacement following an outer old read fails closed, rather than deleting the fact. Provider calls never run under database locks.

## Deletion and recovery

Existing owner tombstones immediately prevent new reads. A durable per-target queue enumerates immutable appearances with a UUID cursor in batches of 16, including historical replacements. It detaches through the shared Media lifecycle and does not require hidden target content to be readable. Completion of enumeration is not proof that physical objects have disappeared. Physical cleanup uses existing lease/retry and exact-object absence evidence.

Native upload-scope preparation and final command freezing share journal11. Recovery reads the original business receipt before attempting another commit. An upload request missing from the server is not cancellation. A dedicated upload-scope cancellation route derives the original exact Media request hash from the frozen original scope input and uses the existing Media cancellation fence even if the context expired before the scope was created.

Account change revokes temporary paths, sources and grants while preserving the original actor's minimal unresolved journal. Page-local file work shares the existing two IO / four lease / 10 MiB registry. The server process shares the existing 64 simultaneous delivery credits across owners; there is no additional native 64-credit or 64-MiB pool.

## Validation boundaries and remaining gates

The final frozen tree `b0197f1abf582fd005c5cb1b6a1b7c237d9389a3` passed the complete serial local gate: 6,320 tests (5 statistics, 20 search evaluation, 1,497 API, 2,364 native, 2,392 real PostgreSQL and 42 optional semantic), with zero failures, cancellations, skips or todo cases. Lint, typechecks, offline OpenAPI, build, emitted Page smoke and formatting also passed. All 2,177 source hashes stayed unchanged through validation. Main PostgreSQL took 66m23s; semantic took 48.469s. This is a complete final-tree rerun, not composed acceptance. Hosted Verify on signed commit `2b25fc28` also passed all 6,320 tests with zero failures, skips, cancellations or todo cases; Statistics and cloc passed. Hosted PostgreSQL took 71m24s. This result does not establish that the historical intermittent Safety lock-timeout cause is resolved.

The first frozen full PostgreSQL run failed five assertions: a public Review fence incorrectly depended on the new cover table while running the real 0065 schema, and empty cleanup work changed pure-text target history. Product dispatch now adds the new table queries/fence only for actual Review6 content; cleanup enqueue/backfill requires an immutable historical cover appearance, including replaced or cleared appearances. Original upgrade/history assertions and all 80 historical main plus two optional SQL migrations remain unchanged. Added real old-schema read/prepare/commit/receipt and historical-cleanup regressions passed in the complete rerun. The failed run remains part of the validation record.

Real COS, real Review issuer, mini-program domains/device behavior and production activation are separate unverified external prerequisites.

### New API surface

`/v3/ratings/target-cover` exposes `POST contexts`, `prepare`, `commit`, `cancel`, `upload-scopes`, `upload-scopes/cancel`; and `GET receipts/:id`, `targets`, `targets/:id`, `targets/:id/edit-context`, `targets/:id/appearances/:appearanceId`, `subscriptions`, `random-target`.

The separate `/v3/media/ratings-target` transport exposes bounded scope/request recovery, ingress and authenticated derived-image delivery. It delegates to the existing Media lifecycle and cannot publish or edit a target. Current media write capability requires the exact scope's complete source/compatibility/adoption registration. Optional registration failure alone never removes the old text-only context2 capability.

The native emitted Page smoke evaluates actual mounted Page `setData` against the repository WXML conditional tree, including numeric counters, author-action conditions, cover controls and independent context2/context3 expiry. It is a local rendering model, not a physical WeChat-device result. Real native controller/gateway HTTP-to-PostgreSQL interaction coverage is separate from this Page smoke and from client-only disk/SIGKILL recovery. No local result proves real provider activation or physical orphan retirement.
