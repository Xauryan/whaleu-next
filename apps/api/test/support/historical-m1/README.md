# Exact M1 historical-producer / current-reader compatibility

This directory is test-only. It is not a production fallback, a current
registration acceptance lane, or a claim that today's complete writer/runtime
can deploy on 0175. Current production acceptance must install the complete
migration set, including the registration guard. No current guard is disabled.

## Historical provenance

- `identity.repository.ts` is the complete lifecycle-aware Identity owner from
  `2f9f77260119664af3a06c488963153fdc12dab3`, Git blob
  `b1104ba337eb15f290c9330cd307b523804a1938`, SHA-256
  `1d0b8d9f79bb95b0884baa26dcf7788ea028f6d8521be1d8282db9fe4dd8c446`.
- `publication.service.ts` is the complete pre-Home PublicationService from
  `f21bd371680c84849c92ac2360607f2084f2b56e`, Git blob
  `4b6686991f12f326856169c6ca648d7f91e99ee1`, SHA-256
  `2fa72f4f3bd71874fb0eaac4529225158dbf616a40202b925a18def65d17440f`.
- Only relative import locations changed in the three complete saved sources. The provenance
  unit reverses static and dynamic-type imports, then checks the complete
  SHA-256 and Git blob identities. Their dependencies bind the current source
  tree and are explicitly reviewed below, not implicitly claimed identical.
- `text-source-publication.ts` is the complete f21
  `src/community/text-source/publication.ts` module, including the original
  `withReviewedTextSource`, `requireOrdinarySourceParent` and source capability
  helper. Git blob `82d832dea030e763ad832a0007da27308c96a1ac`, SHA-256
  `51a99a1f741422248f2d96587a4dcb330e6acabf8221943a27f5158346247825`.
  The original parent function-body SHA-256 is separately checked as
  `4f2d6ee2546e16a4e6b6de4a0ffcbd9128b1389f098b762f8472f07dac09c274`.
- All 175 migration files match both predecessor trees and the reviewed current
  baseline `fedf39f0bddbfb3974adb3ab88c542121c2fa137`. Their ordered
  `[{name,checksum}]` JSON digest is
  `10a178660bb2cb8188ac7f6eba4b2feb612f20fe450bdbf65d1c8e0f32a4d779`.
  Neither partial prefixes nor later ledger rows qualify.

## Composition and retained boundary

The test root imports current ConfigurationModule, ObservabilityModule,
AccountPolicyModule and CommunityModule. It does not copy/freeze AppModule.
The historical producer replacements are IdentityRepository, PublicationService
and the source-helper module mapped at exactly two producer import edges. Current Review/operator, publication receipts, source
storage, native HTTP routes, access authorization and all six native reader
projections remain real implementations.

The current reply writer first calls the real `authorizeDiscussionPublication`
(`discussion/publication.service.ts` at the reviewed baseline, lines 90–101).
It then calls `approval.requireSourceParent` (line 104). The f21 reply writer
instead called `requireOrdinarySourceParent` directly after the same canonical
access proof (lines 91–105). The test-only PublicationService subclass supplies
that extracted method using the exact f21 helper body. It retains the original
`FOR SHARE OF p` narrowing SELECT, limited to versions 1/2/6. It excludes
feedback/trading, non-open comments, anonymous-DM opt-in, category heads,
owner-hidden roots, polls, formations, trading, rating cards and related roots.
It is never authorization by itself. The current helper adds version-7/Home
semantics and is deliberately NOT used for this adapter.

Both the frozen PublicationService's comment path and the current reply
writer's source composition use the complete original f21 helper module.
`loader.ts` maps only these two exact parent-module URLs' imports of the current
source-helper URL. All other imports, especially native readers, capability
controllers and the ordinary current PublicationService, remain untouched.
The hook is installed before dynamic composition imports; its resolved target
must be the exact saved module, and both expected edges must have been observed
before Nest compilation. Preloaded producers or unexpected resolution fail
closed. The hook is deregistered in `finally`; test processes are isolated.
Producer source bodies and their relocated import specifiers are not rewritten
by the hook. The full helper's original V6 selection, V7/V8 source rejection and
ordinary-source restrictions are tested independently. The integration test
asserts the actual stored V6 version, canonical text, descriptor, source digest,
original intent hash, Review digest, immutable binding and original receipt for
every publication.

