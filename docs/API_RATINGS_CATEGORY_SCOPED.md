# Scoped rating category management M3C

Status: implementation with integrated full local acceptance passed,
2026-10-10 UTC. API and native integration are implemented on the accepted M3B
baseline. All 5,543 mandatory local tests passed, including the complete PostgreSQL
and semantic suites. Hosted and physical-device acceptance remain pending.
Production grants, category source issuance policy, exact Review provider,
authoritative adoption/import and operational activation remain separate gates.
See [M3C acceptance](acceptance/ratings-m3c.md), [M3B API](API_RATINGS_SCOPED.md)
and [feature parity](FEATURE_PARITY.md).

## Boundary and routes

Eight category-management routes extend the existing 39 scoped routes. They use
the same authenticated Ratings request guard, account-wide rate limit,
`Cache-Control: no-store`, `Vary: Authorization` and safe error envelope. Bodies
and queries reject unknown fields. GET bodies must be absent or empty. The
existing v1 category-creation endpoints and all historical command bytes remain
separate.

| Method | Path                                                             | Operation ID                                  |
| ------ | ---------------------------------------------------------------- | --------------------------------------------- |
| POST   | `/v2/ratings/category-management/contexts`                       | `ratingScopedCategoryManagementContext`       |
| GET    | `/v2/ratings/category-management/categories`                     | `ratingScopedCategoryManagementList`          |
| GET    | `/v2/ratings/category-management/categories/:categoryId`         | `ratingScopedCategoryManagementDetail`        |
| GET    | `/v2/ratings/category-management/categories/:categoryId/history` | `ratingScopedCategoryManagementHistory`       |
| GET    | `/v2/ratings/category-management/system-options`                 | `ratingScopedCategoryManagementSystemOptions` |
| POST   | `/v2/ratings/category-management/prepare`                        | `ratingScopedCategoryManagementPrepare`       |
| POST   | `/v2/ratings/category-management/commit`                         | `ratingScopedCategoryManagementCommit`        |
| POST   | `/v2/ratings/category-management/cancel`                         | `ratingScopedCategoryManagementCancel`        |

`GET /v2/ratings/requests/:requestId` remains the single scoped request-recovery
route (`ratingScopedGetRequest`). Its response decoder adds only the strict
category receipt union. Public/target command endpoints continue using their
original receipt and intent schemas.

## Native workspace

The authenticated scoped catalog offers the category-management entry, which
checks fresh authority for its explicit selected view. The registered pages are
`/pages/rating-category-manage/rating-category-manage` and
`/pages/rating-category-editor/rating-category-editor`. Both accept only `scope`
(`global` or `campus`), the required `campusId` for a campus view, and optional
`categoryId`; a route never carries a grant, preparation or draft body.

The workspace lists and inspects current categories, reads metadata history and
registered system options, edits one of the nine explicit operations, previews
all affected views, and requires an explicit commit. Pending v10 work is loaded
before new current-state reads; generic recovery only asks for the original
receipt and never silently resubmits a fresh category edit. Returning to the
catalog loads fresh published data. Logout/relogin and account/scope/background
changes invalidate old pending callbacks and rebuild only fresh navigation.

## Context and read shape

Context input is an explicit selector: `{kind: 'global'}` or
`{kind: 'campus', campusId}`. Independent global is never encoded by an empty
campus list. The server creates a category-only `manage_categories` /
`management` context. A public context, managed preview, copied context body or
client-supplied authority flag cannot grant management access.

The result includes `commandContext`, `snapshotRevision`, `expiresAt`, authorized
`campusIds`, `canManageGlobal` and the current policy's supported `operations`.
Context validity is at most five minutes and shortened by required owner
expiry. The full command context and exact snapshot revision are retained with a
pending operation. Reissuing a context does not reinterpret an older request.

Read queries require `contextId` and `contextToken`. List returns a bounded
complete selected-view set (`items`, `snapshotRevision`, `complete: true`) with
at most 10,000 categories; no unknown source is converted to an empty catalog.
Current service filtering is performed over this complete set, rather than
accepting undocumented parent/status query parameters. Detail exposes stable
identity/topology, base/override/effective text, exact placement and current
revisions, ordinal, business state, hidden state and an unavailable reason.
Text that fails current source/Review qualification is not historical permission
to display it. History is metadata-only, up to 100 records with an optional
`cursor`; it does not return raw approvals, grant evidence or old reviewed text.
System options expose only currently supported registered key/kind/depth/policy
choices, not arbitrary legacy system labels.

## Authority

