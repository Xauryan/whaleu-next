# Generic Ratings discussion images

Status: complete frozen-tree local acceptance passed; hosted verification is pending. Production providers and device transports remain unavailable. Generic Ratings and specialist parity are not declared complete.

## Independent protocols and legacy evidence

Discussion command/context 4, Review 7, Media 7 (`ratings-discussion-media-v1`) and
native journal 12 are independent of target cover command/context 3, Review 6,
Media 6 and journal 11. Journal 12 is solely discussion recovery. Historical
codecs, hashes, receipts and migration files retain their existing byte domains.

Root comments allow nine ordered images; replies allow three. Empty canonical
body requires at least one image. Nine roots matches the legacy API capacity and
is an explicit improvement over the shared legacy UI's three-image picker.

Fixed evidence:

- [Legacy RatingService](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/RatingService.php)
- [Legacy shared composer](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/miniprogram1/components/comment-input/comment-input.js)

A same-root `replyTo` is an opaque reference, not a recursive ancestor. Its
publication CAS is exact; later deletion does not delete replies quoting it.
The required current chain is Category, target, root, subject and their complete
Review/Media evidence. A thumbnail is selected only after every image is authorized.

## Connected server paths

- `/v4/ratings/discussion/contexts` issues an explicit read/interact context4.
  Entering discussion from a random cover3 target requires this new context.
- The composer-context endpoint reads current Category/target/definition/root CAS
  without borrowing the creator-only target editing route.
- Prepare, commit, cancel and receipt routes delegate to the original
  `RatingScopedCommands` and shared request claims. Publication uses the existing
  comments/replies, exact Review consumption, original transitions, effects,
  notification/subscription obligations and receipt in one transaction.
  Scrubbed recovery can cancel by original operation/hash without retaining text,
  images or context credentials; its metadata-only cause cannot publish content.
- Media7 batches, member requests, sequential uploads, sealing and original-actor
  recovery use the shared Media intents, fences, lifecycle and transport. Neither
  a ready member nor a sealed batch publishes content.
- List/detail/thread/reply/anchor routes use separate image DTOs. Legacy required
  DTOs cannot silently expose a text-only or empty projection of Review7 content.
- Like and subscription materialization qualify each recipient independently.
  Worker-only media preview evidence is explicit. Legacy preview DTOs remain
  unchanged; the new optional notice-detail contract returns complete content or
  `unavailable`. The old scoped metadata list is unchanged.
- Authenticated downloads authorize the real chain and complete ordered set twice.
  They cannot authorize one image using only its own manifest or thumbnail.
- Original root/reply/target deletion creates independent durable cleanup jobs
  only for immutable historical media appearances, including detached bindings.
  Text-only Review7 and legacy text have no Media cleanup sidecar obligation.
  UUID-keyset pages enumerate hidden and already-deleted descendants; detached
  bindings feed the shared Media lifecycle. Logical enumeration completion never
  claims confirmed physical object absence.

The ordinary Ratings module, included by AppModule, registers these paths with a
null Media runtime and no source/adoption or Review issuer. The independent
capability registration binds schema, routes, native acceptance, limits and an
adopted source generation. Absence or stale evidence is unavailable. Synthetic
capability registrations and Review decisions exist only under test support.

## Proof and resource boundaries

The server retains one shared 64 MiB metadata ledger. All delivery owners use the
same 64-credit global pool and two credits per authenticated account. These are
separate from the native shared two IO, four leases and 10 MiB file budget.

A narrowly scoped mutation collector re-reads the exact whole ancestor sets after
its own writes before retaining the final Media proof. It cannot erase a proof
read outside that mutation. Savepoint rollback invalidates the old transaction
epoch. Unknown, cancellation and native completion remain separate states.

## Native and acceptance work

Strict native command/context, batch/sealed-plan and metadata-only two-key journal
contracts are implemented. Historical v1-v11 pending or corrupt records block
new writes; their original recovery has priority. Sequential upload and small
download windows use the shared local-file registry. Actual app-level adapters,
controllers, discussion pages, notification entry and legacy recovery routing are
connected and covered by local acceptance. Cold-start recovery retains
only receipt/cancellation authority; it does not restore an unsubmitted body.
A failed storage rewrite cannot establish that residual disk content was erased.

