# Ratings R1 design and frozen wire contract

Status: design approved for implementation, not functional acceptance. Migration creates empty storage. No production authority, issuer, source import or provider is enabled.

## Scope and permissions

R1 contains trusted catalog/target reads, independent integer scores and changes, own score, correct known-or-unavailable summary, named/target-scoped-persona text root comments, own deletion and minimal durable recovery. Replies, likes, subscriptions, experience, notifications, target management, media, specialist scales and other clients remain subsequent work. Author cumulative received-like deletion policy remains undecided.

All reads require a current session and account Safety authority. Context/categories do not add phone qualification. Targets, score and comment reads/writes require canonical current phone proof. Receipt recovery requires only current authenticated session. Global reads/scores/named text do not require affiliation or a generic base grant. Regional access independently requires verified ordinary authentication-group scope, exactly one fixed school-administrator grant, or a current global administrator grant. Conflicting/duplicate school grants fail closed. Browsing preference does not grant scope. Anonymous text additionally requires affiliation, a real privileged grant, or a new rating-specific temporary base assertion. Errand grants are not reused. Backend authorModes expresses this eligibility; clients do not infer it from Profile.

## Wire v1

The executable source is apps/api/src/ratings/contracts.ts. Objects are strict. IDs/revisions are lowercase UUIDs. Output timestamps are UTC Z, at most six fractional digits. Scores are JSON integers 1–5, never coerced. Limits default 20, maximum 50. Cursors are opaque 43-character URL-safe values. No GET increments views.

- GET /v1/ratings/context: {homeRegion:{id,label}|null,regions:[{id,label,relation:home|related|managed}]}
- GET /v1/ratings/categories?regionId&parentId&limit&cursor: root/direct-child page
- GET /v1/ratings/targets?regionId&categoryId&limit&cursor: direct targets in stable catalog order
- GET /v1/ratings/targets/:id?regionId: target detail
- GET /v1/ratings/targets/:id/my-score?regionId: {myScore:{score,revision}|null}; unknown history is RATING_SCORE_UNAVAILABLE, not null
- GET /v1/ratings/targets/:id/score-summary?regionId: known count/sum/average/distribution/revision or {status:unavailable}. Known zero has null average. Round raw sum/count once to one decimal
- GET /v1/ratings/targets/:id/comments?regionId&limit&cursor: independent newest-first bounded root page
- GET /v1/ratings/comments/:id?regionId: current root detail after target authorization
- PUT /v1/ratings/targets/:id/my-score: {clientRequestId,regionId:uuid|null,expectedTargetRevision,expectedRevision:uuid|null,score}
- POST /v1/ratings/targets/:id/comments: {clientRequestId,regionId:uuid|null,expectedTargetRevision,authorMode:named|anonymous,body,assetIds:[]}
- DELETE /v1/ratings/comments/:id: {clientRequestId,regionId:uuid|null,targetId,expectedTargetRevision,expectedRevision}
- GET /v1/ratings/requests/:requestId: account-owned committed minimal receipt

Absent read regionId, or command regionId=null, selects the global catalog explicitly. Context failure does not authorize a guessed region or block an independent global read.

Body normalizes CRLF to LF, trims outer whitespace, then permits 1–500 Unicode code points. TAB/LF are allowed; remaining C0/C1 controls and lone surrogates are rejected. Raw transport string is capped at 1100 UTF-16 units. Review and intent hashing use exactly the same canonical text. Score and text are independent; no prior score is required for a comment, and deleting text never withdraws score.

Category: {id,parentId:uuid|null,level:1|2|3,kind,systemKey:string|null,name,description,revision}. Kind is trusted catalog classification, not a score-scale/entity alias. Target: {id,categoryId,name,description,revision,allowedActions:{setScore,createComment,authorModes}}. createComment authorizes an attempt, not a claim a real review issuer exists. Unknown score coverage makes setScore false. Comment: {id,targetId,body,revision,createdAt,author,isMine,allowedActions:{delete}}. Named author only {mode:named,profileId,displayName}; anonymous author only {mode:anonymous,targetId,personaId,displayName}. Anonymous targetId equals outer targetId. Delete implies isMine. Anonymous payloads never include real account/profile IDs.

Pages: {context:{regionId:uuid|null,catalogRevision,...locator},items,nextCursor,continuation:more|scan|end}. Locator is nullable parentId for categories, categoryId for targets, targetId for comments. Every item matches it. Scan permits bounded progress through filtered candidates. Category/target order uses accepted unique ordinal; comment order uses database-generated ordinal descending, avoiding timestamp truncation.

