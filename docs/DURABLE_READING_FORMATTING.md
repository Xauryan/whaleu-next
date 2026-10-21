# Durable reading runtime

## Current status and integration boundary

The current c27 integration includes formal `0175_community_text_sources.sql` and `0176_durable_reading_formatting.sql` in ordinary migration discovery. Actual heads/jobs/results/two fixed slots, transactional enrollment, canonical processing proof, bounded worker, full catalog readiness and source-aware native readers are implemented. The older controlled SQL draft is historical test material, not the deployment installer. Do not apply it after 0176.

Source/compiled worker CLI, normal migration and C/en_US PostgreSQL checks have passed locally within the exact-input scopes in [READING_C27_INTEGRATION.md](READING_C27_INTEGRATION.md). [M2_DEPLOYMENT.md](M2_DEPLOYMENT.md) defines explicit production mode and managed-role admission. Review and worker defaults remain disabled deliberately. Human `source_manual` publication and original-source reading are independently available with their own explicit policy/operator configuration and do not require M2.

No external AI/provider, real production deployment or physical-device acceptance is claimed. Native plain/Markdown draft editing and preview are implemented; published-source editing, inline Markdown media and full-source Markdown reference AST remain unsupported. Account-erasure qualification remains excluded and fail closed. Original full API cloud typechecking and password-authenticated Docker CI remain separate gates.

## Installed behavior

The formal migration `apps/api/migrations/0176_durable_reading_formatting.sql` installs the durable owner and catalog seal. With the complete owner ready, every genuinely created, reviewed source publication enrolls its derivative in the same transaction, after receipt/origin/reference/component enrollment and final actor recheck. Replay returns before this seam. Existing source rows are not backfilled. Plain+auto sources qualify at 300 Unicode scalars for posts and 200 for comments/replies. Explicit Markdown, opt-out, short source and legacy/missing descriptors never enroll. Missing descriptors retain their original legacy meaning, rather than silently opting in. The integrated native composer explicitly selects plain+auto by default for fresh supported text, without upgrading historical descriptor-free drafts.

Original source text exists only in canonical content rows. M2 stores exact source identity, immutable generation/version, offsets and queue metadata, not copied source text, author display data or provider output. Formatter identity is `plain-cjk-slices-v2`. The finite safe-character profile and whole-source fallback retain the original canonical UTF-16 string without normalization or rewriting. The SQL guard recomputes the deterministic plan independently; runtime recomputes against freshly reconstructed canonical text on completion.

## Authority inventory

- IdentityService.processingAccountState delegates to IdentityRepository and the Identity-owned retained proof in processing-account-proof.ts. It locks at most three lexical account IDs NOWAIT and retains exact status, lifecycle, generation and xmin, including missing negative observations. Its mandatory final accounts SHARE NOWAIT fence prevents an observed active account changing to blocked/cooling/erasing/completed. It is separate from session, DM and reader APIs.
- ReadingSourceOwner resolves parent-first canonical post/root/reply definitions, exact binding/current Review, actual current Media for each ancestor, source body/hash/request, active region/scope, owner-hidden state and category-head absence. It retains existing Community/Campus epochs and independent Identity/Review/Media/visibility/category facts. Target moderation is passive_bookkeeping, not interaction, browse, posting eligibility or impersonation of the author. Reader-specific blocks never grant processing authority or mutate jobs.
- ReadingFormattingRuntime has private ECMAScript issuance/consume methods and an unexported WeakMap registry. A permit is frozen, exact-owner/managed-TX/read-epoch/operation/source/generation-bound and single-use. No client metadata, source hash, model factory or reader result can issue one. Completion and retry reacquire fresh authority in a fresh managed READ COMMITTED transaction.
- Independent SQL guards check real source publication causality/current canonical state, exact leases/slots, result determinism, and deferred graph completeness. Direct source dependency fences include Identity, canonical/source/Review, region, visibility/category absence, components and Media. AFTER STATEMENT dependency guards recheck jobs written in the current transaction, so draining deferred constraints does not admit a later invalidating canonical write.
- Graph final proof uses exact post-write row/xmin fingerprints and bounded required NOWAIT table fences. SQL lifecycle qualification is deliberately not weakened.

## Queue and slot contract