Synthetic contract, whole-set, Media proof/delivery, journal/window, SQL parity and
real-owner HTTP/PG focused checks have passed. They cover raw SQL owner forgery,
rollback, concurrency, Review7 withdrawal/hold, capability expiry, zero-row/ABA
final proofs, actual target deletion with 16+4 historical cleanup pages, and
real Profile/discussion server64 and account2 delivery combinations. The focused
HTTP-stub native state-machine suite is separate from the real
AppModule/ScopedCommands/Media independent-process SIGKILL cold-recovery suite;
both have passed, followed by the complete final-tree regression gate.
No real model, COS credentials, Review service, production data or real-device
result is claimed.

## Validation corrections and final acceptance

The first complete PostgreSQL run ended normally with 2,378 passes and 31
failures; it is not acceptance evidence. Corrections retain the old fixtures:

- The existing Media zero-row/raw-writer matrix now includes all four new owner
  tables, preserving the original twenty sources and assertions.
- The new predecessor clone explicitly remaps its old implicit PL/pgSQL function
  qualifier. A real 0082 upgrade verifies all ten cloned bodies, call references,
  owner/ACL, language, security attributes and search paths.
- Independent-process crash checkpoints keep the child alive until the parent
  delivers and verifies SIGKILL; normal recovery still exits normally.
- A failed delivery-fixture finalize returned closed `RATING_UNAVAILABLE` at a
  navigation-epoch NOWAIT fence. The original lock holder was not established.
  A mandatory real maintenance-style lock test now verifies the first 503,
  unchanged uploaded state, no asset or receipt, and original-identity recovery
  followed by exactly one publication.

Only the shared-delivery budget fixture may recover an uploaded prerequisite
once across its nine members. It requires exactly 503/`RATING_UNAVAILABLE`, an
independent database proof of unchanged prepared/observed state and original
hash, and zero job, asset or business receipt. It then reads the original upload
request and finalizes the same member once. It records bounded first-failure and
recovery diagnostics; any other error or second failure fails the test. This is
not a general retry helper. Product APIs, lock modes, deadlines and PostgreSQL
maintenance settings are unchanged.

The corrected frozen tree `d94a624f2a4464dab8e74077fe6d39c32bc7c633` passed all 6,443 tests: 5 statistics, 20 search evaluation, 1,525 API, 2,400 native, 2,451 real PostgreSQL and 42 optional semantic cases. Every group reported zero failures, cancellations, skips and todo cases. Lint, typechecks, formatting, offline OpenAPI, build and all emitted Page/WXML smoke checks passed. All 2,262 source hashes stayed unchanged throughout. Main PostgreSQL took 4,068.053 seconds and semantic took 49.873 seconds. This is a complete same-tree rerun, not a composition of focused results. All 82 historical main and two optional SQL migrations remain byte-identical.

An earlier frozen candidate passed its tests but failed emitted native build because three SHA imports were missing from the vendor mapping; the product build list and mounted discussion-page smoke were corrected before the complete rerun. Earlier failure logs remain preserved. Hosted verification of this slice remains pending.

### First hosted run and aggregate scheduling budget

The first hosted run on `bf8bd6f4` reached the 4,500-second aggregate PostgreSQL command limit and exited 124. It reported 2,232 tests: 2,209 passed, zero failed, and 23 cancelled; the remaining suite was not completed. This is a failed hosted gate, not a pass. Cheap checks (3,950) and semantic checks (42) passed separately. The last completed database leaf finished less than two seconds before cancellation.

The preceding target-cover hosted database run took 71m24s. Newly completed discussion groups added about 168 seconds, while comparable older groups took about 238 seconds longer on this runner; the resulting full-run estimate exceeds the previous 75-minute cap. The aggregate PostgreSQL command budget is now 6,000 seconds and the enclosing job budget is 120 minutes. No individual test timeout, SQL lock/statement deadline, authorization proof, lease, resource limit or test assertion changes. The replacement hosted run must finish successfully before hosted acceptance is claimed.
