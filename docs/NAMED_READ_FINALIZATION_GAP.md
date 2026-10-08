# Named emitted-read finalization and remaining boundaries

The follow-on implementation explicitly enrolls the current emitting read owners
below in the required transaction-lifetime Safety proof. Verification status is
recorded separately in acceptance evidence; source enrollment alone is not a
production-readiness or universal mutation-concurrency claim.

## Transaction boundary and final proof

The protected transactions explicitly use READ COMMITTED regardless of connection
defaults. Their owner enables `enableSafetyRelationshipProof` before the first
named visibility check. Safety records every observed allowed pair and its
purpose. A later denial cannot erase an earlier permission required by a returned
result. The registry is bounded, transaction-lifetime scoped, checkpoint-restored,
and cleared before a pooled client can be reused.

After all source work and deferred constraints, the mandatory proof takes a
NOWAIT SHARE fence on `whaleu_safety.blocks`, then rereads the recorded pairs in
256-pair batches. `list_projection` requires outgoing permission only;
public-profile/direct purposes require both directions. The existing 500 ms
remaining-time budget and 110,000-fact ceiling are unchanged. Required deadlines
are checked using the final database clock after mandatory and optional proof
phases. Optional count capacity, failure, or null display counts cannot waive this
proof or turn an unsafe payload into success.

Anonymous, guest and self bypasses remain unchanged. An own or anonymous parent
does not waive independently named children, reply target authors or formation
members. Formation feed cards retain their special direct-parent roster check.

## Enrolled owners

Already covered by the exact-count checkpoint:

- `GET /v1/profiles/:profileId`
- `GET /v1/profiles/:profileId/posts` and `/trading`
- `GET /v1/me/community/liked`

Additional explicit emitting owners:

- `GET /v1/community/posts` and `/posts/:postId`
- `GET /v1/community/posts/:postId/comment-capabilities`
- `GET /v1/community/posts/:postId/comments`
- `GET /v1/community/comments/:id` and `/replies/:id`
- `GET /v1/community/comments/:id/replies`
- `GET /v1/community/posts/:id/discussion-context`
- `GET /v1/community/posts/:postId/poll`
- `GET /v1/community/posts/:postId/trading/contacts`
- `GET /v1/community/posts/:postId/formation` and `/formation/contacts`
- `GET /v1/community/posts/:postId/update-preferences`
- `GET /v1/me/community/saved`
- `POST /v1/me/community/saved/status`
- `GET /v1/me/community/trading`
- `GET /v1/me/community/updates` and `/updates/:noticeId/target`
- `GET /v1/me/safety/report-progress/:kind/:id`
- `POST /v1/identity-privacy/content-identities`
- The dormant internal `FeedService.comments` read entry point

The list classification is intentional: HTTP POST and audit/rate writes do not
make a disclosure a historical mutation receipt. Ordinary feed cards, discussion
children and formation members retain their existing outgoing-only policy;
direct parents, profiles and liked-history chains retain their existing stronger
purposes. Shared policy helpers and serializers do not globally enable the proof.

## Discussion v3 removes unrelated off-page work

Root traversal filters at most 1,024 candidate roots, reads bounded root-order
metadata, sorts, and selects at most 10 roots before rendering. Its opaque v3
cursor fingerprints visible root IDs, creation times and pins, and like counts
only for likes ordering. Off-page replies, reply counts, previews, media and
names are not inspected merely to construct that cursor. Each selected root
still receives its current full visible reply count, earliest-first preview, and
ordinary reply continuation. Valid v2 root cursors require an explicit safe
restart; malformed cursors remain invalid requests.

The root-list relationship envelope is approximately one parent plus 1,024 roots
plus 10 times 1,024 selected-root replies, conservatively under 11,315 facts with
preview references. It needs no aggregate epoch attestation, new count-capacity
configuration, migration, or increased proof ceiling. Changes to off-page replies
or time-sort like counts intentionally no longer restart traversal. Relevant root
eligibility/order and scope changes do.

Native root navigation uses fresh page replacement and cursor-only Previous/Next
history. It rechecks the parent and located context and never restores previous
root DTOs or expanded previews from cache. Sort/reload/session/safety/cancellation
boundaries clear traversal state; reply drafts/targets and reply traversal keep
their existing contracts.

This bounded root endpoint is not end-to-end support for a million-reply thread.
The shared PostView serializer still has its existing 1,024 visible replies per
post aggregate limit, and native page navigation rereads that parent. The
1,024-root and selected-root 1,024-reply candidate limits also remain. Removing
those independent scale limits requires a separate design and acceptance gate.

## Audited identity disclosure

The privileged identity POST starts its disclosure proof only after session and
developer grant validation. Any final relationship failure of an actually
returned identity payload aborts the whole transaction, including records that
would claim disclosure. Mixed available/unavailable batches retain all required
facts for their available output.

If the existing owner abandons its entire candidate payload before disclosure
and returns only a denied/unavailable error with attempt metadata, it restores
the pre-disclosure checkpoint. Abandoned content facts cannot incorrectly erase
that durable attempt. Earlier session/authority work and its mandatory bounds
remain. This is a narrowly controlled whole-payload error branch, not a generic
opt-out or a way to discard earlier facts while returning an identity item.

## Explicit exclusions and remaining release questions

- Intended block/unblock and other mutation transactions are not enrolled. The
  same request must not reject its own authorized relationship transition.
- Historical publication, discussion, Saved, ballot, formation, trading and
  reporting receipts remain compact and replayable after content becomes hidden,
  deleted or blocked. Own IDs/status recovery, unread-count/mark-read and system
  notices do not newly project current named content.
- Own block management intentionally returns current/snapshot blocked names for
  cleanup. Requiring those pairs to be unblocked would be the wrong predicate.
- Post reactions return a current count rather than a historical receipt. Their
  raw-writer mutation authorization consistency is a separate question; this
  read-focused claim does not certify it.
- Notification materialization through `CommunityUpdatesFacade.eligible` remains
  a separate writer review. The current worker stores references, discards its
  computed preview and has no available external delivery channel. Any future
  cached preview or external sender needs an explicit final disclosure boundary.
- A raw SQL writer already holding the blocks table can cause bounded NOWAIT
  unavailability. The short final table fence must be measured honestly; this
  proof does not promise zero contention or universal writer linearizability.
- The proof does not revoke already committed responses, inspect production,
  activate providers/jobs, or establish complete production readiness. Native
  privacy invalidation and broader scale/import/provider gates remain separate.
