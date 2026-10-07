# Transaction-bound community scope facts

These are private owner facades, exported by `CampusModule`. They never read a
profile's browsing campus, public school code, phone value or student number.
The original community authority readers remain read-only. The separate own-account
selector adds explicit current-choice writes only; see
[the selector contract](../../../../../docs/API_IDENTITY_CAMPUS.md). There are no
topology/configuration write providers, seeds or startup data. An empty migrated
application cannot infer either an identity choice or community configuration.

## Owner API

`CampusCommunityPolicyService.resolve(accountId, affiliation, targetRegionId, tx)`
consumes already validated, transaction-bound verification metadata:
`{ assertionId, snapshotId, institutionId, originRegionId, validUntil }`.
The caller must obtain it from the verification owner under the same transaction.
A null target denotes explicit global scope.

The valid result contains `campusId`, `institutionId`, `identityRegionId`,
`originRegionId`, `selectionId`, `topologySnapshotId`, `validUntil`, and relation
`home | related | foreign | global`. These fields are internal and must not be
spread into anonymous public DTOs. Same identity region is home; a different
active member of the explicit same group is related. A complete singleton proves
no related region. Same institution alone proves no relation.

`selection_required` is returned only for a current, covered, accepted immutable
selection event explicitly asserting that state. No head, missing/conflicting
coverage, stale affiliation or topology binding, inactive campus/region, wrong
institution, incompatible assignment or expired provenance is `unavailable`.
The resolver never silently keeps an old choice or selects an origin campus.

`sameGroup(regionA, regionB, tx)` independently returns
`{ status: 'known', sameGroup, topologySnapshotId, validUntil }` or unavailable.
This supports target management using immutable publication origin without
consulting an author's current identity selection or affiliation.

`RegionalCommunityPolicyService.resolve(regionId, tx)` independently reads a
community-owned revision. A known result contains `revisionId`,
`unverifiedPostEnabled`, `unverifiedCommentEnabled`, `unverifiedCategories`,
`relatedSyncEnabled`, and `validUntil`. Explicit disabled switches remain known
false values. Unsupported category names are preserved in immutable storage but
filtered from the returned ordinary-category permissions. Trading is never an
unverified exception. The sync switch records known policy; this slice does not
implement synchronization. Missing policy is unavailable. Call this only for
operations that actually depend on it; home/related verified ordinary publication
and phone-only interactions must not acquire an irrelevant dependency.

## Immutable snapshot payload

All relationship edges are inside one JSONB value so adding an edge cannot mutate
an already reviewed snapshot. Version 1 has exactly this shape:

```json
{
  "version": 1,
  "groups": [{ "groupId": "<uuid>", "coverage": "complete", "isActive": true }],
  "regions": [
    {
      "regionId": "<uuid>",
      "institutionId": "<uuid>",
      "groupId": "<uuid>",
      "coverage": "complete",
      "isActive": true
    }
  ],
  "assignments": [
    {
      "campusId": "<uuid>",
      "institutionId": "<uuid>",
      "regionId": "<uuid>",
      "coverage": "complete",
      "isActive": true
    }
  ]
}
```

Each group, region and physical campus appears at most once, even for repeated
identical entries. Every region refers to an explicit group; every assignment
refers to a region with the same institution. Duplicate or contradictory payloads
are unavailable. Each item's coverage can instead be `missing` or `conflicting`;
a requested region needs complete active membership. Missing members are unknown,
never evidence of being unrelated. Eligible identity campuses must share both
the verified institution and the verified origin's explicit school-subject group.
Current physical campus activity/institution and the actual current
`campus_region_assignments` row must still agree with the snapshot.

## Persistence and test-only fixture construction

The additive migration creates these empty tables:

- `whaleu_campus.community_topology_snapshots` and `community_topology_heads`
- `whaleu_campus.community_identity_selections` and `community_identity_heads`
- `whaleu_community.region_policy_revisions` and `region_policy_heads`

Each immutable fact has `coverage_state` (`complete | missing | conflicting`),
`provenance_state` (`accepted | unknown | conflicting`), `source_reference`,
`policy_reference`, `effective_at`, `expiry_kind`, and `valid_until`.
Accepted runtime facts require complete coverage, accepted provenance, nonblank
references, a nonfuture effective time, and an explicit unexpired validity model.
`expiry_kind='policy_exempt'` requires null `valid_until`; `at` requires a later
non-null deadline; `unknown` never authorizes. No special source label or account
is privileged by readers. Synthetic fixture labels carry no runtime bypass.

