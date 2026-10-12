# Scoped category reclassification: bounded implementation candidate

## Status and integration gate

Prepared on 2026-10-12 and composed on signed owner-visibility baseline
`660db0016b0b81d9c68574be55bb44841358ef4b`. The implementation candidate adds
0127, API/native management, exact Review and reader gates. Validation is in
progress; this is not accepted parity or production activation. No real issuer,
source policy, crosswalk, grant or approval is seeded.

0127 is a new forward-only migration. Existing migrations, original publication
bytes and signed 0126 owner/private visibility behavior remain unchanged. New
policy/issuer/Review tables are empty until explicitly accepted evidence exists.
Contracts and evidence interfaces are internal shapes, not verified capabilities.
Untouched unsupported posts preserve their original read/publication behavior;
unsupported reclassification does not disable trading/feedback or image reads.

## Source facts and unavailable acceptance

Legacy source is `WhaleUCampus/WhaleU` commit
`57cf169c11123acf249909a1a7215b8cb1ec1f8e`:

- `treehole/route/app.php:122`, blob
  `06311772deac64730b6399e446aebf4db884efaa`: `updatePostCategory` route.
- `treehole/app/controller/Message.php:3633–3719,4276–4301`, blob
  `bbdf415a864e5a4c060efe4111f2b83378118b40`: administrator/category command,
  trading exclusion, no-op, old/new distribution invalidation and audit.
- `treehole/app/service/AdminScopeService.php:103–177`, blob
  `a913afec5b8f7a3f3fe8bb9d41973f22c45eeafc`: regional scope plus additional
  synchronized/university-city cases deliberately outside this slice.

The Next enum and legacy labels suggest nine candidates, not accepted mappings:
2 discussion, 4 confession, 99 companions, 10 pets, 11 internships, 12 scenery,
13 dorms, 14 research, 15 deep_sea. Do not create production acceptance from this
list. Missing IDs 5/6/9/71/72 stay missing. No global/feedback/trading moves,
related-campus redistribution, imported history or component expansion.

First simulated journey uses an explicitly synthetic, accepted pets(10) ↔
scenery(12) crosswalk and exact directed transitions. Test all nine only under
explicit synthetic policy. Real availability requires authoritative accepted
crosswalk, transition/applicability/descendant semantics, issuer and scoped grants.
No real policy, grant or acceptance is seeded. Engineering simulation needs no
new product decision; real activation must stop on missing evidence.

## Smallest coherent end-to-end slice

1. Native approved named text-only posts, component none, regional original scope,
   sync none, v1/v2 original publication, anonymous-DM false/absent. Reject anonymous,
   image, poll, formation, feedback/trading payload, global and imported moves.
2. Separate immutable change event + monotonic CAS head + exact reclassification
   Review. Original `posts.category`, publication envelope/hash, children,
   Media descriptors, receipts and creation identity never change.
3. Exact original-region school_admin or global super_admin authority, deriving
   original scope server-side. A developer grant, author ownership, current browse
   campus, inferred related region or pin permission does not grant this action.
4. Existing children require explicit accepted continuation of a complete
   immutable exact-allow original approval bound before the first category head.
   That evidence does not claim the child was publicly readable then: hidden or
   temporarily held children may later pass the normal current Review/Safety/Media
   gates. A row without its complete original binding cannot acquire it after
   the move to masquerade as historical approval. First accepted simulation
   includes this continuation rule.
5. New post-move comments/replies keep their original-category canonical Review
   and also obtain a distinct exact current-parent context Review binding child
   identity/digest, parent event/revision/policy and command. A later parent move
   must cover continuation of those approvals too. Reject moves with children
   when continuation is absent. Do not call a comments-disabled move full parity.
6. Wire native management and original-key recovery only after SQL/Review/public
   projections agree. No reward, notice, publication replay, Media detach or
   identity replacement. Move-back appends another event, never removes the head.

## Event, command and proof owners

0127 introduces immutable policy/source acceptance history plus current
head, exact purpose-specific Review decisions/bindings, category event/head,
command/audit/receipt and durable cancel fences, and supplemental child-context
bindings. Its purpose-specific evidence does not replace the original content
Review or Media owner. Issuer and policy acceptance timestamps cannot be in the
future: this bounded slice consumes already accepted evidence, not scheduled
activation. Future superseding exact Reviews fail closed immediately: the newer
exact intent suppresses an older bound decision without waiting for its timestamp.
That old binding never revives when the future time arrives. Consuming the new
Review still requires a new event or child binding, whose write advances the
visibility epoch. This differs from an unbound candidate policy automatically
appearing in the management selection set.

