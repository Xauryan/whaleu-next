# Local experience, sign-in and owned appearance

This is a partial development implementation. It adds an owner-only experience
ledger, fresh community reward enrollment, daily sign-in, informational tasks,
levels, owned titles and color selection. Production processing, historical
balance reconciliation/import, received-interaction
metrics, complete-population ranking, redemption, global title administration and physical-device
acceptance remain separate gates. Test evidence is recorded independently.

## Evidence and ownership

A genuinely new account receives a known zero opening balance, known absence of
prior sign-in, and the registration entitlements `default_jingxiaoyu` and
`level_1`. Both selected title and color start null. SQL requires creation of the
identity account and native experience baseline in the same transaction.

Existing or otherwise unproven accounts remain `baseline_unknown`. Missing rows,
login, a current profile or a new record ID cannot establish an opening balance
or sign-in streak. Unknown balance, level, progress, streak and quota values are
null. Fresh work remains pending without credit, deduction, quota consumption or
a terminal acknowledgement. This implementation has no baseline-repair endpoint.

History and title ownership have independent coverage. Provably owned records and
titles remain readable when original dates are unknown; null dates are retained.
A new recorded timestamp is not substituted for original occurrence or earned
time. Known title ownership permits selection even with an unknown balance.
Partial inventory is labeled partial, including an empty partial inventory.

All `/v1/me/experience` routes use the current authenticated account. Clients
cannot supply an owner, points, rule version, reward day, source or beneficiary.
Owner history uses generic action labels without source content, counterpart
identities or anonymous-author resolution. Titles and colors confer no role.

## HTTP routes

Inputs reject unknown keys. Point amounts and revisions
use canonical decimal strings within signed PostgreSQL bigint range; ordinary
counts, levels and percentages are bounded JSON numbers. Dates are UTC ISO values;
reward-day strings use the explicit `Asia/Shanghai` calendar.

