# Ratings R1 development API

R1 is a local development slice in the normal Nest application. It has trusted catalog navigation, independent integer scores, text root comments, own deletion and durable account-owned recovery. It does not supply production catalog data or a real review issuer. Normal missing evidence fails closed.

The [generated OpenAPI](openapi/ratings.json) covers the twelve R1 routes and the [R2A discussion/local-update extension](API_RATINGS_DISCUSSION.md). [Design and wire details](design/ratings-r1.md) describe exact fields, owner integration, locks and bounded proofs. [Acceptance evidence](acceptance/ratings-r1.md) distinguishes focused checks, full regression and outstanding release gates.

## Routes

| Method | Path                                    | Purpose                                     |
| ------ | --------------------------------------- | ------------------------------------------- |
| GET    | `/v1/ratings/context`                   | Current allowed region choices              |
| GET    | `/v1/ratings/categories`                | Root or direct-child categories             |
| GET    | `/v1/ratings/targets`                   | Direct category targets                     |
| GET    | `/v1/ratings/targets/:id`               | Current target and canonical actions        |
| GET    | `/v1/ratings/targets/:id/my-score`      | Only the current account's score            |
| GET    | `/v1/ratings/targets/:id/score-summary` | Independently proven summary or unavailable |
| GET    | `/v1/ratings/targets/:id/comments`      | Bounded newest-first text roots             |
| GET    | `/v1/ratings/comments/:id`              | Current safe root projection                |
| PUT    | `/v1/ratings/targets/:id/my-score`      | Score or change with revision CAS           |
| POST   | `/v1/ratings/targets/:id/comments`      | Exactly reviewed text publication           |
| DELETE | `/v1/ratings/comments/:id`              | Own soft deletion with revision CAS         |
| GET    | `/v1/ratings/requests/:requestId`       | Minimal committed result recovery           |

Missing read regionId and command regionId=null explicitly choose the global catalog. Regional scope is independently proved from current affiliation relationship groups or canonical fixed/global grants; browsing selections do not grant access. Context/categories are phone-exempt. Target/score/comment operations require current phone proof. Global score/named text has no affiliation prerequisite; anonymous publication additionally requires current affiliation, privilege or a rating-specific temporary assertion. Receipt recovery requires only a current session and proves no current content access.

All queries and bodies are strict. Commands include clientRequestId; score and deletion also include expectedRevision. Every target mutation includes expectedTargetRevision. IDs and revisions are lowercase UUIDs. Invalid scores, foreign IDs, extra client account fields and media are rejected. Text normalizes CRLF and trims outer whitespace, then allows 1–500 Unicode code points; TAB/LF are allowed, remaining C0/C1 controls and lone surrogates are not.

## Scores and provenance

Scores and comments are independent. Changing a score never adds text; deleting a root never removes its score. Scores are strict integers 1–5, with one current row per target/account. The request's expectedRevision is checked before evaluating a same-score noop. Noop changes neither score nor summary revision, timestamp, buckets or count.

A known summary contains count, integer sum, rounded-once average, five buckets and revision. Known zero uses average=null. Missing or historical coverage is unavailable, never zero; my-score is also unavailable rather than a fabricated null. Accepted directory metadata and approved text cannot prove historical score coverage. A fresh-zero baseline requires its own accepted new-native-target source and same-transaction creation evidence. No history repair/import/reconciliation is installed.

The database alone mints score transition events and summary deltas. Direct summary/event writes, score deletion and same-score SQL updates are rejected. Deferred constraints tie raw score, exact summary and applied receipt to immutable causal transitions. Target lifecycle revisions have an immutable uniqueness ledger, so a disabled/re-enabled target cannot revive an old CAS token.

## Text, identities and recovery

Root publication needs exact current canonical review of actor, request, text, mode, target revision, category/catalog and scope. Default providers never approve absent review. An anonymous persona is a random target/account-local identity: stable in one target and unlinkable across different targets. Anonymous HTTP data contains no real account, Profile or original user ID. Named projections use locked Profile-owned public fields and current named Safety policy. The backend supplies isMine/delete and allowed authorModes.

A successful receipt contains only requestId, operation, outcome, targetId, subjectId, revision and occurredAt. Noop is possible only for score/deletion, and its timestamp is the original effective transition's exact database time. Same-key retries return the original result without another score, root or deletion event. Reusing the key with a different canonical intent conflicts. Rejected receipts describe the decision already made, not current permission; a new intent requires a new key. Unknown infrastructure/authority failures do not manufacture rejected receipts.

Network loss after commit is recovered by querying the same key before any new command. Receipts remain recoverable after target access loss and never replay deleted text. Clients reload target, own score and summary after confirmation instead of interpreting the receipt as a current view.

## Paging, final proof and resource limits

Pages use limit 20 by default, maximum 50, with opaque continuations bound to viewer/session, scope evidence, region/catalog, locator, sort and limit. Category trees are capped at three levels. Scan continuation makes bounded forward progress across hidden candidates. Target lifecycle, Safety and review fingerprints invalidate stale negative observations, including unblocks or previously inactive targets becoming active.

READ COMMITTED transactions retain source row locks and run bounded mandatory owner proofs after deferred constraints. Final source fences are NOWAIT and do not create a new blocking wait. PostgreSQL exact timestamp predicates prevent future same-millisecond facts becoming valid early; conservative deadlines catch expiry during later validation. Failed mandatory proof rolls back all tentative mutations and receipts. Independent score coverage only controls score availability.

The existing Safety writer capacity remains 128, with its existing supported-capacity admission check. No fourth owner or expanded capacity is inserted into CountProofCollector. R1 uses separate bounded required owner proofs. Under conflicting final fences, the API returns unavailable rather than stale data; this is an explicit availability tradeoff, not a silent empty page.

## Still outside R1

- Directory/target creation, management, override reconciliation and historical import
- R2A adds replies, fresh creation Experience and direct local notifications; likes and subscriptions remain outside this slice
- Media storage/review and real external provider delivery
- Real review issuance/governance and authoritative production catalog source
- Random recommendations, rankings and category aggregates
- Distinct specialist course/major/floor/window/dish-recommendation capabilities
- WeChat device acceptance and iOS/Android/Harmony implementations

Author cumulative received-like behavior after deletion remains an unresolved product decision. R1 does not create or modify that metric.

## R3A cleanup and administrator deletion

Owner deletion now uses private metadata and global account/phone/Safety
eligibility, so hidden/inactive parents or withdrawn affiliation/review do not
prevent cleaning up one's own content. Exact parent/revision CAS and the original
wire/hash/receipt remain unchanged. Separate minimal owner cleanup contexts and
explicit administrator contexts/commands are documented in [R3A deletion](API_RATINGS_ADMIN.md).
The [R3A acceptance record](acceptance/ratings-r3a.md) tracks pending gates.

## R3R complete-pool random selection

A separate [random-selection contract](API_RATINGS_RANDOM.md) adds explicit native-campus institution scope plus global, recursive category candidates, exact optional minimum score and a uniform single draw. It validates the whole candidate stream and rejects resource-budget overflow rather than sampling a page. Production-load acceptance and legacy equivalence remain open; see [acceptance](acceptance/ratings-r3r.md).
