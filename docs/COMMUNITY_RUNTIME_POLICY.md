# Canonical community runtime policy, increment 1

This increment enables local text publication and reads through the normal
`AppModule` providers when explicit canonical facts and an exact accepted review
exist. Empty migrations, login, successful historical receipts and rows labelled
`approved` create no permission or review evidence. Production verification,
selection, configuration and review issuance are not implemented by this slice.

## Owner boundaries and dependencies

- Identity still validates an active opaque session/account on every request and
  successful replay
- `LocalSafetyPhoneSource` supplies phone eligibility without phone values
- `LocalPublicationEligibilitySource` supplies independent affiliation state and
  internal assertion/snapshot, issuer and origin references. It never reads a
  student number; affiliation-only proof is sufficient
- Campus supplies immutable complete topology snapshots, exact identity selections
  and independently versioned regional configuration. Browse campus, institution
  names, public school codes and role grants are never membership authority
- Authorization supplies current fixed-region school-admin and global
  super/developer grants. Roles cannot fabricate phone, affiliation, identity
  selection, media ownership or content approval
- Safety supplies known current action restrictions. The real named-block wrapper
  remains around the new content-review base reader
- The leaf `ContentReviewModule` reads only community-owned approval/content facts
  plus active campus-region state. It does not recurse into community access or
  safety. Its private binding scope supports historical target management

Phone-only likes, votes, saves, update preferences and formation interactions do
not load affiliation or identity selection. Feed continuation requires current
session and phone, independently of permission to write. First-page/detail action
hints cannot introduce action-only phone/safety deadlines into ordinary reads.
Unknown phone status is unavailable rather than known unverified. The existing
first-ten guest preview and per-content visibility checks remain intact.

## Publication and management matrix

Verified regional posts require a valid current identity-campus selection:

- Home: named or anonymous for an eligible category
- Related: named or anonymous in an explicitly active same-subject region;
  same institution alone establishes no relation
- Foreign: named only. No invented user cross-region enable switch
- Global: ordinary discussion only, with immutable author-origin provenance

Verified roots/replies may be anonymous across regional boundaries. Own anonymous
post contributions are forced anonymous by the server. Known unverified actors
may post named only in explicitly enabled regional ordinary categories; unknown
configuration is unavailable and explicit disabled configuration denies. Regional
unverified comments use the region switch regardless of parent category, require
a named parent and remain named-only. The named-only comment restriction is an
existing deliberate tightening, not a claim of exact source policy parity.
Trading remains named/regional and outside the unverified post exception. There
is no global unverified exception.

`canManage` and `canDisableComments` are separate internal facts. A school admin
can restrict comments on a new post only in the fixed management region; global
super/developer grants cover their broader current management scope. Target
management uses the accepted post's immutable original region, or for a global
post its immutable author-origin region and known current subject group. An
unknown origin/group is unavailable when the exception is needed. Ownership or
management exceptions never skip ordinary publication/visibility gates. Related
synchronization is not supported and unknown synchronization request fields are
rejected. No related/global aggregate-distribution parity is claimed.

Public capability DTOs are unchanged. Authorized mode/comment-control hints can
be present, but normal runtime publication/comment availability stays
`unavailable` with `CONTENT_REVIEW_UNAVAILABLE` because no user-facing review
issuance workflow exists. `PostView.viewer.canComment` is conservatively false.
A trusted exact review already in the ledger can authorize an HTTP publication;
there is no client approval ID/header/flag or ordinary review writer.

## Exact review and visibility

A separate version-1 canonical SHA-256 digest covers actor, operation, exact
normalized text, ordered asset IDs/digests, space/category/effective author mode,
comments policy, post/root/reply target, complete poll/trading/formation definition,
and server-derived immutable scope. The scope includes applicable configuration,
identity-selection, affiliation snapshot/assertion and topology revisions.
Plain posts and root comments receive the same binding guarantees as structured
posts and replies. Existing publication receipt hash algorithms are unchanged.

Immutable explicit decisions reference immutable reviewed policy and provenance.
Each decision has a forward-only current event head (`allow`, `held`, `revoked`).
A canonical explicit rejection is terminal; missing, malformed, pending, failed,
expired or unreconciled review is unavailable. Only the explicit-allow taxonomy
is implemented. Source provider outcomes such as allow-with-review/notification
and label-specific block exceptions need a separately reviewed issuer policy;
provider errors do not become approval.

