# Scoped ratings M3B development API

M3B implements exact campus-scoped ratings alongside the existing v1 contracts.
It includes all 39 v2 routes, eight original-intent commands, current source and
Review proofs, typed legacy compatibility, native recovery and notice navigation.
Implementation, isolated focused checks and integrated local regression have
passed 5,364 tests; hosted release acceptance remains pending. No production source, adoption, provider or activation
is supplied by synthetic acceptance fixtures.

See the [generated OpenAPI](openapi/ratings.json) for exact schemas and headers,
[acceptance status](acceptance/ratings-m3b.md) for executed checks and release gates,
and [feature parity](FEATURE_PARITY.md) for remaining acceptance and M3D work.
The additive [M3C category-management API](API_RATINGS_CATEGORY_SCOPED.md) adds
eight routes and nine category-only commands under separate pending acceptance.
The shared request endpoint now has a strict category receipt branch; the eight
M3B public/target command schemas remain unchanged. The new API
supplements [v1 ratings](API_RATINGS.md); it does not replace historical receipts,
cleanup or journals.

## Scope selection and current authority

Navigation accepts exactly `{kind: 'global'}` or
`{kind: 'campus', campusId}`. Global is an independent canonical view, not a union
of campus catalogs. A campus view contains only explicitly placed and currently
qualified categories and targets. A global-origin target does not automatically
appear in every campus. Identity campus, selected view campus, target origin and
target placement are separate facts; choosing a view does not change identity or
grant access. Campus-owned current topology and authorization determine the
allowed scope, including complete negative observations.

Random contexts instead accept `{kind: 'global'}` or
`{kind: 'institution_with_global', anchorCampusId}`. Selecting a campus for random
means the complete authorized institution campus domain plus independent global,
not only the selected campus. Every declared path is checked before targets are
deduplicated by target ID and sampled uniformly. Multiple placements do not
increase a target's probability. The selected target's display locator prefers
the anchor campus, then other canonical campus IDs, then global. A necessary
unknown source or Review fails the complete query; an explicit denied path may
be excluded while another valid path remains. No legal requested category yields
`RATING_NOT_FOUND`; a legal category with no eligible targets yields a known empty
pool. Neither result substitutes for unknown coverage.

Create a context with an explicit selector, purpose and mode. Purposes are
`read`, `interact`, `create_target`, `edit_target` and `random`; only `read` accepts
`admin_preview` as an alternative to `public`. Preview is not ordinary write
permission. Contexts bind the account/session, selector, current identity,
source/head/protocol generation and deadlines. Their maximum lifetime is 300
seconds, shortened by any required owner expiry. A token is a proof reference,
not bearer authority: each use checks current owners again. Two independent
context issuances do not advance public source epochs or invalidate one another.

Queries and bodies are strict. All scoped routes require authentication and use
`Cache-Control: no-store` and `Vary: Authorization`. IDs/revisions, filters,
continuations and operation schemas are defined by OpenAPI. Read continuations
bind the exact context/generation and route filters; changing actor, session,
purpose, scope, category or sort cannot reuse an old continuation. A stale context
must be refreshed explicitly. An already prepared command must not silently
replace its context or intent under the original request key.

## Route registry

There are 33 `/v2/ratings` routes and six `/v2/me/ratings` notice routes. Operation
IDs use the exact `ratingScoped` prefix below. Preparation, cancellation and
context endpoints are included in the route count but are not additional domain
command operations. Unread counts and read-state updates keep their existing v1
routes and notice identities.

