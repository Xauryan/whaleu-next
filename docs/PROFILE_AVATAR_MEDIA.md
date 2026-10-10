# Profile avatar media: local implementation candidate

This is a **locally focused-tested implementation candidate**, not production activation or completed profile parity. No true 91-image catalog, licensing/import, real COS/Review provider, WeChat device/cropping, or production capacity acceptance is included. Normal AppModule injects a null runtime; synthetic catalogs/storage/Review exist only through explicit test DI. The comment-media foundation is the signed `72b21ec` baseline. Full frozen-tree regression acceptance for this increment is still pending.

## Independent protocol and original owner

All new JSON uses `protocol: "profile-media-v1"`. Internal Media upload protocol 5 does not change the v1–v4 codecs, digests, or journals. Additive migrations 0079/0080 preserve historical SQL. Existing own-profile/nickname/bio/preferences/campus operations retain their contracts and share the same Profile revision with avatar commands; no parallel user CRUD exists.

- `POST /v1/me/profile/avatar-edits`: `{protocol,clientRequestId,expectedRevision,slot:"avatar",declaration:{mime,bytes,sha256}}`
- `GET /v1/me/profile/avatar-edit-requests/:requestId`: original actor's metadata recovery
- `POST .../avatar-edit-requests/:requestId/cancel`: `{protocol,requestHash}`; a pre-prepare cancellation has a real durable `cancelled_before_prepare` response without fabricated edit/intent IDs
- `GET .../avatar-edits/:editId`: upload observation
- `POST .../avatar-edits/:editId/grant` and `/finalize`: empty JSON
- `POST .../avatar-edits/:editId/uploads/:grantId`: authenticated multipart, exactly `file`
- `POST /v1/me/profile/avatar-commands`: `{protocol,clientRequestId,expectedRevision,source}`. Source is exact `clear`, `catalog` with `catalogVersion/itemId`, or `custom` with `editId/assetId`. URLs, client manifests/approval, arbitrary account/space/post IDs and extra keys reject
- `GET /v1/me/profile/avatar-command-requests/:requestId`: `not_recorded`, historical `committed` receipt, or authoritative `cancelled` key/hash; a receipt never restores an old image or authorizes bytes
- `POST .../avatar-command-requests/:requestId/cancel`: `{protocol,requestHash}`. The original actor/key serial point returns committed if creation already won, otherwise persists an irreversible cancellation fence. It never undoes a saved avatar
- `GET /v1/me/profile/avatar` and `GET /v1/profiles/:profileId/avatar`: separate current selection. `none`, `unavailable`, and available catalog/custom are distinct
- `GET /v1/profile-avatar-catalog`: versioned available items or explicit unavailable. It does not invent 91 assets
- `GET /v1/profiles/:profileId/avatar/:appearanceId/:variant`: controlled current bytes, `thumb-v1` or `display-v1` only

OpenAPI has a separate offline renderer and a generated `docs/openapi/profile-avatars.json` artifact. Fresh generation/checks passed in the final cheap gate.

`clear` is a newly specified safe fallback, not a verified legacy UI capability. Every successful selection, including reselecting the same catalog item or clear, increments shared CAS exactly once. A stable actor/request-derived immutable appearance identifies its exact Review envelope. Same key + same hash returns the original receipt without rebind; another source/revision with that key conflicts. Stale CAS must be reloaded and intentionally reconfirmed; no silent rebase. A CAS/error response alone does not erase the unknown-command journal. Explicit cancellation settles it only with a matching committed/cancelled result. New command/cancellation keys share the existing Media-scale budget of 100 per UTC day and 10 per minute per actor; retries are free and unresolved identities are never evicted.

## Exact selection, read and replacement

Prepare creates only an actor-owned immutable edit, not a publicly discoverable profile. Its expiration is a Profile edit deadline, never a fake Community draft. Final bytes reuse the single-image pipeline: JPEG/PNG, 5 MiB, 24 MP, 8192 maximum dimension, sealed exact source, full decode/reencode/metadata removal, fixed 400/2048 variants and current asset safety. Upload 100% is not saved/ready.

