# Private messages: PM0–PM2 local text contract

Status: focused local validation passed on 2026-10-09: 36 API/owner tests, 53 native tests and 76 genuine PostgreSQL tests, with zero failures or skips. Whole-tree format/typecheck/lint/OpenAPI and emitted native Page/WXML build smoke also passed. Root integration full regressions and exact published-commit hosted CI remain separate pending gates. The module remains PARTIAL; native-device/provider acceptance, production issuance, private images and authoritative historical migration are not established by this slice.

## Scope and authority

All routes are `/v1/private-messages/*`, require a current opaque session, return strict JSON with `Cache-Control: no-store` and `Vary: Authorization`, and never accept an account ID, persona owner or Review approval ID from the client. Missing canonical source/Verification/Safety/Review/coverage evidence fails closed. Empty deployment tables do not establish historical zero, eligibility or approval.

DM uses independent purpose-specific admission: canonical phone plus verified affiliation or explicitly trusted private-message temporary status, and Safety action eligibility. Current selected campus, cosmetic titles, administrator status and rating-purpose grants are not substitutes. Unread retains the phone exception; base status and Safety remain required. Verification loss does not erase histories or silently expand retained-read access. Minimal original-command receipt recovery is current-session-only and never returns body/peer identity.

Three immutable contexts are supported:

- Named profile or named-content conversation, both participants named.
- Anonymous post/comment/reply context, both participants use post-scoped anonymous display provenance.
- Anonymous initiation to a named post author, only with that exact post's reviewed explicit opt-in.

The exact post/comment/root/reply ancestry is resolved by Community. A name match, guessed author, unrelated comment or current profile default cannot grant contact. Context identity includes source post and the mode attached to each canonical participant; modes are never silently rewritten. Each source-based open stores its own exact provenance without overwriting the original context. Existing posts with unknown opt-in are ineligible for mixed initiation. New named-post opt-in has an explicit versioned Review envelope; historical v1 hashes remain unchanged.

## Routes

| Method | Suffix                                       | Contract                                                    |
| ------ | -------------------------------------------- | ----------------------------------------------------------- |
| POST   | conversations                                | `{clientRequestId,entry,initiationMode}` source open        |
| GET    | conversations                                | Own visible nonempty list, `cursor`, `limit` 1–50           |
| GET    | unread                                       | Own count and explicit `local`/`complete` coverage          |
| GET    | conversations/:id                            | Safe participant display/actions and current navigation     |
| GET    | conversations/:id/messages                   | Chronological bounded newest/backward history               |
| GET    | conversations/:id/events                     | Oldest-unseen forward events, including old-message recalls |
| POST   | conversations/:id/messages                   | `{clientRequestId,text}` exact reviewed text                |
| POST   | conversations/:id/read                       | `{clientRequestId,observationId}` observed watermark        |
| POST   | conversations/:id/hide                       | `{clientRequestId}` owner-only inbox cleanup                |
| POST   | conversations/:id/reopen                     | `{clientRequestId}` retained-member reopen                  |
| POST   | conversations/:id/messages/:messageId/recall | `{clientRequestId}` sender-only recall                      |
| POST   | conversations/:id/block                      | `{clientRequestId}` immutable peer-derived scope            |
| GET    | requests/:requestId                          | Original owner-only minimal immutable receipt               |
| POST   | requests/:requestId/cancel                   | `{operation,intentHash}` session-only original-key closure  |

Entry is exactly one of `{kind:'profile',profileId}`, `{kind:'post',postId}`, `{kind:'comment',postId,commentId}` or `{kind:'reply',postId,rootCommentId,replyId}`. Initiation mode is named/anonymous. Client request IDs are lowercase UUID v4. Text is CRLF-normalized to LF, nonblank, at most 500 Unicode code points/2,000 UTF-8 bytes, with bounded allowed controls. Media fields are rejected; there is no upload/provider adapter disguised as text acceptance.

Every mutation has one immutable normalized original intent. Reusing the same account/request key with another body, operation or route target conflicts. Lost responses recover the same historical receipt; they never recreate a hidden conversation, resend text or reevaluate a past successful recall. Temporary unavailable evidence is not frozen as a terminal rejection. Terminal denials retain the relevant owner facts through savepoint rollback and final transaction proof.

## History and read state

Message and event sequences are separate PostgreSQL BIGINTs encoded as decimal strings. Time is presentation, not ordering authority. Backward history uses message sequence. Forward incremental polling drains the oldest unseen events and includes recalls of old messages; it never jumps to an unseen latest batch. Cursors are owner/purpose/conversation/limit bound. Mutable inbox ordering uses owner epoch invalidation rather than silently losing rows across list pages.

GET never marks read. A server-created bounded observation token authorizes only its observed sequence. Monotonic read acknowledgments leave subsequently arriving messages unread. No public per-message peer read receipt is introduced. Hide uses a separate cleanup watermark and zeroes only the owner's current inbox contribution, preserving actual read state and all history. Reopen does not resurrect old unread. New incoming accepted text restores only the recipient's hidden state.