Candidate discovery is exclusively `(next_probe_at, job_key)`, with an exclusive cursor on that same tuple, at most eight raw rows. Rich decoding is independent; malformed scheduling keys make the relation unavailable, never guessed. A worker retains the last examined tuple across ticks, continues past unavailable/locked rows, and wraps only after an empty tail. At most two successful claims per tick occupy two database-owned global slots. Computation/completion is sequential within one invocation to avoid self-contention on final slot fences.

Unavailable authority is not pause/retirement/erasure. A fresh independent maintenance transaction locks and compares the entire actual raw row plus version, then changes only scheduling state/count/time/reason/version. Probe 1 defers five seconds, probe 2 thirty seconds, probe 3 quarantines scheduling. Structural payload failure quarantines scheduling directly. Maintenance cannot change source/generation, result, lifecycle state, claims, lease or fence. Scheduling is persisted; no GET resumes quarantine or resets a budget.

`next_attempt_at` is separate computation retry eligibility. A current leased processing retry requires fresh source authority and exact live slot/job, retains claims/fence, and defers 5s/30s; claim 3 exhausts. Lease expiry is DB-clock based and at most ten seconds. An expired slot may be reassigned without changing any field of its old unavailable job. Exact token+fence+slot triple and DB time reject old completion after slot reuse or same-job reassignment. Three expired claims can exhaust only with fresh canonical authority.

`ReadingFormattingWorker.run(1..32)` is an actual bounded runtime worker. `reading:process -- once|serve` is a production-capable CLI, not an HTTP endpoint; processing defaults to disabled. `once` requires an enabled mode and `serve` requires explicit automatic mode. Full schema and production role readiness are checked at startup and before every tick. Deployment/secret custody are separate from implementing the runner. Explicit quarantine repair/resume is not provided; no permanent/infinite-arrival fairness claim is made.

## Routes, decoder and optional presentation

The standalone formatting route is authenticated GET `/v2/community/text-sources/:kind/:id`, operation `communityTextSourceV2`. The integrated tree additionally has six source-aware detail/thread routes and a separately versioned v2 source-capability diagnostic; see [READING_NATIVE_INTEGRATION.md](READING_NATIVE_INTEGRATION.md) and [M2_DEPLOYMENT.md](M2_DEPLOYMENT.md). Account route manifest: `ReadingFormattingController.source`, browse, entry. TextSourceReadService.sourceV2 retains the same canonicalSource function and mandatory authorization transaction as v1. Existing v1 capability and source schemas remain unchanged.

The strict response is `{ version: 2, source: <exact existing v1 source DTO>, presentation: {status: 'source'} | {status: 'formatted', plan} }`. `textSourceReadV2Schema` validates the nested canonical source and recomputes exact plan offsets. OpenAPI fragment: docs/openapi/community-reading-formatting.json, generated from these actual schemas. Hash/determinism and authority semantics exceed JSON Schema and are documented explicitly.

No job existence/state/hash-only response, account ID, lease, queue details or source-on-denial is exposed. Canonical denial/unavailability is still whole-response failure. Optional presentation SQL is a savepoint-isolated read. Its final optional proof independently fences/rechecks exact graph/current processing eligibility and bounded Review/Media expiry; failure changes only the unpublished result object back to source. It never calls worker issuance or maintenance. Required canonical proofs still run first and cannot be downgraded to fallback.

## Erasure

The four new relations are intentionally NOT added to the old reviewedRelations or source-free qualification allowlist. Digests and offsets remain account-derived through source ownership. Current erasure preflight fails closed, including when tables are empty or contain no account UUID. This does not claim physical erasure or worker-quiescence closure. The separate actual-content erasure owner must admit these tables, fixed slot seed shape, all values, generation/lease closure and late writes before claiming account deletion support.

## Current installation and validation

Install through the ordinary checksum/prefix-verified migration sequence ending at formal 0176; do not install the old draft into that schema. The actual local C/en_US suite includes normal installation, readiness tamper/fallback checks and restricted managed-role processing. The exact CLI successor additionally passed direct restricted LOGIN and actual source/ordinary compiled entries over verified TLS. Its SIGTERM check occurred after a completed tick; only pure tests cover a controlled in-flight drain. Loopback trust is not password authentication, and these checks are not Docker/cloud CI or production activation. Full attribution is in [READING_C27_INTEGRATION.md](READING_C27_INTEGRATION.md).

