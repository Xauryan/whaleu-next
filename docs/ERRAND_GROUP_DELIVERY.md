# Errand group delivery, E4 bounded synthetic contract

This E4 increment separates durable external-delivery obligations from Errands
and from existing local accepted/completed/admin notices. It is a bounded
development contract with synthetic external ports. Normal runtime remains
closed: `ERRAND_GROUP_RUNTIME` defaults to `null`, and no live provider,
automatic scheduler, CLI runner or destination-configuration writer is activated.
The acceptance matrix below is a verification target, not a claim that its cases
have passed. Exact candidate results must be recorded separately.

[E4a target-region services](ERRAND_TARGET_SERVICES.md) continue to own the public
group card and QR journey through School Configuration and Profile. E3 remains
the [public/private image-publication contract](ERRAND_IMAGE_PUBLICATION.md).
E5 remains authoritative migration and production reconciliation; this delivery
increment does not renumber or complete it.

## Pinned legacy evidence

The source is `WhaleUCampus/WhaleU` at
`57cf169c11123acf249909a1a7215b8cb1ec1f8e`. Source links establish the observed
business behavior, not authority to copy old infrastructure or credentials.

- [Tas.php, lines 34–42](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/command/Tas.php#L34-L42)
  runs once at startup and then every 900 seconds. Its
  [lines 56–66](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/command/Tas.php#L56-L66)
  execute the send command. This is the old cadence, not a scheduler activated by
  the new implementation.
- [SchoolGroupPushService.php, lines 65–96](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolGroupPushService.php#L65-L96)
  reads active positive-school `school_groups` rows. For each configured type,
  it expands `group_name` with numbers `1..max_group_number` and omits
  `excluded_numbers`. Public QR configuration is not this delivery source.
- [Errand selection, lines 1043–1080](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolGroupPushService.php#L1043-L1080)
  selects pending, unpushed, undeleted orders created at or after `now - 960s`,
  including the exact boundary. The publication's target-region snapshot selects
  its errand groups. The
  [dispatch loops, lines 900–973](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolGroupPushService.php#L900-L973)
  do not fall back to unrelated or default groups when that target has none.
- [Forum selection, lines 1165–1203](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolGroupPushService.php#L1165-L1203)
  requires still-pending, undeleted work, a prior errand push and no forum push.
  The first-push age is inclusively 900–1800 seconds. Forum recipients are that
  same immutable target region's configured forum groups.
- [Errand formatting, lines 1095–1134](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolGroupPushService.php#L1095-L1134)
  uses the complete first title line when there is a newline, otherwise the first
  28 characters; `¥` with two decimal places; unchanged expected-time prose or
  `尽快`; a source/cross-region label when applicable; and a detail locator.
  [Forum formatting, lines 1220–1249](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolGroupPushService.php#L1220-L1249)
  always truncates the first title line to 28 characters and omits expected time.
  Neither format includes order bodies, contacts, images or QR bytes.

### Intentional reliability corrections

The old round-wide `allSuccess` result controls
[aggregate push flags, lines 976–988](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolGroupPushService.php#L976-L988).
An unrelated failure can therefore leave already successful destinations eligible
for a repeat. The
[first-push write, lines 1142–1154](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolGroupPushService.php#L1142-L1154)
is made after the round rather than proven separately for each destination.
Moreover, the
[transport result, lines 662–691](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolGroupPushService.php#L662-L691)
treats any non-false cURL result as success, without proving destination receipt.

The new contract replaces those flags with per-destination evidence. Only the
first provable, confirmed errand-stage acknowledgement starts the forum delay.
A pending attempt, accepted TCP/HTTP exchange, another publication/stage's success,
timeout or old aggregate flag cannot fabricate that anchor. Successful destinations
are retained independently when other destinations fail. These are explicit
correctness improvements, not claims that legacy flags have stronger provenance
than their source establishes.

## Owners, enrollment and activation

[`ErrandGroupSource`](../apps/api/src/errands/group-source.ts) owns the narrow
sessionless projection of Errands publication, lifecycle, immutable source/target
facts and fresh delivery eligibility. `ERRAND_GROUP_SOURCE` resolves this actual
owner; it does not fabricate a publisher session. Notifications owns
[`ErrandGroupEnrollment`](../apps/api/src/notifications/errand-group/enrollment.ts),
[`ErrandGroupWorker`](../apps/api/src/notifications/errand-group/worker.ts) and
[`ErrandGroupRepository`](../apps/api/src/notifications/errand-group/repository.ts).

The typed [`ErrandGroupRuntime`](../apps/api/src/notifications/errand-group/contracts.ts)
requires `mode: 'synthetic-only'`, a `SyntheticGroupAuthorityPort` and a
`SyntheticGroupSendPort`; `SyntheticGroupShortlinkPort` is optional. Authority
owns the currently authorized external recipient set, separately from sender
readiness/acceptance and short-link generation. Destination and receipt IDs are
restricted to synthetic identities. The implementation ships no real sender.

[`0111_errand_group_delivery.sql`](../apps/api/migrations/0111_errand_group_delivery.sql)
adds four tables under `whaleu_notifications`: `errand_group_publications`,
`errand_group_deliveries`, `errand_group_attempts` and `errand_group_receipts`.
Attempt and ACK-receipt records are immutable. Publication/destination identity
and a destination's confirmed outcome cannot be rewritten into new work. The
publication's `first_confirmed_delivery_id` links its forum anchor to the exact
first durably confirmed errand delivery receipt.

- A genuine new publication enrolls its delivery obligation in the same database
  transaction, and only while the bounded runtime is enabled. Publication failure
  rolls enrollment back. Original-key replay does not create another obligation.
- The database enrollment guard binds the publication transition, pending order,
  exact target and creation timestamp to the current top-level transaction's
  `group_source_transaction` (`xid8`). This also works within the existing Errands
  request savepoint. Existing transition rows receive the migration transaction
  identity only; the migration never enrolls those rows. A later transaction
  cannot adopt an old transition as a fresh publication.
- Enabling the runtime does not enroll earlier publications, receipt replays or
  imported history. There is no backfill, synthetic legacy receipt or inference
  that an absent old delivery record means “never delivered.”
- The publication identity and its immutable source/target region facts remain
  stable. The publisher's later browsing campus, current institution or changed
  campus selection cannot retarget the work.
- Destination authority must be current, bounded and explicit for that exact
  target and stage. Missing, malformed, disabled or unavailable authority does
  not grant fallback delivery to a default region, related campus or arbitrary
  group.
- School Configuration's public QR, `joinUrl`, administrator contact and
  Profile's `showErrandGroupNotice` are presentation data/preferences. None grants
  permission to send to an external group. A `school_admin` role alone is not a
  destination source or provider grant.
- No source-backed destination-configuration HTTP API or writer role has been
  established here. Synthetic fixtures may supply explicit accepted authority;
  that is not a production management or import path.

[`ErrandGroupDeliveryModule`](../apps/api/src/notifications/errand-group/module.ts)
provides `ERRAND_GROUP_RUNTIME: null`. An explicit synthetic runtime override is
not an environment-variable rollout switch. There is no new public delivery,
retry, reconciliation or configuration endpoint and no automatically started
background process. The worker's internal `discover()`, `runOne()` and read-only
`inspect()` are inert when disabled. Ordinary `DatabaseService` is unchanged.

## Stages and eligibility

The business-time windows preserve the source's inclusive edges:

1. **Errand stage:** a fresh enrolled publication is pending and undeleted, with
   creation age from zero through 960 seconds. It targets only its publication
   target's currently authorized errand destinations.
2. **Forum stage:** the same publication is still pending and undeleted, and its
   first confirmed errand acknowledgement is 900–1800 seconds old. It targets
   only that publication target's currently authorized forum destinations.

No errand acknowledgement means no forum stage. The first successful destination
can establish the anchor even while another destination is retryable. A single
database compare-and-set freezes the acceptance timestamp (`confirmedAt`) carried
by the first ACK this system durably confirms: “首次被本系统持久确认的 ACK 所带接受时间”.
It is neither local receipt/reconciliation time nor the mathematical minimum of
all destinations' acceptance times. `first_confirmed_delivery_id` permanently
identifies that receipt.

Reconciliation may establish a provable old ACK after current eligibility or
authority has changed; recording that historical fact never authorizes another
send. If this is the first durably confirmed ACK, its original acceptance time
becomes the anchor. If its forum window has already elapsed, current known
forum destinations receive `expired` ledger records and no message is backfilled. Later ACKs retain their own independent receipts but never rewrite the
anchor or reopen the forum stage, even when their acceptance timestamps are
earlier. Each destination's prior confirmation remains terminal and cannot be
reset by another destination's failure or a configuration revision.

Expected-time prose is display content, never a deadline parser or an order
lifecycle transition. These delivery windows do not auto-cancel or delete orders.
Work outside its eligible window cannot become a fresh delivery merely because
a worker restarted, a lease was recovered or configuration changed.

A synthetic clock can advance these business-window cases without waiting in
real time. It cannot advance, freeze or substitute for PostgreSQL's actual clock
when checking account, Safety, Review, Media, destination authority or managed
transaction deadlines. Expired actual authority remains unavailable even when
the synthetic business clock says a delivery window is open.

## Durable delivery and recovery

The durable identity is **publication event + stage + stable destination**. The
repository hashes the `errand-group-v1` namespace and that tuple into its stable
provider idempotency key. A destination configuration revision is current
authority evidence, not a new delivery identity. Renaming or revising the same
destination must not replay a
confirmed delivery. Different destinations are separately accountable; no
round-wide success bit substitutes for those records.

The ledger starts at `pending` for newly enrolled, unclaimed work. Its result
vocabulary is deliberately explicit:

- `confirmed`: provider evidence establishes acceptance of this exact destination
  attempt/key. This destination is not sent again.
- `retryable`: evidence allows another bounded attempt under the same durable
  identity, after backoff and fresh authority checks.
- `suppressed`: fresh source/authority checks deny dispatch or the bounded retry
  budget is exhausted. The record does not claim provider acceptance.
- `expired`: the relevant business delivery window ended without a new dispatch.
- `unknown`: the prior external result cannot be proved. It is neither failure
  nor success and is never blindly retried as a fresh delivery.

Claims use PostgreSQL-clock 30-second fenced leases. Each discovery transaction
scans at most 32 publications and accepts at most 16 destinations per stage and
publication; `runOne()` claims at most one delivery. Claiming durably changes the
row to `unknown` before any dispatch, so an abandoned attempt is reconciled rather
than blindly sent again. Concurrent workers use locked claims and durable records
instead of starting a new in-memory round. A stale lease holder cannot settle or
overwrite a newer attempt.

Discovery rejects oversized, duplicate or wrong-scope destination input rather
than silently truncating it into a partial authorized set. The real legacy
configuration adapter remains an open gate; the synthetic authority supplies
explicit sets.

Retry backoff grows from one second to a maximum of 60 seconds. A retryable result
at an attempt count of eight or more is suppressed with reason `budget`. That
counter includes reconciliation claims, so this is an upper bound on send
attempts, not a guarantee of eight sends. Separate limits permit at most eight
reconciliation claims and 32 total claims per delivery. Exhausting reconciliation
does not convert an unresolved `unknown` into an invented terminal result.

An unknown result permits only exact same-key reconciliation. A provider without
an accepted idempotency and reconciliation contract cannot justify automatic
resend. Only a proven result can resolve ambiguity; absent proof does not become
success, “not delivered,” or a replacement key. A proven `not_accepted` result
returns the row to retryable work, or expires it when its business window has
ended, subject to the retry budget. Any fresh send then needs full reauthorization.
Business-window expiry prevents new dispatch; it does not turn an earlier
uncertain result into proof of failure. Unknown rows remain unknown after expiry
and may be reconciled within their bounded reconciliation budget.

The local ledger can suppress duplicate confirmed sends and fence stale workers.
It cannot promise exactly-once external delivery. Provider acceptance, response
loss, local commit failure and delayed reconciliation are separate facts, and
must stay separate in results and operational reporting.

## Public payload and locator

The source-grounded summary allowlist is title, formatted reward, errand-stage
expected time, applicable source/cross-region label and a detail locator. Forum
payloads omit expected time. Both omit public/private bodies, publisher/accepter
contacts, private participant facts, asset identities, image bytes and QR data.
No stored private text is copied into delivery rows, transport errors or logs.

The native fallback is the implemented route
`pages/errand-detail/errand-detail?orderId=<UUID>`, as registered in
[`apps/wechat/src/app.json`](../apps/wechat/src/app.json) and used by the
[`errand detail navigation`](../apps/wechat/src/errands/controller.ts).
Old `pages/fold1/...` paths and old integer IDs are not native locators. A locator
does not grant access: opening it still requires the normal current Errands
detail boundary.

Optional short-link generation must remain bound to this exact native locator.
Only a matching `nativeLocator` and the restricted `synthetic://errand/...` result
are accepted. Missing, malformed, timed-out or failed generation falls back to
the native path; it cannot fabricate a live short link, retarget another order or
expose contacts/body content to the short-link provider. `groupReward()` renders
two decimal places using exact decimal half-up arithmetic without binary-float
conversion. This display projection does not round or replace the canonical
exact decimal reward stored by Errands. The typed payload carries the two-decimal
amount; the legacy `¥` message decoration is documented above as source evidence.

## Last responsible authorization boundary

The bounded synthetic dispatch sequence is:

1. Persist/claim the exact attempt and its fencing identity.
2. Await transport readiness and, when configured, short-link work outside the
   source/authority transaction. `prepare()`, short-link `resolve()` and same-key
   `reconcile()` each have a three-second wait limit. Preparation and reconciliation
   must not emit a message, including after a timeout.
3. Start a fresh database authorization transaction. Read the actual Errands
   owner and current destination authority; prove the exact current lifecycle,
   immutable publication scope, current region labels, current publisher account,
   verified phone, whole-account Safety and applicable errand feature authority.
4. Consume real PostgreSQL-backed exact Review and the whole current E3 Media set,
   including public and private siblings, without exporting those private fields.
   Current held/revoked/unavailable evidence prevents dispatch; a previously
   approved publication or healthy single asset does not replace this proof.
5. Retain the owner, Review, Safety, Media, region and destination facts through
   the final transaction checks and commit. Revalidate actual deadlines after
   blocking work. A frozen `GroupPermit` has a 100-millisecond process-monotonic
   deadline established inside this transaction; final-proof/commit time consumes
   that budget. The permit is not persisted or reusable after restart. Only then
   immediately call the prepared sender's deliberately synchronous
   `dispatch(permit)` with the allowlisted summary and original attempt identity.
6. Persist the exact result under the still-current attempt fence. Preserve an
   uncertain result for same-key reconciliation.

Sessionless means no fabricated publisher bearer session or worker masquerading
as a user. It does not mean bypassing the current account, phone, Safety, feature,
content or Media owners. Publication-time eligibility alone is insufficient.
The proof must be obtained after all pre-dispatch asynchronous preparation; a
snapshot taken before a paused readiness/short-link call is stale evidence. No
awaited operation is allowed between committed authorization and synchronous
synthetic dispatch. The worker also checks the prepared sender's exact key,
destination and deadline, the permit's monotonic deadline, the real lease and
the current business window immediately before dispatch. An expired permit
cannot be renewed or reused to skip a new owner proof.

This boundary closes preparation-time races exercised by the synthetic harness.
There is still an unavoidable interval between database authorization commit and
external acceptance. An order can change or authority can be revoked in that
interval. No database transaction can atomically commit with an uncoordinated
provider. Production acceptance must explicitly resolve this delivery/revocation
contract; this increment does not claim that the race has disappeared.

Discovery takes at most 32 publication candidates per call and commits each
publication independently. Each commit retains at most two stages × 16 current
destination facts; a bad/unknown scope cannot consume another publication's
proof budget or roll back its progress. No destination is silently truncated.
Only scan bookkeeping advances after a failed scope, using real PostgreSQL time
for fairness even when synthetic business time is held still. No failed authority
is converted into an allow or empty-recipient claim.

## Target acceptance matrix

These cases are required evidence for this bounded contract. Their presence here
does not mean they have run or passed, and earlier E1/E3/E4a or unrelated hosted
CI results do not certify this candidate.

- **Enrollment:** real V1 and V2 publication transactions enroll once when enabled;
  rollback, disabled runtime, original-key replay and old/imported publications
  never create new work or backfill.
- **Timing:** exact 960-second errand boundary; immediately beyond it; forum at
  900 and 1800 seconds; just outside either edge; no forum before any proven ACK;
  first durable confirmation atomically freezes the exact linked receipt/time;
  no new anchor or reopened forum after a later or earlier-timestamped ACK.
- **Recipients:** immutable cross-region target despite a changed/current unrelated
  campus; explicit synthetic destination sets representing active numbered groups
  and exclusions; no default fallback;
  unavailable, disabled, removed, wrong-region and wrong-stage destination facts.
- **Identity:** mixed success/failure preserves successful destinations; restart
  and configuration revision/rename cannot resend confirmations; two workers,
  lease expiry and stale results respect durable identity and fencing.
- **Provider uncertainty:** timeout, response loss, malformed/ambiguous acceptance,
  local result-write loss and interrupted dispatch remain unknown; same-key
  reconciliation can establish the result without an unsafe new key/resend.
  Late reconciliation retains the actual old ACK timestamp; unknown stays unknown
  after window expiry; a first ACK confirmed after its forum window does not
  backfill; proven nonacceptance requires fresh authorization to resend.
- **Fresh authority:** pause readiness/short-link generation, then accept, cancel
  or delete the order; deactivate the publisher; change phone/Safety/feature
  authority; revoke Review; hold/revoke any public or private Media sibling;
  change region labels or revoke destination authority. The post-await proof must
  reject stale dispatch and use actual PostgreSQL authority time.
- **Final boundary:** a writer racing the final proof/commit cannot leak stale
  pre-preparation authority. Synthetic business time cannot mask a real deadline.
  Real lease expiry and the process-local 100-millisecond permit prevent stale
  or restarted use; each asynchronous external preparation/reconciliation wait
  has its three-second bound.
  The separate commit-to-provider race remains an explicitly open production gate.
- **Payload:** errand and forum title rules differ as sourced; exact decimal
  storage survives two-decimal rendering; default expected time and source labels
  are correct; bodies, contacts, image/QR data and private metadata never escape.
  Native fallback and any optional short link refer only to the exact order.
- **Activation:** ordinary AppModule/default runtime creates no external sends,
  scheduled work or configuration writer; existing local notices, E4a group card,
  Profile preference and E3 lifecycle/private-history behavior remain independent.

## Remaining E4 and E5 gates

- **Real destination authority:** source-backed configuration/import, stable
  external destination mapping, current proof/revocation semantics and an
  explicitly authorized management path. Public QR/contact data does not close it.
- **Live delivery:** accepted provider account/access, destination acceptance,
  idempotency and reconciliation evidence, transport timeouts/quotas, safe
  observability and operational recovery. No live provider is enabled here.
- **Scheduler:** accepted startup/cadence, bounded scheduling/overlap recovery,
  shutdown behavior and monitored backlog/expiry policy. The legacy 900-second
  cadence is evidence to preserve in planning, not proof of an active new runner.
- **Short links and native service:** live short-link behavior and the separate
  native customer-service capability remain unaccepted. Neither is replaced by
  an administrator contact or public group QR.
- **Supplementary article text:** the source's
  [4% probability and maximum three per school/day](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/service/SchoolGroupPushService.php#L53-L55)
  for official-account promotional text is a separate open parity requirement.
  It is not silently removed, activated or conflated with the errand summary.
- **Production safety:** provider-boundary revocation race, real Review/Media
  adapters, independent-account and physical-device acceptance, representative
  load/availability and deployment authorization remain open.
- **E5 migration:** authoritative schema, precision/timezone, identity/region,
  media, sanctions and notification/delivery history mapping; complete provenance
  reconciliation, dedupe/unknown-outcome treatment and restore/cutover rehearsal.
  Old aggregate flags must never be promoted into fabricated per-destination ACKs.

This remains partial errand parity and is not production readiness.