| Method | Path                                                          | Operation ID                                  |
| ------ | ------------------------------------------------------------- | --------------------------------------------- |
| POST   | `/v2/ratings/contexts`                                        | `ratingScopedCreateContext`                   |
| POST   | `/v2/ratings/locators/resolve`                                | `ratingScopedResolveLocator`                  |
| GET    | `/v2/ratings/categories`                                      | `ratingScopedListCategories`                  |
| GET    | `/v2/ratings/targets`                                         | `ratingScopedListTargets`                     |
| GET    | `/v2/ratings/targets/:id`                                     | `ratingScopedGetTarget`                       |
| GET    | `/v2/ratings/targets/:id/my-score`                            | `ratingScopedGetMyScore`                      |
| GET    | `/v2/ratings/targets/:id/score-summary`                       | `ratingScopedGetScoreSummary`                 |
| GET    | `/v2/ratings/targets/:id/comments`                            | `ratingScopedListComments`                    |
| GET    | `/v2/ratings/comments/:id`                                    | `ratingScopedGetComment`                      |
| GET    | `/v2/ratings/comments/:id/discussion`                         | `ratingScopedGetDiscussion`                   |
| GET    | `/v2/ratings/comments/:id/replies`                            | `ratingScopedListReplies`                     |
| GET    | `/v2/ratings/replies/:id`                                     | `ratingScopedGetReply`                        |
| GET    | `/v2/ratings/replies/:id/position`                            | `ratingScopedGetReplyPosition`                |
| GET    | `/v2/ratings/comments/:id/like`                               | `ratingScopedGetCommentLike`                  |
| GET    | `/v2/ratings/replies/:id/like`                                | `ratingScopedGetReplyLike`                    |
| GET    | `/v2/ratings/targets/:id/subscription`                        | `ratingScopedGetSubscription`                 |
| POST   | `/v2/ratings/subscription-states/query`                       | `ratingScopedQuerySubscriptionStates`         |
| GET    | `/v2/ratings/subscriptions`                                   | `ratingScopedListSubscriptions`               |
| GET    | `/v2/ratings/random-target`                                   | `ratingScopedGetRandomTarget`                 |
| PUT    | `/v2/ratings/targets/:id/my-score`                            | `ratingScopedSetScore`                        |
| PUT    | `/v2/ratings/comments/:id/like`                               | `ratingScopedSetCommentLike`                  |
| PUT    | `/v2/ratings/replies/:id/like`                                | `ratingScopedSetReplyLike`                    |
| PUT    | `/v2/ratings/targets/:id/subscription`                        | `ratingScopedSetSubscription`                 |
| POST   | `/v2/ratings/targets/:id/comments`                            | `ratingScopedCreateComment`                   |
| POST   | `/v2/ratings/comments/:id/replies`                            | `ratingScopedCreateReply`                     |
| POST   | `/v2/ratings/management/prepare`                              | `ratingScopedPrepareTarget`                   |
| POST   | `/v2/ratings/management/targets`                              | `ratingScopedCreateTarget`                    |
| POST   | `/v2/ratings/management/cancel`                               | `ratingScopedCancelTargetCreation`            |
| GET    | `/v2/ratings/management/owner-edit/targets/:targetId/context` | `ratingScopedGetEditContext`                  |
| POST   | `/v2/ratings/management/owner-edit/prepare`                   | `ratingScopedPrepareTargetEdit`               |
| POST   | `/v2/ratings/management/owner-edit/commit`                    | `ratingScopedCommitTargetEdit`                |
| POST   | `/v2/ratings/management/owner-edit/cancel`                    | `ratingScopedCancelTargetEdit`                |
| GET    | `/v2/ratings/requests/:requestId`                             | `ratingScopedGetRequest`                      |
| GET    | `/v2/me/ratings/updates`                                      | `ratingScopedListUpdates`                     |
| GET    | `/v2/me/ratings/updates/:noticeId/target`                     | `ratingScopedResolveUpdateTarget`             |
| GET    | `/v2/me/ratings/like-updates`                                 | `ratingScopedListLikeUpdates`                 |
| GET    | `/v2/me/ratings/like-updates/:noticeId/target`                | `ratingScopedResolveLikeUpdateTarget`         |
| GET    | `/v2/me/ratings/subscription-updates`                         | `ratingScopedListSubscriptionUpdates`         |
| GET    | `/v2/me/ratings/subscription-updates/:noticeId/target`        | `ratingScopedResolveSubscriptionUpdateTarget` |