The database wrapper uses the real managed transaction implementation. A shared
transaction-scoped official migration lock, ledger SHARE lock and existing
owner-table ACCESS SHARE locks survive through final proof and COMMIT. The
exact ledger is checked, lifecycle columns must exist, and recognized
Reading/Home/registration relation, function, type, trigger, constraint and
column families are refused. This is a finite historical test boundary, not a
general certificate against arbitrary hostile catalog rewrites. Checks are
cached only for the same transaction lifetime/read epoch; required proof is
re-enrolled on cache hits and after savepoint restoration. The final check is
retained after deferred work, without changing any owner deadline or budget.

The helper admits only NODE_ENV=test, loopback `/whaleu_test`, PG SSL disabled
without any URL query overrides or fragment, and checks current_database() in
the retained transaction. Synthetic registration accepts only the fixed test
app ID, a UUID-v4 subject and two distinct token hashes. Inputs must be plain
own-data objects with exact keys, no accessors, inherited identity fields,
nonenumerable fields or symbols; frozen copies are passed to the saved owner.
Accounts and decisions are never inserted as fixtures. Existing synthetic
scope/verification fixtures remain explicitly synthetic.

## Current dependency review

`provenance.json` pins 51 direct/seam source dependencies at exact fedf39 (unchanged from f578). The
unit rejects an unreviewed import, missing file or byte change. Ten direct
imports changed from their producer predecessor:

- `config/config.ts`: adds registration guard mode/key-ring parsing. The
  historical test uses current parsing and normal defaults, never an environment
  switch to disable the current guard. Only the saved pre-179 owner is injected.
- `community/contracts.ts`: adds readable `water` taxonomy while HTTP authored
  post categories retain the legacy schema. Existing CRLF source normalization
  remains current. Tests preserve surrounding whitespace and decomposed Unicode,
  reject text-changing replay, and accept equivalent CRLF/LF replay.
- `content-review/contracts.ts`: adds Home envelope variants/canonicalization.
  The f578 addition is an image-omitted discussion draft parser; every prior
  canonical/final-envelope byte is unchanged. Version-6 canonicalization and
  digest validation remain real, and exact
  stored/displayed V6 envelopes and digests are compared.
- `text-source/protocol.ts`: adds composed-source intent reconstruction; the
  V6 original-intent function remains the saved protocol and is explicitly
  compared with request/source storage.
- `text-source/publication.ts`: adds Home branches and the broader version-7
  parent proof. This current module remains unchanged for current consumers.
  The two producer edges are mapped to the complete separately pinned f21
  helper module, so both comment and reply use the original narrowing semantics.
- `text-source/repository.ts`: adds version consistency validation and composed
  Home cases; actual V6 insertion still requires the accepted decision/hash and
  genuine migration-0175 immutable/deferred SQL constraints.
- `text-review/runtime.ts`: adds Home admission only for versions 7/8. Actual
  V6 source-only policy, request, decision and withdrawal remain current. Other
  policy initialization and wrong operator identity are rejected in integration.
- `publication.repository.ts`: broadens source-only admission to composed
  source envelopes; the test asserts V6 throughout. Current reading enrollment
  legitimately returns false only for a completely missing reading owner.
- `community.repository.ts`: widens the stored envelope type with version 7;
  no historical SQL owner is substituted here.
- `related-sync/service.ts`: adds conditional Home distribution proof for
  canonical version-7 roots. These local V6 publications do not select that
  branch; all existing local access/distribution authorization remains current.