Success receipt: {requestId,operation:set_score|create_comment|delete_comment,outcome:applied|noop,targetId,subjectId,revision,occurredAt}. Score subjectId equals targetId. Noop is impossible for create_comment. Same-key replay returns the original receipt. Noop score/delete occurredAt is the original effective transition time, not a new observation timestamp; score/summary/revisions/timestamps remain unchanged. Rejection receipt: {requestId,operation,outcome:rejected,code}. See strict executable allowlist. Infrastructure/unknown authority errors do not manufacture terminal rejected receipts. Different intent under the same key yields REQUEST_CONFLICT. Missing own receipt yields REQUEST_NOT_FOUND.

## Independent sources and database causality

Sealed catalog revisions and region/global heads carry complete accepted source/policy evidence, exact validity and deterministic effective hierarchy/override ordering. Parent FK and level rules cap depth at three. A global/system category never grants global access to a regional target. Targets have their own immutable definition and exact canonical review binding. Every access proves the current catalog, all ancestors, scope and active target.

Score baselines are independent of accepted catalogs and text approvals. R1 admits fresh-zero only with an independently accepted new-native-target source, explicit source/policy references, and a same-transaction target creation event. Fresh source transaction is checked at insertion; inserting historical data today cannot become fresh zero. Unknown or historical coverage remains unavailable and non-writable. Tests use explicit synthetic sources. No importer, history repair, inferred zero or reconciliation runs.

A unique target/account score row changes under target→summary→score locks. Its database trigger alone creates an immutable old/new transition and exact summary delta in the same transaction. Direct summary/event mutations, score withdrawal and same-score UPDATE are rejected. Summary checks prove nonnegative buckets, count=sum(buckets), weighted sum and safe integer bounds. Deferred validators establish final score/summary causal chains and applied receipt matching. Multiple legitimate same-target transitions in one transaction remain possible. No-op receipts prove an immutable historical actor/target/subject/revision/time; the application checks current CAS and desired score under locks before creating that receipt. Deleted text leaves score untouched.

## Owners, locks and final validation

Review adds typed target/comment sidecars under the canonical owner, with distinct purposes and exact actor/request/target/category/catalog/scope/text/mode/assets envelopes. No null actor, post alias or test allow override. Campus, Verification and Authorization expose narrow evidence; only actual future-time widening paths get SQL-precision checks. Conservative existing expiry deadlines are retained. Safety exports explicit rating list/direct relationship semantics; anonymous never enters named relationship resolution. Profile supplies only locked safe named display, and missing projection fails the whole read rather than silently skipping an author.

Common shared Safety gate → session/account locks → own request (commands) → authority heads → catalog/head → ancestors root-to-leaf → target → summary/score or comment/persona → review binding/Profile projection → opaque cursor bucket last. New rating authority writers take common exclusive gate first. Existing unrelated writer graphs are not broadened; their owning final proof uses current source locks and bounded NOWAIT fences.

All transactions use READ COMMITTED and explicitly enable required owner proofs. Deferred constraints flush before final validation. Final proofs perform bounded nonlocking reads and NOWAIT fences only, use PostgreSQL exact clock predicates and cannot mutate source data. Ratings has at most 161 facts, three indexed set-oriented source queries plus one lifecycle epoch read, 500ms total and 100ms maximum statement budget. Mandatory proof failures roll back the transaction. Missing optional score evidence returns unavailable only for that summary.

Navigation fingerprints include account/session/scope/catalog/locator/order/limit plus Safety, review and target-lifecycle epochs. Both allow and filtered deny/absence observations bind the epoch, so unblocks and review changes invalidate old cursors. Safety retains its existing 128-slot protocol; new review uses its own bounded epoch. No fourth owner is inserted into CountProofCollector and no capacity ceiling is raised or circumvented.

## Acceptance and release boundary

Strict DTO/Unicode/privacy tests, normal-AppModule HTTP, real isolated PostgreSQL causal/no-op/CAS/idempotency/concurrency/deferred-expiry tests, negative cursors, independent baseline, anonymous unlinkability, own deletion and unknown-result native recovery are required. OpenAPI must match actual routes. All checks must rerun after restoration or later edits. Synthetic reviews prove a development chain only; real issuance/import/providers and devices remain separate release gates. No implementation or test count is claimed by this design.