Categories support direct-child navigation through `parentId`. There is no new
`categories/:categoryId/descendants` alias. New request recovery uses the single
v2 `GetRequest` endpoint; legacy family-specific recovery routes remain intact.

## Eight commands and shared business state

| Scoped request operation         | Existing business action                             |
| -------------------------------- | ---------------------------------------------------- |
| `set_score_scoped`               | Set the account's integer score with CAS             |
| `create_comment_scoped`          | Publish a reviewed root comment                      |
| `create_reply_scoped`            | Publish a reviewed flat reply                        |
| `set_comment_like_scoped`        | Set desired root-like state                          |
| `set_reply_like_scoped`          | Set desired reply-like state                         |
| `set_target_subscription_scoped` | Set desired target subscription state                |
| `create_target_scoped`           | Prepare and publish a new generic target             |
| `edit_target_scoped`             | Prepare and publish creator-only target text changes |

Wire protocol 2, Review version 5 and native journal version 9 are independent
version spaces. The canonical command hash includes the exact scoped context
and payload. Create/edit commits also supply `preparationContextRevision`, returned as
`contextRevision` by preparation. Every operation uses the shared account/request
namespace: a key
cannot be reused across v1/v2 operations or changed intent. Applied/noop/closed
outcomes retain exact causal proof and minimal receipts; unknown infrastructure
or source failures do not manufacture terminal rejections.

Targets, definitions, scores, personas, comments, replies, likes, subscriptions,
Experience and captured effects remain shared business identities. A target
placed in several campuses has one score/history and one subscription per actor.
Domain transitions retain their existing operation/effect families through an
explicit closed registry, not a string-suffix fallback. Same-key retries do not
repeat rewards, notices or fresh-zero baselines. New target publication proves
its exact placement and affected catalog set atomically. Editing keeps
creator-only authority, immutable origin/category and continuous definition
history; selecting a campus does not grant administrator editing rights.

Review v5 binds the complete scoped intent, exact prepared output and source
context for target/comment/reply text. Category base and override sources have
separate exact Review purposes and bindings. Current category ancestors, target
definitions and content remain independently qualified. Existing Review v1–v4
records and hashes are preserved, including mixed legacy/scoped descriptor
batches. Metadata-only changes cannot revive revoked text.

## Compatibility, adoption and activation

The source/compiler pipeline uses immutable typed attestations, exact placements,
complete source vectors, reviewed category lineage, sealed catalogs and atomic
head CAS. Missing coverage is unavailable, not an empty catalog. Opaque legacy
adoption requires an independent complete manifest/crosswalk and accepted Review
source. It does not turn an opaque category into a native identity, change a
target's business category or infer mapping from matching names or IDs.

Typed `global_compat` compares only the independent global projection.
`region_compat` proves the complete physical campus domain for that region,
including proven empty campuses and negative dependencies. Local divergence does
not by itself invalidate independent global compatibility. Divergent/unresolved
legacy views keep their historical head but cannot use it as current authority.
When campuses converge to new equal content, a new typed canonical legacy
projection must be published with exact current sources; an `equal` label alone
cannot make an old body current.

Legacy fresh writes require their own `native_v1_compat_write` source proof.
Read equality alone does not grant a write bridge. A legal bridge retains the
original v1 operation, selector, hash, Review and receipt, while atomically
updating every affected scoped/compat/legacy head. M1/M3A publication cannot
advance only one side; M2 retains immutable before-evidence and verifies its
actual after-state. Missing bridge evidence fails fresh adopted-domain writes
closed. Historical receipt recovery, cancellation and authorized hidden cleanup
retain their original independent eligibility and do not require a new visible
campus path.

