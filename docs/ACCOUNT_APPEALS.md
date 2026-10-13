# Private account-punishment appeals

This owner provides a private, durable case for one actual Safety punishment ID,
kind and revision. It does not publish Community feedback, create a DM, invoke a
Review/provider, reveal the underlying author/source, or promise human/external
delivery. The management queue is the durable receiver. Administrators can open
the pending queue and process cases; new appeals do not generate proactive
administrator notifications, and submission does not imply anyone has read it.

## API and eligibility

- Own list/detail: `GET /v1/me/safety/appeals` and `/appeals/:appealId`.
- Submit/cancel: `POST /v1/me/safety/appeal-commands` and `/appeal-commands/cancel`.
- Original-key recovery: `GET /v1/me/safety/appeal-requests/:requestId`.
- Exact current-super-admin queue/detail: `GET /v1/safety/appeal-management/appeals`
  and `/appeals/:appealId`.
- Decision/cancel: `POST /v1/safety/appeal-management/commands` and `/commands/cancel`.
- Reviewer-owned recovery: `GET /v1/safety/appeal-management/requests/:requestId`.

Own access requires an active Identity session and exact record ownership. Mute,
suspension, unknown base coverage, missing phone/student verification, an absent
public-feedback topic and no online reviewer do not remove this private entry.
Fresh management requires a currently valid global `super_admin` grant and the
independent base Safety plus semantic management policy. School administrators,
developer-only actors and suspended administrators cannot read or decide others'
cases. Prior-key recovery/cancellation stays active-session-only after grant loss.

All lists use owner/scope/limit-bound opaque seeks, descending submitted time and
ID, default 20 and maximum 50. No total is invented. The queue includes decided
history as well as pending cases; each item identifies its state. Text is literal
private evidence, bounded at 4,000 UTF-16 units. Decision reasons are bounded at
255 units. Transport control and bidi-override/isolate characters are rejected;
newlines/tabs remain ordinary text. Native renderers must use literal text, never
HTML or Markdown interpretation.

## Durable commands and exact state

An actor plus original UUID binds one immutable normalized intent. Same-key
retries recover only that receipt; changing the intent conflicts. Apply performs
session-only recovery before any current privilege or punishment check, and then
rechecks the key under the fresh-write gate. Cancellation before apply wins that
same key. A post-commit cancellation returns the already-recorded outcome.

There is at most one open case per punishment. A new key while that case is open
returns its existing ID and original submission time, with `reusedOpenCase=true`.
Original case evidence is never overwritten. A completed case does not prevent a
new case while the punishment remains effective. A fresh appeal against an
inactive punishment returns an immutable stale receipt, unless an existing open
case is being recovered. Pending cases remain visible after external release,
expiry or replacement.

A decision is `upheld`, `released`, or `closed_no_longer_effective`. The last
outcome is permitted only for an ineffective exact appealed reference; other
outcomes require it still to be effective. Decision CAS includes the original
case, current punishment/head/terminal and time-derived effectiveness. Release is
created by the punishment owner's function from the actual decision trigger and
binds the exact case ID, punishment ID/kind/revision, actor, session, grant,
original key, event, reason and time. It cannot release a replacement, the other
kind, imported base policy, Identity or Errand restrictions.

The same transaction records the decision, removes the open-case pointer and
appends one private `account_appeal_decided` owner result notice. A released result
also has the punishment owner's release event/notice. Each notice retains its
own distinct cause and global notice identity; retries cannot multiply unread
results. These are local system notices, not external-delivery claims.

## Proof, privacy, retention and budgets

- SQL validates complete immutable command/case/decision/notice closure, with
  retained source fingerprints and final bounded NOWAIT source fences.
- Deferred source checks and transaction validation wakes cover late source DML,
  including zero-row statements after `SET CONSTRAINTS ALL IMMEDIATE`.
- Own original-key cancellation uses only Identity evidence; unrelated grant,
  punishment, public content and provider tables are not opened.
- Cases, requests and decisions reject update/delete/truncate. Open pointers
  require exact causal creation/decision transitions. Result notices permit only
  monotone first-read markers.
- Separate per-account/action durable buckets reuse existing
  `SAFETY_REPORTS_PER_MINUTE` for new cases/decisions and
  `SAFETY_REPORT_READS_PER_MINUTE` for reads/replays/cancellations. Reusing an open
  case does not consume another new-case allowance. There is no invented lifetime
  limit or cooldown.
- Historical session IDs and token hashes are immutable audit evidence without
  foreign keys to short-lived sessions/tokens. No raw token is stored. Identity
  maintenance may remove those sessions; recovery authenticates the current
  same-account session instead. Original creation/final validity is not weakened.

## Integration and verification status

The forward migration fragment is assembled by the account-moderation owner,
not a separately allocated migration. AppModule and shared system-notice union,
registry, repository, cursor and native result rendering are integrated by their
owners. Old migrations and public-feedback contracts are unchanged.

Source tests cover private unverified/muted/suspended submission, ownership,
replay/conflict/cancellation/open-case deduplication, repeat appeal after upheld,
current role enforcement, exact two-kind release, superseded-case closure,
notice rollback, cold recovery under unrelated source locks, grant-loss recovery,
and actual Identity maintenance with a replacement session. Contract/cursor tests
cover bounded intent, literal safe text and receipt privacy.

These test sources have not been executed as part of source preparation. The
coordinated execution owner must run typecheck, focused unit/API tests, native
roundtrip, raw-writer concurrency/expiry-boundary cases and the full frozen-tree
regressions before accepting this journey. No live account, production schema,
provider, notification or deployment is activated by these changes.