Recall is an immutable tombstone within an inclusive database-time 120-second window, with a final microsecond-precision proof after waits. Recall suppresses ordinary body/preview/delivery obligation and adjusts only the unread contribution that still exists. It does not reset lifetime contact counters. The restricted original record is not returned by history, receipts or event projections. Current Review hold/revoke also suppresses body; missing current Review evidence is unavailable, not stale cached allow.

Source removal does not remove membership or histories and does not govern ongoing member send authority. Source navigation is separately revalidated. A named `profileId` is a navigation locator, not proof of current access. In mixed conversations it is the frozen locator already known at entry: automatic conversation reads never refresh that profile or consult the hidden account-pair graph. An explicit visit independently reauthorizes at the public-profile destination; missing or blocked targets return generic unavailable and hidden posts remain hidden. The result is not cached back into the anonymous conversation as an identity signal. Anonymous identities never expose account/profile/persona linkage, experience or real-profile fallback.

## Safety and abuse policy

Named/named sends obey both global named-block directions. Own block state may be shown, reverse denial is generic. Anonymous conversations do not query the underlying named-account graph.

In mixed contexts, a named participant blocking an anonymous peer sets a persistent local conversation latch. An anonymous participant explicitly blocking the visible named peer performs the real Safety named block plus that local latch atomically. Either action stops BOTH send directions. The local latch survives hiding, reopening, source removal, recall and unrelated global unblocking. No anonymous-window unblock endpoint is introduced. UI explains that independent persistent scope. Named/named keeps existing own global unblock behavior.

These are deliberate safety protocols and fixes, not compatibility with insecure behavior: one lifetime accepted first contact until the peer has ever replied; recall never replenishes it. Additional documented fixed-window caps are actor20 accepted sends/minute, conversation10/minute, source-open20/minute, new contexts5/hour. Same-key replay does not spend another accepted quota. A separate account-scoped request-attempt budget is240/minute across sessions/routes, allowing bounded native foreground polling without unlimited source/Review work. Limits are fixed windows, not a claimed sliding-window guarantee.

## Native and later stages

Actual list/detail/recovery pages, profile badge, public-profile entry and exact post/comment/reply entry use independent DM state. Commands persist a bounded account-scoped frozen intent before dispatch. Uncertain commands retain the original key/payload, recovery checks the body-free receipt, and any body display is reauthorized through history. Logout/account switching purges private text while preserving an account-isolated unresolved request ID, operation and original intent hash. At most eight accounts can retain one unresolved command each; capacity exhaustion refuses a new command rather than silently evicting an unknown result. Same-account login can GET the original receipt or explicitly cancel the original key without the body; another account cannot recover it. Missing original body disables retries. Cancellation returns a separate `cancelled` or `already_terminal` result wrapping the original receipt, and races under the same database request lock as sending. A late send cannot bypass a committed cancellation. No persistent committed-history cache. Copy/re-edit uses only currently authorized text; re-edit becomes a new reviewed send.

Foreground detail/list polling is bounded, cancelled on hide/unload, generation-guarded across sessions/navigation and paired with current Review revalidation. Read acknowledgments require rendered visible content and the matching observation. Physical-device keyboard/background/copy/cache acceptance has not been established by unit/smoke tests.

PM3 remains private image storage, immutable sealed object identity, Review-bound assets and viewer+typed-parent-authorized delivery. A short-lived bearer URL is not instantaneous revocation. PM4 remains provider consent/mapping/quota, durable dispatch/reconciliation and real-device/platform acceptance. Local transactional outbox obligations remain `not_configured`/pending or suppressed, never falsely delivered. Provider body previews are not enabled by default. PM5 remains authoritative legacy schema/data/object reconciliation, preserved read/hide/recall/block context, cutover/restore and any separately authorized report-support evidence policy. No administrator private-message body endpoint exists here.

## Real issuance integration contract

No production issuer is configured or seeded. An upstream trusted Review adapter must implement `DmReviewIssuerPort`: evaluate the exact canonical v1 envelope and digest outside Messaging commit locks; use account/request/digest as idempotency identity; append an accepted, purpose-specific issuer decision and state/head evidence before send can consume it. The envelope binds sender account, request, conversation, immutable context digest, sender slot, both participant modes, normalized text and exactly empty asset IDs. Client-supplied approval IDs are never authority. Pending, unavailable and failed results cannot be converted to allow. Current hold/revocation must append owner ledger state and invalidate owner epochs; publication binds approval once in the same transaction and rereads current state at final proof.

Temporary DM eligibility uses its own `private_messages` issuer registry, accepted provenance, complete coverage, original account, effective/expiry times and policy reference. A trusted future adapter must publish immutable assertions and advance the corresponding head atomically. Canonical phone and affiliation remain their existing Verification owners. No current campus selection, role, old rating-purpose temporary grant or client claim can manufacture this evidence.

Deployment coverage must be explicitly established by a trusted local/bootstrap or later authoritative migration process; a missing coverage head is unavailable. The synthetic fixtures used for local tests are test evidence only and are not a production bootstrap contract. Provider delivery remains unconfigured even when a local message commits successfully.