A disposable integration fixture should create real institution, region, physical
campus and campus-assignment rows, and canonical verification assertion/snapshot
rows first. Then insert heads at revision 0 with null pointers, append revision-1
facts, and advance each head to revision 1. For example, with test parameters:

```sql
INSERT INTO whaleu_campus.community_topology_heads(scope_key)
VALUES ('community');
INSERT INTO whaleu_campus.community_topology_snapshots
  (id, revision, coverage_state, provenance_state, source_reference,
   policy_reference, topology, effective_at, expiry_kind)
VALUES ($1, 1, 'complete', 'accepted', 'synthetic-reviewed-topology',
        'synthetic-policy-v1', $2::jsonb, clock_timestamp(), 'policy_exempt');
UPDATE whaleu_campus.community_topology_heads
SET revision=1, snapshot_id=$1 WHERE scope_key='community' AND revision=0;
```

Selection facts additionally require `account_id`, per-account `revision`,
`selection_state`, `campus_id`, `affiliation_assertion_id`,
`affiliation_snapshot_id`, and `topology_snapshot_id`. For explicit
`selection_required`, `campus_id` must be null; for `selected`, it must not be null.
A trigger verifies that the verification snapshot and its affiliation assertion
belong to the selected account. The selection head's pointer is `selection_id`.
A later verification snapshot, even if only another verification fact changed,
requires a newly reconciled selection event. This conservative exact-revision
binding is deliberate; there is no runtime migration of old selections.

Region policy facts require `region_id`, per-region `revision`,
`unverified_post_enabled`, `unverified_comment_enabled`,
`unverified_categories` (explicit text array, including `ARRAY[]::text[]` for none),
and `related_sync_enabled`. Its head's pointer is `revision_id`.
The head keys are respectively `scope_key='community'`, `account_id`, `region_id`.
All head updates advance exactly one revision; head identity changes and deletion
are rejected. All immutable fact updates and deletion are rejected.
A new topology snapshot requires new explicitly bound selection events; do not
edit an existing payload to add fixture campuses or groups.

## Lock and clock contract

The calling use case acquires the common shared outer safety gate first.
Every topology/configuration/selection/active-campus/assignment/region writer
MUST first acquire `lockSafetyPolicy(tx, true)` and hold that exclusive advisory
gate through commit. This is the required cross-domain serialization boundary,
including future writers; head locking alone is not a substitute. All six new
owned tables additionally enforce the exclusive gate using BEFORE STATEMENT
INSERT/UPDATE/DELETE triggers, before their statement's row locks. Multi-statement
writers must still acquire it before any earlier SELECT FOR UPDATE; a later
trigger cannot repair locks already taken. Migration 0017 subsequently adds the same statement gates to institutions,
campuses, regions and assignments, including catalog inserts/deletes, so complete
option enumeration is phantom-safe. Future multi-statement writers must still
follow the same outer-gate-first protocol. Campus resolution share-locks the singleton topology head, then the account selection
head. It separately reads the immutable records after acquiring those locks, so
an initially null pointer is stable and a waited-on head is reread consistently.
Required active regions are share-locked in UUID order, followed by the physical
campus, institution and assignment. Configuration reads take the active region
and then the region policy head. Publication ancestry may read a parent's approval
before evaluating publication scope; all such reads hold the shared safety gate,
and exclusive writer serialization prevents cross-domain lock inversion with
writers. `sameGroup` needs only topology plus deterministically ordered region rows.

After obtaining the exclusive outer gate, any future writer must use a consistent
local head order, update-lock stable heads before changing current authority,
and leave immutable history untouched. A topology
writer that also remaps physical assignments takes topology before selection
heads and physical rows. Configuration-only writers need no topology head.
If batching multiple account/region heads, acquire each class in UUID order.
Missing heads return unavailable; a concurrent insertion cannot turn a denied
request into an authorized one, and readers never create placeholder rows.

Every successful owner read checks a fresh database clock after all potential
waits and registers its locked deadlines for the final post-deferred-constraint
transaction check. No network or provider work occurs under these locks.

Production topology/configuration administration and trusted fact issuance remain
separate unfinished work. Explicit own-account selection is now implemented by
IdentityCampusModule, without changing these readers' authorization contract.