Persist actor + original request UUID + materialized exact command + domain-separated
hash. Acquire request lock before Safety/content locks, align ordering with pins,
deletion and signed 0126. Fresh positive commands require current fixed-scope authority even when their
expected revision is stale. Stale expected revision rejects even when target
equals current category; already recorded receipts remain recoverable without
current administrative authority. A valid same-category request records `unchanged` at the same
revision/event; it does not append an event. An applied move increments once,
using affected-row-checked O(1) CAS, including revision-zero head absence. ABA is
revision plus event identity. Receipts alone never authorize content reads.

Deferred constraints enforce exact original and previous head, target, actor/key,
transaction, grant, Review, event, head and receipt consistency; append-only audit
and no orphan/reused events. A no-op cannot mint a new classification approval.
Recovery returns immutable result under the same actor/key without reapplying.
`not_recorded` is a snapshot, not permission to generate another key. Durable
cancel fence and recovery must resolve the old key before replacement is allowed.

Public population readers retain Community/Campus/Safety epochs and register
all new visibility sources in canonical Community epoch ownership. Management
and positive commands use selected-parent locks and exact external input facts
instead of unrelated Community activity. Preserve the original input facts across
the command's own head write; re-registering must never recapture a changed
source. There is no assumed authorization epoch: retain selected
account/session/token/grant fingerprints and nonblocking bounded writer fences.
Original-key recovery/replay/cancel require only current identity authentication,
actor/key/hash and the durable receipt fence; they do not gate on current content,
classification, Safety, Campus or administrative grants. Verify original/current
Review and source acceptance, validity intervals and all exact database deadlines.
A separate-reader final fence follows deferred constraints, with database time
checks last. Preserve both prior absence evidence and intended post-write head.
A missing, expired or revoked current overlay/source/Review is unavailable; never
fall back to original category. Owner-hide, deletion and raw writers invalidate
preflight evidence. Unhide cannot revive a revoked classification. Initially deny
new admin moves on owner-hidden content rather than adding content-read bypass.

## Reader inventory and coherent filtering

Before wiring, inventory all category uses again on signed 0126. Preserve original
category in publication and `content-review/definition-validation.ts`, including
comments/replies, and original component-specific canonical checks. The following
existing consumers need classification-aware policy/filter/projection assessment:

- feed.service, community-serialization, profile-discovery.facade
- search/repository, search/service, search/serializer
- content-review/search-eligibility.facade, count-snapshot.facade,
  discovery-counts, hot/repository and hot/service
- post-pins/service, discussion/publication-target and publication.service
- saved/liked/update previews, notification targets and every parent/child Media
  descriptor/final-byte path, even where category is not directly read today
- trading/feedback readers must retain unsupported untouched behavior and must
  never accidentally accept reclassification through a shared enum

Do not replace every `p.category` or `post.category`: some are immutable evidence.
Current category must filter candidates and aggregates before pagination, not
merely relabel DTOs. Candidate enumeration uses structural original/head metadata;
canonical original Review and bounded current-head proof remain mandatory before
output or counting. Profile posts/trade membership retains the original indexed
scan because every permitted original and target category is non-trading. SQL and
contract tests pin this nine-category invariant; any expansion must reassess both
profile scans rather than silently crossing the partition. Use bounded
indexed current-head/original-category selection; retain existing exact counts,
scan budgets and cursor guarantees. Epoch/revision belongs in snapshot/cache and
cursor scope. Query plans must demonstrate no N+1 proof loop, unindexed global
scan or per-move descendant rewrite. If an exact proof cannot finish in budget,
report unavailable, never an approximate count disguised as exact.

Original proof precedence remains owner-specific. A newly added classification
gate must not turn an original Review unknown at the node being checked into a
known denial or exact zero. Existing parent-first readers (including literal
search and liked pages/counts) still stop after a known parent denial; they do not
expand an otherwise denied child merely to discover an unknown leaf. Standalone
leaf canonical and semantic certificate evaluation retain their complete ancestry
checks. This does not weaken any original Review check previously required by a
reader.