Each selected appearance has an immutable source definition and its own exact Profile Review consumption. `custom` binds exactly one asset/manifest to the immutable appearance; a separate mutable pointer picks the current appearance. Catalog bytes are not user-upload GC targets. Changes to nickname/bio do not mutate image identity or rebind assets.

Replacement holds current Profile CAS, gathers both old and new references, locks sorted batch → intent → asset → binding, validates exact new source and Review, creates binding/definition, replaces pointer, detaches the old binding, writes the receipt, and commits one transaction. Failure rolls all of it back. Detached bindings remain historical metadata only; cleanup remains pending/retained until exact object deletion and ingress quiescence are proved.

Current reads resolve a trusted server guest/session principal. A missing Authorization header may be guest; a malformed, invalid or expired supplied header cannot downgrade. Target account must be active, profile current, relationship allowed, exact Review current, and custom asset safe/current. `hideProfilePosts` does not hide avatar basics. Logged-in bilateral blocking does not promise to identify somebody who logs out and views a public guest profile.

Byte delivery uses two short managed transactions with a paused exact-object open between them. The complete principal/appearance/Review/catalog or Media plan must match; final mandatory proofs/deadlines commit before streaming. No redirect, original, signed URL, Range, public image association cache, or phone/private identity data. Guest budgets use server-issued connection identities, never fake account UUIDs. Community and Profile share one trusted application-DI delivery budget pool: total 64, authenticated account limit 2 across owners. Each app container owns its pool; there is no implicit process-global test state or constructor fallback. Future Community production providers must inject that same pool. A timed-out but unsettled object open or delayed stream destruction retains its reservation until actual settlement and stream closure; timers and duplicate callbacks cannot manufacture free capacity. Already delivered bytes/screenshots cannot be recalled.

## Proof and concurrency boundaries

Profile raw/owner writers use actor-specific exclusive advisory fences; final reads acquire shared NOWAIT fences and compare exact profiles (including absence), pointers, definitions and relevant edit fingerprints. Actor key changes fence both sides in order. Catalog and Review have independent current fingerprints, including row versions and binding evidence. A mutation enrolls its complete post-state and never erases outer owners' required facts. Deferred constraints flush before all final current proofs and fresh deadlines.

This does not claim deadlock freedom: a raw PostgreSQL UPDATE may lock a tuple before its trigger while application mutations lock actor before tuple. Writer-first/reader-first, multi-actor order, late DML, deferred constraints and proof budgets require real PostgreSQL evidence. Media mutation locks precede Review acceptance; reads acquire Review before NOWAIT Media locks, and must fail boundedly on conflict. No lock/deadline budget is raised.

## Native projection and recovery scope

The original Profile page uses the same SessionStore and the existing per-invocation official image-picker driver, with separately captured success/cancel/complete callbacks. The `chooseAvatar` open-type event does not provide a proven per-call cancellation identity here and is not activated as the normal selection entry; its cropping/platform/device behavior remains unverified. New local byte identity means a new request. A finite in-page preview is used, never `wx.previewImage` completion as proof that system preview or cache is gone.

Account/epoch change immediately removes image sources, aborts local operations, revokes leases and discards paths, grants, file bytes and sensitive edit content. Minimal actor-isolated unknown-command/upload metadata keeps the original key/hash so A can reauthenticate and recover; B cannot load or cancel A. Local close/cancel/logout is not proof of server cancellation. File unlink/system cleanup remain best effort.

Public Profile and explicitly selected named post/comment/reply avatars are lazy decorations fetched through the current Profile endpoint. There is one application-wide avatar viewing window, sharing the existing 2-I/O, 4-lease, 10-MiB registry. Same named in-flight requests are deduplicated; choosing another row/page revokes the previous source; unloaded/rejected images use a neutral local fallback. Anonymous personas never issue a named Profile request or carry selected catalog/appearance metadata, including for the author themselves. An unavailable avatar cannot hide the original article/comment.