## Historical controlled-draft installation and verification record

Everything below records earlier isolated draft/v1/v2/v3 handoffs and their then-pending gates. Historical commands and migration numbers are not current deployment instructions. The old failures/corrections remain provenance; current results are stated above.

### Original draft procedure

Do not run while another PG lane owns the shared database. The draft checks database name whaleu_test, loopback server address, explicit application_name marker, M1 source relation presence and M2 absence. The integration test installs it in one managed transaction with SET LOCAL application_name='whaleu-reading-controlled-test', after baseline migrations and before fixtures/publication. It uses the existing suite advisory lock and fresh-whaleu-schema assertion; cleanup drops only schemas it created. Production installation requires a separately reviewed numbered migration, not bypassing this draft guard.

Focused local command (no PostgreSQL/compiler):

`cd apps/api && node --import tsx --test test/reading-empty-media.test.ts test/reading-formatting.test.ts test/reading-formatting-sql-inventory.test.ts test/community-text-source-routes.test.ts test/community-text-source.test.ts test/community-text-source-sql-inventory.test.ts`

Real PG command, only after integration lead allocates the controlled lane:

`cd apps/api && timeout 300s node --import tsx --test --test-concurrency=1 test/integration/reading-formatting.test.ts`

The one test parent has timeout 240000ms. All child cases inherit that parent deadline; outer process limit is 300s. It uses real managed transactions, local Review and real HTTP publication. Expiry checks wait for actual DB clock using pg_sleep, never rewrite stored leases or use caller time. No compiler, full build or PG execution was performed before the review freeze.

Admission still requires type/full-build compatibility, full route/OpenAPI integration, real-PG execution of the new suite plus M1 regressions, independent review of SQL direct writers/late writes and lease/fairness races, lifecycle concurrency beyond retained-fact unit tests, and resolution of any findings. The partial pure/mock worker tests prove orchestration only, not SQL authorization or production readiness.

### Historical v2 successor correction

Frozen v1 is not admitted: self-review found that an expired job in slot 2 could reclaim free slot 1 and leave its old expired slot-2 edge, causing completion graph closure to reject. This successor releases only the exact old same-job slot/token/fence/expiry reservation, only when database time proves expiry, after both fixed slots and the exact current job are locked. It uses the fresh claim transaction, never an old worker permit. Another live job/lease cannot match the release CAS. Added real-PG cases cover slot2→slot1, same-job reassignment, unrelated live slot preservation and old completion rejection; these cases were unrun at that historical handoff. Current suite execution is attributed above.

### Corrected independent findings and seal

V2 independently guards OLD scheduling admission, including quarantine, next probe and next attempt, and retains next_attempt_at during claim/completion/exhaustion. SQL URL pseudo-scheme matching uses an explicit ASCII class and boundary under C collation, matching JavaScript's non-Unicode word semantics. SQL/TypeScript parity cases explicitly require both C and an en_US locale, including CJK and fullwidth pseudo-schemes, ASCII schemes after non-ASCII/word characters, CRLF canonicalization and supplementary-scalar thresholds. These are executable PG cases, not claimed PG passes.

The v1 manifest incorrectly excluded any directory segment called evidence. V2 excludes only the explicitly rooted evidence directory (plus dependency trees), and includes all six actual source files under apps/api/src/verification/evidence. The separate verification-evidence-integrity.json records exact unchanged hashes against M1 and v1. The v1 root .prettierrc.json came from the reviewed pure candidate as a local formatting convenience. It was not necessary to runtime behavior and is removed from v2 to avoid unrelated configuration drift. V1 and its failed source-seal record are preserved.

### Temporal boundary: supported runtime versus arbitrary SQL role

Immutable results now retain a DB-derived lease_until copied only from the exact live job. Ordinary deferred graph checks re-evaluate current canonical source and newly accepted job/result expiry for the current writing transaction. Metadata-only deferral does not borrow these checks to infer source authority. These checks close the ordinary deferred omission; they do NOT guarantee that an unrestricted SQL role cannot drain constraints early, then idle until COMMIT. PostgreSQL triggers cannot re-arm themselves on arbitrary idle time without another guarded statement.

