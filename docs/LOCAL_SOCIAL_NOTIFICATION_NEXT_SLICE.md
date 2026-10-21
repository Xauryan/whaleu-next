# Local social notification gap: implementation proposal

Status: proposal implemented as the next isolated local social slice; see
[the implemented contract](API_SOCIAL_UPDATES.md). Focused source tests are distinct
from pending centralized PostgreSQL/native acceptance. This document preserves
the original scope rationale and does not claim production/provider acceptance.

## Existing evidence, not missing provider credentials

Post/root/reply likes already emit fresh transactional events. Saves have retained
epochs and `author_interactions` obligations. Community experience-source capture
and migration 0022 retain immutable `reward_source_groups` with actor, recipient,
ancestry, occurrence time and exact like/save epoch. A new Community-owned facade
can expose these facts without changing reward settlement or reconstructing history
from current memberships. Enrollment must be fresh-only after experience capture,
not an automatic backfill.

Following currently has real edges, revisions and original-command receipts but
no notification event. A future event must be committed only with an actual new
positive edge, bound to its applied receipt. Replays, duplicate true, unfollow,
rejection and cleanup must not create positive events.

Existing Community reply notices cannot simply accept these event names: their
schema requires a comment locator. Use a separate received-social owner and
independent work/receipt/read state. Never mark the existing saved reward obligation
complete on behalf of its owner.

## Proposed minimal scope

- Community social enrollment, immutable source facade and fresh projection facade.
- Notifications social contracts, repository, cursor, read service, controller,
  local worker/dispatcher and module. Reuse notification owner locks, not counters
  copied from another owner.
- Authenticated list, exact category unread count, target resolution and individual
  read acknowledgment endpoints under `/v1/me/social-updates`.
- Likes/saves use freshly authorized Community targets. Actor mode is not a public
  persona contract, so v1 must use actor-neutral text instead of revealing a named
  identity. Following can use explicitly named public-profile projections.
- Unavailable rows expose no actor, target or reason. Recheck complete ancestry,
  ownership, visibility, relationships, session/deadline and safety at each read.
- Opaque account/session/category/limit-scoped cursors and stable ordinal boundary;
  independently reproject visibility, never cache a private payload snapshot.
- Listing, entering a category or opening a target does not mark read. Read only
  the acknowledged notice, with settled retry preserving the original timestamp.

Like lifetime deduplication is already an obligation. Lifetime save/follow
deduplication is a proposed v1 product rule, not existing behavior: if adopted,
re-save/re-follow should settle a receipt referring to the first notice without
changing its timestamp or unread state. Self-events must be suppressed.

Native integration belongs in the existing social-notices reader composition.
Add likes/received-community and real followers sources with namespaced IDs,
independent pagination, owner-dispatched reads and lifecycle fences. Preserve the
accepted Inbox layout and its three category shortcuts. Do not add new business
sender rows underneath.

## Dependencies and acceptance

The next migration number must be allocated after current work; 0167 is timetable
and 0168 is reserved for Community discussion ordering. No production migration
is authorized by a local test.

Required real PostgreSQL/native tests: fresh-only capture, rollback, concurrent
workers, receipt completeness, replay and unlike/re-like/re-save/re-follow,
cross-owner/category denial, deleted/hidden ancestry, relationship races,
anonymous non-linkability, opaque cursor isolation, exact unread/read settlement,
late native responses and unchanged Inbox layout.

Mentions remain separate: raw `@` text is not a recipient-selection contract.
Activities have publication/visit facts but no recipient/subscription obligation;
visit records are not unread state. External delivery remains provider-dependent.
Neither missing local producer should be represented by fabricated notifications.