Open scope remains: embedded avatar descriptors in historical DTOs (still `avatar:null`), Ratings/DM/notifications/other platforms, true91 catalog import/license, real provider/device activation, and profile backgrounds. Do not mark overall Profile parity complete.

## Validation status

Focused local checks passed: API 26/26, native 50/50, and real PostgreSQL/native-process/worker-process 23/23. The complete Profile PG matrix took 300 seconds including real persisted lease waits. Typechecks, lint, generated OpenAPI checks, and emitted native build/smokes also passed. These focused results are supplemented by the composed acceptance below; they are not by themselves a full regression claim. Native fixtures are synthetic platform adapters with real local HTTP/PG where explicitly tested, not physical devices or providers. Deterministic future-submillisecond clock-boundary coverage and independent API-service-process SIGKILL remain open test cases; native-process and worker-process SIGKILL must not be presented as those missing cases.

## Aggregate validation scheduling

The measured prior complete PostgreSQL stage took 58 minutes 50 seconds. The new
Profile-focused matrix takes about five minutes, including two genuine persisted
60-second worker leases. The frozen local validation script therefore allows
4500 seconds for the **whole main PostgreSQL stage**, and the hosted verification
job allows 90 minutes for installation, cheap checks and that stage together.
Semantic validation retains its prior limit. This only provides scheduling
headroom: no individual test, SQL statement, lock/proof budget, retention or lease
has been extended. These limits are not a performance or capacity claim.
`bash scripts/validate-profile-avatar.sh POSTGRES_WRAPPER FROZEN_EVIDENCE` uses
prepared exact-source evidence and keeps each command timeout inside the existing
isolated PostgreSQL wrapper so its cleanup runs normally.

## Composed local acceptance

The accepted local evidence covers 6,224 tests: 5 statistics, 20 search evaluations,
1,466 API units, 2,340 native units, 2,351 main PostgreSQL cases and 42 semantic
cases. This is composed coverage, not a fresh complete PostgreSQL run on the final
tree. The original full PostgreSQL tree
`c7a3ba1414b2923911b672fe875cab2557fa158b` ran 65 minutes 9 seconds and recorded
2,349 passes plus two failures: the exact Media source-list assertion omitted the
new `profile_request_markers` table, and its parent suite aggregated that failure.
Those original failures remain part of the record.

The final tree `c646ce5cbbdfb9d0bf5b0b6784719efaa5b2d69c` changes only seven
paths from that full-run tree: the strict source-list test, opt-in scalable-profile
diagnostics and their tests/documentation/test-step settings. All other 2,108
original source files, production code, schema/dependencies and all 1,848 emitted
API files remain identical. The final tree passed the complete cheap/build/format
gate, both complete affected PostgreSQL suites (21 cases, including the repaired
source-list and zero-row writer checks), and all 42 semantic cases. The 21 replace
that same coverage from the earlier full run; they are not added again to the
2,351 main-case inventory. Only documentation status edits followed, with formatting
checked separately. All 78 historical main migrations and both optional semantic
migrations remain byte-identical; main 0079–0080 are additive.

The preceding `72b21ec` hosted checkpoint failed one scalable-profile leaf and its
parent aggregation with `SAFETY_UNAVAILABLE`. Its database log records a lock
timeout on the final Safety batch query, but the blocking object/session is still
unknown. The local exact-count assertions pass; an opt-in 32-KiB, allowlisted
observer now retains proof phase, SQLSTATE and bounded lock evidence without
changing public responses or lock/proof budgets. No blocker observed means unknown,
not proof of absence. A new full hosted gate remains pending. This increment does
not claim that the historical timeout root cause is fixed, or enable real storage,
review providers, catalog assets, device capabilities or production deployment.