Pins retain pin ID, regional reserved slot, expiry and read markers. Only current
category filters can expose them while independent pin and parent policy allow.
Owner-hidden posts stay absent from all public projections even to their author;
private detail needs all normal original/current classification checks. No-op,
replay or recovery cannot unhide or disclose body/anonymous author identity.

## Required tests before calling the slice accepted

- Contract: strict keys; server-only actor/scope/grant/category rejection; UUID and
  integer bounds; all nine candidates; excluded categories and unknown IDs;
  metadata-only receipt schema; stale same-target versus authenticated no-op.
- SQL: wrong original region, developer-only/wrong role, expired selected grant;
  absent/malformed/revoked policy/crosswalk/Review; raw event/head/receipt writes,
  orphan rows, event reuse, wrong transaction/target; zero-row CAS; two-admin
  contention; ABA/move-back; exact original hash/envelope/rows unchanged.
- AppModule + disposable PG + emitted native: pets → scenery → pets; old filter
  disappears/new appears; feed/detail/history/profile/hot/search totals and cursor
  pages, saved/liked/update previews and pin filters agree, including preselected
  candidate/count snapshots. Same pin ID/slot/read state; no reward/notice replay.
- Descendants: existing approved comment/reply, independently revoked child,
  applicable child Media; explicit continuation absent rejects move; new child
  original canonical plus supplemental current-context approval succeeds; missing,
  stale, substituted or revoked context rejects; later move and move-back history.
- Races: source/Review withdrawal and in-flight grant withdrawal after preflight and during waits, expiry at
  final DB deadline, absent-head insertion/raw writer, owner hide/unhide, deletion,
  category mutation between candidate/count and response, Media open/final bytes.
  Assert no wrong-category item/count/byte leakage or false fallback.
- Recovery/native: duplicate tap; persistence/write-readback failure; lost response;
  cold restart; same key/different body; unknown receipt and cancel race; account/
  origin change and late callbacks. Never silently replace an uncertain request key.
- Regression: original canonical Review checks unchanged; complete signed 0126
  owner visibility/count coverage; pins, discussion, components, Media, search,
  saved/liked/updates and source revocation; bounded-query explain plans.
- Final owner-coordinated frozen-tree lint/type/OpenAPI/build/native/PG pass only
  after the existing heavy lane is free. Do not claim focused static checks as
  a whole-project or journey pass. Keep production/provider/history/device gates.

Stop after the identified bounded simulated journey and impacted regressions
pass on one frozen tree. This document alone does not reach that stop.

## Durable authority versus current content policy

The legacy command proves administrator authority when the move is committed.
It does not establish a perpetual dependency on that administrator keeping their
role or session. Each event therefore captures a server-derived immutable
selected-grant snapshot, checked against the live exact grant at insertion and
at deferred completion. The API retains selected session/token/grant fingerprints
and exact lifetimes through its final fence. No client-provided snapshot is trusted.

After commit, revoking that administrator's grant or session does not hide the
post or change its category/count. Fresh management and commands still require
current authority. Current original/new Review and transition policy remain
revocable content gates: withdrawal/expiry suppresses an existing overlay without
falling back. There is no role-grant-to-Community count trigger or perpetual grant
read join. Current-grant checks are confined to command/capability paths.

## Concrete Review envelopes and simulated issuance

The migration's post_category_command_envelope constructs a distinct exact-purpose
approval envelope from actor/original request/command hash, selected grant ID,
original canonical decision/digest/envelope, previous head event/revision/category,
requested target and accepted policy identity/revision/digest. API and SQL compare
that complete envelope and its domain-separated canonical digest. No generic
publication approval substitutes for this decision.

New comments/replies retain their original canonical approval. A supplemental
post_category_child_envelope signs that original decision/digest/envelope and
actor/original request plus exact current parent event/revision/category/policy/
Review. A same-transaction immutable binding attaches it to the generated child
identity and original publication receipt. This avoids changing old hashes or
requiring a destination category in the canonical original envelope.

Accepted test helpers explicitly issue synthetic decisions for these exact
requests. There is no production Review provider, automatic approval, synthetic
production mapping, or inferred acceptance. Real activation remains unavailable
until authoritative sources and an exact issuer workflow are supplied.