The f578 current reply writer replaces premature empty-image canonical parsing
with that draft parser. Its access authorization, original source-parent call,
owned-media/Review approval and subsequent writes are otherwise byte-identical
to 5c1002. The frozen historical comment producer is intentionally not rewritten
to adopt the new parser. Both still reach complete canonical validation in the
pinned historical approval owner; no current writer-on-0175 guarantee is implied.

Additional pinned seams include the current reply writer, Home publication
metadata helper (returns without SQL for V6), source normalization, Review
operator/approval/definition owners, current reading-schema readiness and
current native reading controller/service/contracts. No reader is stubbed.

## Evidence and limits

`historical-m1-provenance.test.ts` is database-free. It checks full-source
restoration, hashes/dependency inventory, exact migration manifest, rejected
configurations, immutable synthetic input snapshots, retained/final fences,
savepoint rollback behavior and the original parent helper's rejection branch.
It tests mapping scope/unexpected-resolution rejection and performs an actual
Node24/tsx import-only hook smoke test for both producers, without constructing
Nest or opening a database. Mocked SQL-boundary tests are not PostgreSQL or contention evidence.

`integration/text-source-m1-compatibility.test.ts` requires a disposable PG18.6+
loopback database. It uses real migrations, source-policy operator decisions,
HTTP review/publication and all six current native reader endpoints for plain
auto, plain off and authored Markdown. It checks canonical original source,
immutable Review/source storage, replay/conflict, unauthenticated access denial,
root withdrawal/descendant denial, rejection receipts and no fabricated formatted
presentation. Complete absence of 0176/0177/0178/0179 is checked before and after.
The test is a compatibility lane, not the production TLS/PTY acceptance lane.

## Checked legacy authorization import boundary

The full API typecheck of the prior fedf39 candidate correctly rejected its
mixed historical/current category type. The unchanged current authorization
implementation infers `StoredPost.category` from current `Category`, which now
includes Home `water`. In f21 both that category and legacy envelope drafts
excluded `water`; this mismatch was introduced by composing old and current
contracts, not by the historical producer's original runtime envelope behavior.

Only the frozen producer's publication-target import is relocated to a checked
test-only adapter. It first awaits the real current authorization without a
catch or fallback, then validates the returned category using the legacy schema
and refuses envelope versions outside the historical optional 1–6 range. It
preserves all other target fields and re-exports the real media wrapper unchanged.
No cast, type widening, alternate authorization or production fallback is used.
The provenance unit reverses exactly this one declared adapter edge along with
ordinary relative relocation and still recovers every original f21 body byte,
SHA-256 and Git blob. Explicit negative units reject water and Home versions
7/8 and preserve an actual authorization denial. The exact175 retained schema
fence still applies; this does not add a current writer-on175 deployment claim.

## Preparation-only 0181 shared dependency successor

The original `provenance.json`, source snapshots, complete 51-dependency inventory,
and every recorded predecessor hash stay unchanged. Only the current config and
error-map dependencies use explicit test-only restorers before comparison to
those existing pins. The helpers accept one exact 0181 successor each, remove
only a unique anchored addition, prove the full predecessor SHA-256 and Git
blob, and replay the complete successor bytes. They are not generic hash
allowlists or source evaluation, and they do not admit 0182 acceptance/cancel
configuration.

`historical-preparation-dependencies.test.ts` checks the accepted historical
config projection, enrollment/source-manual/registration behavior and negative
controls for changed defaults or guards; all 308 old error conditions and both
specialized classes; and the three new sanitized error envelopes. The current
preparation field defaults to disabled. All other 49 direct dependencies retain
their ordinary exact byte checks. This successor is separate from the earlier
recorded b531/f578 review and makes no new current writer-on-0175 claim.

The exact175 catalog fence also rejects the exact new `whaleu_real_deletion`
namespace, even empty or unledgered. Its older predicates and retained/final
migration fences remain intact. Pure source tests prove this additive change
restores the complete prior boundary source; PostgreSQL controls separately
cover all eight partial0181 namespace/table/function/trigger identities,
lookalike namespace acceptance and rollback restoration. Those PG controls must
run on the composed candidate before claiming new-stack compatibility.