Fresh commands require the existing account/session, phone and Safety
qualification plus explicit current category authority. The Authorization owner
composes real developer/super-admin grants, existing exact operating-region
school-admin grants and a new narrowly typed exact-campus category grant.
Exact-campus grants never become a region grant or an `ActiveGrant` for other
products. Grants are not seeded by migration, deployment or first login.

Region coverage expands through the current complete Campus inventory. Shared
changes require every affected exact campus, including removed placements,
dormant dependencies, descendant paths and compatibility domains. Global
placement, scope replacement and protected system changes require the applicable
global authority. Campus override/visibility and sibling ordering use their
precise selected view and applicable system/global policy. Current global
privilege never substitutes for source provenance, a registered handler or an
exact body Review.

## Nine explicit operations

All intents contain `protocolVersion: 2`, an exact `context`, `operation`, and a
strict operation-specific `payload`. Every payload contains `clientRequestId`
and `expectedSnapshot`. Commit accepts `{intent, preparationContextRevision}`;
prepare and cancel accept the original intent directly.

All numeric collection limits also remain subject to the existing 64 KiB
(65,536-byte) HTTP JSON request-body limit. This is UTF-8 encoded serialized JSON,
including escaping and the complete wrapper, not a JavaScript character count.
The native workspace checks the largest prepare, commit and cancel body before
freezing a new journal entry, using the real 43-character preparation token shape
and a further 1,024-byte forward-compatibility reserve. Receipt lookup is GET and
has no request body; response receipts and HTTP headers are not counted as body.
An oversized draft stays editable without a journal or network mutation. A full
sibling permutation cannot be silently sliced into multiple requests; an
oversized complete set is explicitly unavailable for submission. Direct API
clients must respect the same server body limit. Future request-envelope changes
must update the preflight and its boundary tests rather than consuming the
reserve silently.