| Method and route                              | Contract                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/v1/experience/catalog`                  | Versioned levels, thresholds, reward rules, sign-in rewards, title keys and color eligibility metadata; no account state or grants                        |
| GET `/v1/me/experience`                       | Baseline/coverage, nullable balance/level/progress, server day, sign-in preview, daily tasks, this owner's pending work and state revision                |
| GET `/v1/me/experience/records`               | Default 20/max 50 immutable recorded-order items and owner-bound opaque continuation; nullable original/applied dates and independently reported coverage |
| GET `/v1/me/experience/appearance`            | Known-owned titles, nullable earned dates, current selection, eligible color IDs and appearance revision                                                  |
| PUT `/v1/me/experience/appearance`            | Strict `{requestId,expectedRevision,titleKey,colorId}`; explicit null clears a selection                                                                  |
| POST `/v1/me/experience/sign-in`              | Strict `{requestId}`; no client-supplied day                                                                                                              |
| GET `/v1/me/experience/requests/:requestId`   | Owner-only immutable sign-in or appearance receipt                                                                                                        |
| GET `/v1/me/experience/unlocks`               | Up to 50 pending owner notices; reading does not acknowledge them                                                                                         |
| PUT `/v1/me/experience/unlocks/:noticeId/ack` | Strict empty body, idempotent acknowledgement of that owner's notice                                                                                      |

Sign-in returns HTTP 200 with an `awarded` or `already_signed_in` receipt carrying
the actual reward day, delta, balance, streak and revision. Reusing the same
request after midnight returns its original result; a new request may sign a new
server day. Same-day new requests cannot award twice.

Appearance returns HTTP 200 with a durable `applied` or `rejected` receipt.
Definitive revision/title/color rejection is a terminal business outcome. A reused
request ID with a different intent is HTTP 409 `EXPERIENCE_REQUEST_CONFLICT`, not
a substituted receipt. Unknown receipt is HTTP 404. Baseline unavailability and
pending earlier work are distinct HTTP 409 conditions without a successful or
terminal sign-in receipt. Transient failures preserve the original request.

Base colors 0–10 remain selectable independently of balance. A new selection of
colors 11–25 needs the corresponding known even level 2–30. An already equipped
high-level color can remain during an unrelated title edit after a downgrade.
Earned title ownership is retained through downgrades. All crossed level-title
thresholds grant once; no client-supplied CSS or title text is accepted.

## Reward rules and accounting

| Action                                                   | Nominal reward | Rewarded actions/day |
| -------------------------------------------------------- | -------------: | -------------------: |
| Publish a community post                                 |            +10 |                    1 |
| Root comment or reply, shared pool                       |             +3 |                    5 |
| Like or save, shared actor pool                          |             +1 |                   10 |
| Receive a nonself like or save, shared pool              |             +2 |                   10 |
| Receive a comment/reply, deduplicated nonself recipients |             +3 |                    5 |

Sign-in rewards are +2, +4, +6, +8, +10, +12 and +15 for consecutive days 1–7;
streak and reward saturate at day 7. A missed day resets the next streak.

Own post deletion has nominal −10; own root/reply deletion has nominal −3, even
when the original content earned no credit. Applied delta is separately recorded
and clipped at zero balance. Independently, deletion can refund a positive current
day's publish opportunity at most once, or the shared comment/reply opportunity
at most three times. Deleted-content age and original award do not change this
application-day rule. Refunds do not erase gross positive rewards.

Unlike/unsave do not reverse experience or refund quotas. A genuinely new
re-like/re-save transition can earn again within the shared daily limit; a no-op
or retry cannot. There is no descendant/moderation-removal penalty, recipient
reversal, extra task-completion bonus or unsupported-domain reward in this slice.

The reward day is taken from the database clock after the owner's settlement lock.
Source occurrence and applied time are different fields. Delayed processing can
settle on a later day; a committed capped outcome remains capped on every retry.
An owner's earlier unsettled unit prevents later work/sign-in from overtaking it.

## Fresh source and transaction boundaries

Community captures actual actor, resource and deduplicated beneficiaries in the
source transition transaction. The complete immutable source group, beneficiary
units and work enrollment commit atomically. Creation/transition provenance and
canonical source constraints prevent relabeling old content or obligations with
a new outbox row. Existing historical sources are not scanned or adopted. Occurrence timestamps
retain exact PostgreSQL precision through immutable source facts and ledger
storage, independently of millisecond public rendering. Derived deletion
provenance is stamped after existing whole-row content guards; their content
immutability rules are not widened to accommodate the new metadata.

Each beneficiary settles independently, with one owner lock and one transaction
covering state, quota/refund, ledger, titles, notices, applicable Saved
acknowledgement and work completion. An unknown recipient leaves its unit pending
without blocking a known actor's independent work. Replay and concurrent workers
cannot settle a unit twice. Saved reward obligations are the canonical units;
the general Saved outbox envelope never adds a second award. Other Saved
obligations remain for their own domain processors.

Post-like commands now use a frozen durable intent and owner receipt. A lost
response followed by an intervening unlike cannot turn a retry into a new
rewarded re-like. See [community post-like contract](API_COMMUNITY.md#desired-state-likes-and-own-deletion).

## Local processor

Default `EXPERIENCE_PROCESSING=manual_only` starts no automatic dispatcher.
`automatic` is explicit local opt-in; `disabled` prevents worker settlement. Apply and
automatic processing require nonproduction configuration, a verified loopback
connection and database `whaleu_dev` or `whaleu_test`. There is no public credit or
processing endpoint. Automatic processing discovers only durable fresh work,
uses bounded batches/backoff, skips independently blocked owners and survives
shutdown/restart without adopting historical events. One total per-cycle attempt
budget spans refreshed owner-head frontiers. The dispatcher finishes each selected
round before revisiting a hot owner; successful owners can advance more than one
unit per tick. An already-attempted failing head is not retried in that cycle and
still blocks its own successors. Per-owner order, durable retry backoff, local-only
guards and stop/restart behavior remain unchanged. This is bounded round fairness,
not a production-wide maximum-wait guarantee for every workload.

Defaults are a 5,000 ms interval and batch size 20, bounded at 60,000 ms and 50.
The CLI defaults to read-only dry-run; apply requires explicit unit/group IDs.
For example, with a disposable local environment already configured:

```sh
npm run experience:process -- dry-run --unit-id=<uuid>
npm run experience:process -- apply --group-id=<uuid>
```

All three local processing CLIs disable unrelated automatic dispatchers while
creating their application context. Dry-run does not modify balances, work,
queues, receipts, grants or progress. CLI output is aggregate counts only.

## Public experience projection

Named author responses and available public profiles carry a required
`experienceDisplay` block with independent dimensions:

```json
{
  "title": {
    "status": "known",
    "value": { "key": "level_1", "name": "萌新小白" }
  },
  "color": { "status": "known", "value": 0 },
  "level": { "status": "unavailable", "value": null }
}
```

For title/color, known null means an evidenced cleared choice; unavailable always
has null value. Known level is an integer 1–30, derived only from known owner state
and baseline. A selected proven-owned title does not require a known earned date
or current level. Retained high colors are valid displays after downgrade, but do
not establish a level. Ownership without selection never auto-equips a title.
Absent appearance and absent level evidence remain independently unavailable.

The DB-only projection leaf executes one nonlocking parameterized snapshot SELECT
per emitted named-author projection. It reads no history/settlement inventory,
acquires no owner/advisory lock, performs no writes and maintains no cross-request
cache. The whole private ExperienceModule is not imported into Profile, avoiding
a dependency cycle. Plain author lookup for Safety block snapshots is unchanged.

Each display triple is one committed statement snapshot. It is not an authority
or final-freshness proof; concurrent selection/settlement can make an earlier
cosmetic snapshot older than response completion. Existing account, content,
directional block, final relationship and session checks stay with their original
owners. No display read happens after final proof validation. Public-profile
active-account policy is retained; this does not silently impose that separate
policy on historical named cards.

Anonymous authors, unavailable targets and denied profiles keep their exact
minimal shapes with no display block. Public JSON/native data contain no balance,
login/streak, ownership dates, grant/source provenance, owner IDs, history, pending
work or private appearance revision. Fixed catalog text and palette IDs 0–25 are
rendered only in named/available branches across profile, cards, discussion,
formation, Saved, liked history and Updates. Server-supplied CSS is not accepted.
Affiliation/public UID and received-interaction totals remain unavailable;
cross-campus contextual labels are not guessed from titles or colors.

## Native behavior and remaining limits

The owner page separates unknown values from known zero, shows informational
incomplete tasks first, preserves undated history, and allows confirmed ownership
selection. Sign-in and appearance have separate origin/account-bound journals.
Exact intents are persisted before dispatch. Matched receipts settle a journal;
current state is read independently rather than reconstructed from an old receipt.

Foreground sign-in is an explicit, coalesced command based on a fresh server day,
not a GET side effect or device-date cache. Existing pending work and baseline
failure require explicit recovery. Account replacement, hide, cancellation and
late callbacks cannot act as a newer login or overwrite another account. An
unrelated sign-in refresh preserves an unsaved appearance selection. Closed
unlock notices stay closed while failed acknowledgement remains retryable.

A separate [bounded warm-history measurement](acceptance/experience-history-capacity.md)
covers 1,000/10,000 settled units on the Stage1 snapshot. This slice does not
establish broader production-history throughput, production worker activation, old balance adoption,
public received-interaction totals, rankings, campaigns or global maintenance.
Compiled-page tests do not establish physical WeChat/device rendering.

## Bounded known-participant ranking

`GET /v1/experience/ranking` is a read-only backend capability. Its optional `limit`
is a canonical decimal string from 1 through 50, default 50. Unknown query keys,
repeated values, nonempty bodies and malformed authorization are rejected. An
absent Authorization header permits guest access; a supplied token must be valid
and remains subject to current identity/session checks. Responses use `no-store`
and vary by Authorization. No native ranking page is included in this increment.

The response contains `scope: "global"`, `population: "known_participants"`,
`populationCompleteness: "incomplete"`, `selectionStatus` and `items`. Each item
contains only `profileId`, `displayName` and the existing safe `experienceDisplay`.
There are no public exact scores, rank numbers, own-rank calculations, population
counts, individual coverage details, internal account identifiers or timestamps.
Global describes the absence of campus partitioning, not complete historical
coverage or an unfiltered competition rank.

Known balances, including zero, are internally ordered by PostgreSQL bigint balance
descending and a deterministic owner-key tie break. One statement captures the
ordering and corresponding public level/appearance. Later changes do not trigger
mutable keyset refill. Unknown historical balances are omitted, and reads never
create a profile, baseline, entitlement, reward or settlement.

Selection considers at most 256 candidates from that captured window, with one
extra row used only to detect a remaining suffix. Existing profiles and active accounts are required. Signed-in nonself viewers
also require the current bilateral named-profile relationship; guest and self
reads use their existing policy exceptions. A
hidden post list does not itself hide the public profile's level or appearance.
Denied candidates are skipped while selection continues within its work/time
budget. The status is:

- `limit_reached`: the requested number was selected; no promise of more rows
- `available_candidates_exhausted`: the captured known-data source was exhausted
- `scan_limited`: selection ended at a work/time bound before filling the request;
  an empty list in this state is not a complete empty leaderboard

Historical population completeness remains `incomplete` in every case. There is
no cursor or invented rank-zero entry for missing accounts.

The composition retains accepted active-account locks and required bilateral
relationship facts through the existing transaction finalizer. Rejected attempts
release their added locks and proof registrations without discarding earlier
accepted facts. Mandatory policy/session failure aborts the response; it is not
converted to a successful empty or partially authorized list. Selected cosmetics
remain ordinary committed snapshots and confer no authority.

Read statements and lock waits have bounded local settings that never relax
stricter inherited settings. The selection loop has an elapsed budget and a
separate completion-validity deadline, while final named-disclosure proof remains
mandatory. These bounds are not an end-to-end HTTP latency SLA. SQL/proof failures
fail closed; only clean between-statement selection exhaustion yields
`scan_limited`. Production historical reconciliation and complete-population
ranking remain separate gates.

## Limited titles and inactive redemption infrastructure

The reviewed catalog includes the source-declared limited title
`redeem_liangchenmeijing` / 良辰美景, alongside the existing default and level titles.
This is nonsecret cosmetic metadata. Catalog presence does not establish a valid
campaign, current ownership or permission to grant it. The supported kind union
also accommodates special cosmetics; no administrator title or role grant is
introduced here. Registration still grants only its existing two titles.

Owner inventory groups default titles with level titles and separates limited and
special titles. Exact catalog key/name/kind agreement remains required across SQL,
API and native decoding. Public named display exposes only the selected supported
title; anonymous authors never acquire public experience display. Known ownership
and unknown balance remain independent, and original null earned dates stay null.

The production redemption provider is concretely unavailable. There is no example
code, shared default key, environment activation switch or production grant proof.
The native page reports unavailability instead of offering a form that declares
all real codes invalid. Real provisioning, guarded production grant authority,
cryptographic key lifecycle, distributed abuse protection and campaign activation
remain separate operational gates.

Owner contracts:

- `GET /v1/me/experience/redemption`: capability `available` or `unavailable`
- `POST /v1/me/experience/redemptions`: strict request ID plus exact input code;
  the owner comes only from the authenticated session
- Existing owner request-recovery GET supports operation `redeem_title`
- Granted receipt: request ID, operation, `outcome: "granted"`, supported title key
- Rejected receipt: request ID, operation, `outcome: "rejected"`, fixed invalid or
  already-owned condition; it never returns the entered code

Unavailable infrastructure, exhausted attempt budget and unknown network outcome
are not terminal invalid-code receipts. Recovery GET remains independent of
provider availability. A supported successful grant refreshes owned inventory;
it does not equip the title, award points, create a known historical balance or
promote partial entitlement coverage to complete.

The exercised implementation binds exact input to its owner/request using keyed,
domain-separated cryptographic fingerprints. It does not use an unkeyed digest of
a guessable code. Raw input and key material never reach SQL parameters, receipts,
URLs, persisted native state or intended logs. Metadata-only logging and defensive
body redaction supplement this boundary; transient JavaScript memory clearing is
not a secure-erasure guarantee.

The isolated native recovery record stores only a request handle scoped to its
owner and API origin. Input stays transient and is cleared on hide, navigation or
account/session change. Recovery first asks for the existing receipt. A missing
receipt does not prove an earlier request cannot still commit; after losing the
transient input, deliberate re-entry is needed for another submission under that
handle. A committed different input conflicts instead of creating another grant.
Stale responses cannot update another account, and repeated taps are coalesced.

Synthetic tests inject a provider and attempt-budget implementation in disposable,
explicitly guarded development databases. New SQL decision, entitlement and receipt
proofs must agree atomically and reject incomplete or forged records. That test
path is not a production activation mechanism or evidence that any real campaign
has been restored. No real redemption code is included in source or fixtures.