The PG suite deliberately records this unsupported counterexample as a successful raw COMMIT after early constraint drain and expiry. It also tests ordinary deferred expiry rejection, managed-runtime rejection after the same early-drain/DB-clock delay, and independently expired ancestor Media while a longer lease remains live. Raw SQL transition guards are defense in depth, not a universal temporal commit-owner capability. The admitted implementation path is the exact managed runtime with mandatory final owner/deadline checks and no caller-controlled post-final-validation SQL or delay. Production requires a separately reviewed least-privilege role/operation and commit-owner boundary. No role, grant, credential, security setting or claim of privileged-DBA resistance is changed by this candidate.

### Added adversarial owner coverage

The actual PG fixture now creates its generated author through native Identity initialization and genuine disposable lifecycle registration before publication. It seals the old inventory before installing M2, rather than pretending the new tables are accepted. Guarded causal request SQL supplies real cooling/erasing facts solely for race tests: held lifecycle mutation rejects processing, a late same-transaction mutation rolls back completion, and committed cooling/erasing rejects worker work without changing job/source/result. This is NOT AccountDeletionService acceptance or physical erasure. The real erasure preflight still rejects the enlarged catalog. Completed lifecycle remains retained-proof unit coverage only; the fixture does not fabricate an erasure completion.

The Media fixture uses actual registered synthetic image bytes, real Media prepare/processing/Review/binding, and a genuinely reviewed ordinary legacy image parent with v6 text-only descendants. Parent Media locks/revocation/expiry deny descendant processing/read; a Media change after optional lookup rejects the entire mandatory canonical read. No Media owner or proof is mocked. Reading-specific proof failure does not alter global jobs or canonical source.

The real-PG parent remains bounded at 240000 ms, all nested child work inherits that deadline, and the outer command is 300 s. Its connection statement timeout is 60000 ms so the real 30-second metadata backoff wait is executable; individual runtime owner reads keep their existing 1000 ms statement/5 ms lock bounds. The special managed expiry injection sets a 15000 ms test-only statement timeout for its DB-clock sleep. No stored lease timestamp is rewritten to make time pass.

### Historical v3 corrections to rejected v2

V2 remains preserved, not PG-admitted. Independent review found its lifecycle fixture tried to seal old deletion inventory after installing M1 source migration 0175, which the old registry correctly rejects. V3 applies the unchanged historical migration prefix through 0173, seals the real old inventory, then applies the complete unchanged M1 list through the normal checksum/prefix verifier, then installs the controlled draft. No erasure allowlist, migration SQL/checksum/order or enlarged-catalog qualification is changed.

Direct SQL scheduling negatives now assert immediate BEFORE-trigger SQLSTATE 23514 and the exact Invalid reading claim message, not deferred missing-slot failure. An invalid_payload quarantine has probe_count=0 to avoid masking by the separate probe-count constraint. Quarantine and future-probe cases preserve next_attempt_at; a separately eligible job tests retry-clock immutability. Actual retry deadlines correlate with next_probe_at by design; unchanged-clock and clock-rewrite cases cover that contract without pretending correlated fields isolate a redundant predicate. The eligible positive control forms its complete slot graph and forces constraints before intentional rollback.

V2 also had a critical real owner-wiring bug: all text-only v6 targets called the nonempty Media descriptor verifier with an empty list, which correctly rejects. V3 adds a separate Media-owned absent-binding method: managed transaction validation, native required Media epoch capture before a bounded exact empty-set read, and existing mandatory final epoch/table fences. ReadingSourceOwner explicitly selects this negative-proof leaf for empty images and the unchanged current descriptor leaf for nonempty ancestors. No global Media descriptor validation is weakened and no empty list alone grants authority.

Four small actual-class tests exercise the real Media leaf and ReadingSourceOwner with explicit SQL-result/upstream fixtures, including first-binding epoch change. They are not PG evidence. The PG Media fixture additionally captures absence immediately before a genuine first legacy binding, allows the real bind to execute, then requires final MEDIA_UNAVAILABLE rollback and a successful normal publication retry. The existing genuine v6 publication/enrollment case is the real happy-path check. Both were unrun at that historical handoff; the later named suite results are recorded above.