Publication atomically binds content kind/UUID/version to the decision, digest,
envelope and scope with content, receipt and outbox. One decision is consumed by
at most one resource. Its consumption deadline is separate from ongoing visibility:
expiry of an already-consumed permission does not remove durable approved content,
while current hold/revocation or ongoing validity failure stops visibility.
Existing receipt replay returns only the original minimal receipt even after
removal or later policy/affiliation changes and does not recreate content.

Every base read uses explicit `post | comment | reply` identity and version 1,
reconstructs the current canonical definition, verifies accepted binding/current
review, active space/region, publication/deletion/hidden state and required parent
bindings. Cross-table UUID collisions confer no authority. Mutable likes, votes,
saves, trading resolution and formation membership are outside the reviewed
publication definition; reviewed payload/asset/component changes are prohibited.
Formation members use the true parent for base authority and a separate named
relationship check, never a member UUID masquerading as content.

Named directional block rules still apply afterward: one-way list projection,
two-way direct/named interaction, and no hidden-author relationship reads for
anonymous subjects. Anonymous DTOs/errors contain no account, affiliation,
identity-campus, approval or provenance references. Missing historical bindings
remain unavailable; no backfill from a current profile, native report origin or
successful receipt is performed. Media upload/review/delivery remains the genuine
unavailable adapter. Successful acceptance is text-only.

## Transaction and writer protocol

The common safety-policy advisory gate is acquired **first**, shared by normal
reads/publication and exclusive by every policy-changing writer. Existing
ancestry locks remain post-before-root-before-reply, with active session/account,
owner heads, scope/component rows and exact request uniqueness retained. This
outer gate prevents inversions when parent approval visibility precedes a child's
identity/topology decision.

The new topology/configuration/selection and review evidence/head tables enforce
the exclusive gate with BEFORE STATEMENT triggers. A future multi-statement writer
must still explicitly acquire it before earlier `SELECT ... FOR UPDATE` or other
owner locks. Existing region/campus/assignment or role writers must follow that
same outer protocol; this increment exposes none. Read paths never create a
missing head. Topology's snapshot includes all edges, and selection binds exact
accepted affiliation and topology revisions; arbitrary fallback is prohibited.

Locked phone, affiliation, selection, configuration, selected grant and ongoing
review deadlines are registered and rechecked using a fresh database clock after
all deferred constraints. Rollback to a savepoint restores its previous deadline
checkpoint for publication, ballots, discussion, trading, formation and Saved.
No network/provider calls occur while holding transactional locks.

## Reproducible local acceptance

`community-runtime-policy.test.ts` boots real `AppModule` with no provider
overrides. Test-only helpers create real hashed sessions, complete synthetic
verification/selection/topology/configuration/review facts in a refused-unless-empty
loopback PostgreSQL 18.6+ `whaleu_test` database. They are neither imported nor
registered by runtime code. `community-runtime-client-contract.test.ts` separately
runs actual native gateways, decoders, persistence and controllers against that
normal HTTP application. Existing isolated fixture-port suites remain useful
focused tests; they are not the runtime acceptance evidence.

Coverage includes empty startup, home/related/foreign/global decisions, anonymous
cross-region roots/replies, phone-only interactions, unknown/known-unverified
facts, exact-field mismatch, missing historical provenance, immutable payloads,
review hold/revocation, consumption versus visibility expiry, replay, block/report/
removal, identity replacement and management scope. Real PostgreSQL regressions
exercise writer waits, deferred-constraint expiry and advisory versus mandatory
deadlines. Run the entire integration command serially against a disposable DB;
no suite may clean schemas until it has established exclusive ownership.

## Remaining release work

Real phone binding/protected storage/provider completion; affiliation review and
private provenance reconciliation; authorized topology/configuration controls;
ordinary own-account identity-selection API/UI; trusted review issuance, taxonomy,
queued obligations and activation; media ownership/review/delivery; related-sync
publication/distribution; historical schema/data import, restore/reconciliation/
rollback; provider and physical-device acceptance all remain explicit work.
No production accounts, grants, imports, provider activation or deployment are
part of this increment, and local synthetic acceptance is not full rewrite parity.