| Operation                           | Payload-specific fields and intent                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_categories_scoped`          | `parentId`, explicit `placement`, ordered `nodes`; up to 32 stable-key nodes, depth at most three                                                       |
| `edit_category_base_scoped`         | `categoryId`, `name`, `description`; shared base text, full dependent override re-review                                                                |
| `set_category_override_scoped`      | `categoryId`, explicit `name` and `description` mode unions for the selected campus                                                                     |
| `set_category_visibility_scoped`    | `categoryId`, `hidden`; selected-view visibility, separate from shared lifecycle                                                                        |
| `reorder_categories_scoped`         | `parentId`, `action` (`set` or `inherit`), complete `orderedIds`; exact sibling-set CAS                                                                 |
| `set_category_scope_scoped`         | `categoryId`, replacement `placement`, `propagation` (`self` or `subtree`); no target move                                                              |
| `set_category_lifecycle_scoped`     | `categoryId`, `state` (`enabled`, `disabled` or `archived`), `restore`; shared business state                                                           |
| `batch_update_subcategories_scoped` | `parentId`, direct-child `addNodes` (every `parentKey` is null), `disableIds`, `restoreIds`, `enableIds`, exact `orderedChildren`; one atomic operation |
| `create_system_category_scoped`     | `systemKey`, `name`, `description`, explicit `placement`, `levelCount`; supported registry plus global authority                                        |

Placement is either `{kind: 'global'}` or `{kind: 'campuses', campusIds: [...]}`
with a nonempty, unique, sorted set of canonical IDs. An override field is either
`{mode: 'inherit'}` or `{mode: 'set', value}`. Name must be nonempty; description
may be an explicitly set empty string. Missing fields, null and empty text do not
stand for inheritance. Returning an existing override to inherit/inherit retains
a reset successor rather than deleting the source head. An already inherited
field set is an exact no-op, including absence of an override source.

Disable/archive affects the shared category and therefore all applicable paths;
hide affects only one view. Restore returns an archived category to disabled,
not automatically public. Existing hidden state and descendant lifecycle remain
separate. Category identity, parent/kind/system key, target origin/category,
ratings, comments, subscriptions and history are not silently moved or deleted.
There is no hard-delete category endpoint.

Ordering submits the complete current sibling permutation, including management
metadata for hidden/disabled/archived siblings. The server assigns existing
ordinal slots. Sorting does not issue new body Review envelopes or revive old
approvals; current inherited body and ancestor qualification still apply.

## Scope changes and historical sources

An authorized manager can replace a category's campus set or switch between an
independent global placement and a nonempty campus set. `self` must retain every
child's valid parent coverage; `subtree` explicitly includes all descendants,
including descendants absent from the selected campus. The confirmation shows
all removed, retained, added and dormant dependency scopes.

Compatible multiple base sources can be consolidated atomically when their
stable identity, shared text/structural definition, base active/hidden/ordinal
metadata and shared business state agree. Every old placement is succeeded or
retired, and every dependent override, lifecycle and ordering source is
accounted for. The chosen retained identity is not a new business ID. Conflicting
sources return `RATING_CATEGORY_SOURCE_UNRESOLVED`; the UI does not silently
choose the selected campus. Administrators may explicitly reconcile shared text
or business state through their normal reviewed commands. Identity/mapping or
other unsupported metadata conflicts require authoritative source resolution,
not fabricated history. Normal reading, owner cleanup and committed receipts
remain independent of that management conflict.

Old M3B lifecycle records remain byte-identical. A new typed succession names
its exact predecessor and, if necessary, partitions a multi-campus source into
complete one-campus successors. Old inactive means disabled; no historical
archive decision is invented. Dormant partitions are retained and updated in the
same all-of transaction.

Target membership is current category eligibility intersected with the target's
original placement. Scope shrink, disable, hide and archive tighten public
visibility and fresh interactions, while original target placement, business ID,
score/comment history, notifications and success receipts remain intact. An
original author can still use hidden-parent cleanup and receipt-only recovery.

## Preparation, publication and recovery

Preparation allocates stable IDs and captures exact before-state, complete
impact, authority, source and policy facts. The preview reports category IDs,
affected scopes, source-change count, affected-target count, changes,
`previewDigest`, `contextRevision` and expiry. Shared text changes have a
`base_body` row and individual `effective_body` rows for every affected view;
explicit set values (including an empty description) remain set, while inherit
follows the new shared base. Scope and hidden/dormant applicability are explicit.
Each row has `beforeStatus` and `afterStatus`: `available`, `absent` or
`unavailable`. Unavailable text is null, never a fabricated empty string. Current
base, override and exact-scope ancestor Review qualifications protect historical
text, including dormant overrides. The user's new text is a proposed draft and
is not evidence of approval. A cached preparation is revalidated before any
preview is returned; a later held/revoked Review cannot replay cached plaintext.
Native confirmation pages show bounded pages of the complete change list, all
bound to the same digest; they do not truncate the impact that will be committed.

Preparation does not publish source heads,
placements or catalog epochs and does not call an external provider inside a
commit transaction.

Commit validates the original intent and preparation token, checks current
owners and CAS before deciding noop, consumes exact Review v5 base/override
bodies where required, issues verified successors and atomically publishes
scoped and compatibility outputs with a durable outcome. No category command
uses a fabricated target ID or target-content version. Unknown dependencies,
missing policy, unavailable Review or incomplete topology fail closed. Every
operation is independently checked against its exact requested result in SQL:
an empty plan must prove the whole desired state already exists, and an applied
plan must cover every requested node/field/view with no unrelated business
change. An auxiliary absence-source refresh is not a successful operation.

Compatibility exits bind each old domain's exact observed compatibility version
and legacy catalog to the original intent, preparation, new typed sources and
same-transaction release. A boolean `authorizedExit` or a catalog copied from a
different domain cannot authorize removal. Existing native target creation and
legacy bridges retain their own exact causal owners when succeeding a shared
absence source; stripping a managed category's issuer label or using a fresh
metadata key cannot bypass management authority. The entire published source
vector is exactly the observed vector minus planned predecessors plus planned
derivatives, so unrelated foreign sources cannot be smuggled into the same
transaction. Coverage inventories are independently derived from the unchanged
target placements and exact planned category placements. Descendants of a
managed system category must use its typed registry-authorized management path,
including when a child is inserted before its parent.

Receipts contain only `protocolVersion`, `requestId`, `operation`, `intentHash`
and an exact `applied|noop|closed` branch. Successful results carry `releaseId`,
`categoryIds`, affected `heads` and `occurredAt`; a closed result carries a bounded
safe code. No historical body or private source reference is included. The shared
account/request namespace prohibits reuse for another operation or changed
intent. An already committed result wins over retry/cancel. Receipt recovery and
original-intent cancellation do not require renewed current management grants
or a currently visible category path.

Native category pending work uses its separate journal v10 branch. It retains
the original operation/context/hash across interruption, account change and
receipt recovery; v1–v9 journal and Review v1–v5 byte contracts are not redefined.
Media and external assets are not enabled by this slice. Exact source/Review
issuers, legacy crosswalk/import, production activation and device validation
must be accepted independently.