Protocol states are `legacy_only`, `ready` and `adopted`, with monotonic phase
protection. Ready output neither activates v2 nor disables old fresh writes.
Activation must revalidate current sources, all affected heads, exact deployment
capabilities and deadlines, then publish scoped/compat/protocol generations in
one transaction. A stale source, old writer winning a race, incomplete capability
set or failed CAS rolls the transaction back. Adopted state cannot be silently
reverted to recover obsolete legacy authority. Registered routes and synthetic
capability attestations are not evidence of a real production deployment.

## Native recovery and notifications

Native journal v9 uses the same single pending slot as v1–v8. Earlier journal
bytes, hashes, receipt routes and cancellation remain unchanged. Recovery checks
the original key first, before requesting fresh scope authority. Session/account
changes, scope changes, hide, Back, Close and late callbacks clear private drafts
and prevent a new commit; they do not erase the original pending journal. A
changed intended scope requires a new intent/key after the previous request is
recovered or canceled. Locator generation travels across catalog, target,
discussion, random and notice navigation; read and interaction purposes remain
separate.

Existing notice IDs, captured effects and read history remain intact. Scoped
fan-out qualifies each recipient using that recipient's current Campus selection
and current source/placement/Review authority, not the sender's scope. Unknown
recipient authority stays retryable; explicit denial can suppress delivery.
Divergent adoption may leave a historical notice metadata-only until the user
chooses an explicit currently legal locator. Clicking it rechecks current access;
stale or unauthorized callbacks do not navigate or mark history read. This is
local notice behavior, not evidence of external push-provider delivery.

## Final proof, maintenance and capacity limits

After deferred constraints flush, mandatory proofs use bounded NOWAIT fences,
complete snapshots and final SQL time checks. Failure rolls back tentative
business artifacts, epochs and receipts. Timeouts, owner capacities and unknown
semantics are not relaxed to improve availability.

The context snapshot owner fences `scoped_source_epoch` and
`scope_protocol_epoch` with explicit relation `ROW SHARE NOWAIT` plus all retained
rows `FOR SHARE NOWAIT`. Registered BEFORE STATEMENT writers perform ordinary
epoch UPDATE before business mutation, including zero-row writes. Readers reject
an existing writer immediately; a later writer waits until the retained reader
row lock is released. Complete fixed-shape snapshots still reject missing, extra
or changed epoch metadata. `scoped_catalog_heads` and `scope_protocol_heads`
retain whole-relation `SHARE NOWAIT` fences.

Context records separately use a database-generated immutable full-record digest
and exact-row NOWAIT proof, allowing overlapping unrelated issuances. Safety and
Campus count readers use their retained epoch relation `SHARE NOWAIT` fence;
existing writer and overflow contracts remain unchanged.

Real nontruncating VACUUM of the two scoped epoch tables was verified to overlap
a successful HTTP final proof with unchanged epochs. This does not guarantee
availability during every maintenance operation. Other release, compatibility,
legacy-bridge, head, Safety and Campus relation SHARE fences may conservatively
conflict with maintenance. EXCLUSIVE/ACCESS EXCLUSIVE DDL and truncation can also
block the explicit relation fences; final proof fails closed rather than waiting
or accepting stale authority.

Development limits include 1,000 campuses/200 regions, 1,001 scope heads,
10,000 distinct random targets/50,000 paths and 64 MiB bounded data. Whole-release
ceilings are 100,000 categories and 100,000 memberships. These are admission
ceilings, not accepted production capacity. Focused scale evidence covers 2,048
distinct targets, 6,144 real paths, a 1,001-child subtree and more than 520 mixed
Review descriptors. Over-budget work returns unavailable without truncation.

M3C category/base/override editing, ordering, activation/archive management,
batch/system administration and related authoring UI remain separate work. M3D
production source reconciliation, accepted adoption/import and operational
cutover also remain outstanding. Real issuers/providers, production load and
physical-device acceptance require their own release evidence.
