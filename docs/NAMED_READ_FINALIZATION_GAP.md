# Named read finalization: bounded follow-on

This is an open privacy/correctness release gate, not a completed safety-parity
claim. The exact-count checkpoint protects the three discovery read use cases
below against raw SQL block changes after their initial authorization. It does
not automatically enroll every existing consumer of the shared safety owner.

## Protected in this checkpoint

- `GET /v1/profiles/:profileId`
- `GET /v1/profiles/:profileId/posts` and `/trading`
- `GET /v1/me/community/liked`

These READ COMMITTED transactions enable `enableSafetyRelationshipProof` before
mandatory target/content authorization. The safety owner records every observed
allowed named pair and its purpose, including selected-card aggregate/formation
projection dependencies. Anonymous, guest and self bypasses remain unchanged.
An earlier allow requirement is not erased by a later deny.

After all source work and deferred constraints, a required final proof obtains a
NOWAIT SHARE fence on `whaleu_safety.blocks`, then rereads the bounded recorded
pairs in 256-pair batches. `list_projection` needs outgoing permission only;
public-profile/direct purposes require both directions. The proof has a 500 ms
remaining-time budget and a conservative 110,000-fact ceiling derived from the
existing selected-page nested-content limits. Failure fails the request, including
when optional counting is unavailable. It cannot degrade into an available
profile or page with merely null counts. Required deadlines are checked using the
final database clock after required and optional proof phases.

The registry is transaction-lifetime scoped and checkpoint-restored. Intended
block/unblock and other mutation consumers are not opted in, so they do not reject
their own authorized relationship transition.

## Remaining ordinary emitting reads

The following routes still rely on existing service/common-policy locking without
this equivalent raw-block final predicate proof:

- `GET /v1/community/posts` (authenticated ordinary feed, outgoing-only)
- `GET /v1/community/posts/:postId`
- `GET /v1/community/posts/:postId/comment-capabilities`
- `GET /v1/community/posts/:postId/comments`
- `GET /v1/community/comments/:id`
- `GET /v1/community/replies/:id`
- `GET /v1/community/comments/:id/replies`
- `GET /v1/community/posts/:id/discussion-context`
- `GET /v1/community/posts/:postId/poll`
- `GET /v1/community/posts/:postId/trading/contacts`
- `GET /v1/community/posts/:postId/formation`
- `GET /v1/community/posts/:postId/formation/contacts`
- `GET /v1/community/posts/:postId/update-preferences`
- `GET /v1/me/community/saved`
- `POST /v1/me/community/saved/status`
- `GET /v1/me/community/trading`, whose own-parent bypass does not cover the
  serializer's other-author aggregates/projections
- `GET /v1/me/community/updates`
- `GET /v1/me/community/updates/:noticeId/target`
- `GET /v1/me/safety/report-progress/:kind/:id`

The separate privileged `POST /v1/identity-privacy/content-identities` boundary
also resolves named visibility before returning audited private identities and
requires its own transition-safe finalization review. Non-HTTP notification
creation through `CommunityUpdatesFacade.eligible` needs a writer/delivery review;
it must not simply inherit a read-only unchanged-relationship assertion.

Own-only receipt/status endpoints, own-post ID/status recovery, poll-ballot and
formation-membership recovery, unread-count/mark-read, catalog spaces and general
capabilities do not themselves emit newly authorized named content. Do not
blanket-enroll them or mutation transactions without examining their semantics.

## Next bounded patch

1. Enroll the remaining actual emitting read transactions with explicit READ
   COMMITTED, preserving ordinary-feed outgoing-only and direct bilateral policy.
2. Test raw INSERT/UPDATE, absent-pair creation, earlier-allow/later-deny,
   unsupported optional-count capacity and final/deferred-clock races on emitted
   DTOs, not only count fields.
3. Keep requested block/unblock, recovery and other controlled mutation flows
   correct; use explicit read-use-case markers or model intended transitions.
4. Verify query bounds, checkpoint/pooled-client lifecycle and final writer
   latency, then run the complete serial PostgreSQL and native aggregate.

No production readiness or complete raw-writer safety guarantee is implied until
this follow-on and the other documented release gates pass.
