# Related-campus ordinary-post sync

The existing composer, school posting-policy page, community discovery pages and
management pages share one canonical post and discussion. This is a bounded
implementation with synthetic validation fixtures, not production activation or
physical-device acceptance.

## Publication and recovery

- School policy saves use strict version 2 with an explicit
  `policy.relatedSyncEnabled`. Historical unversioned commands and journals keep
  their original hashes and recovery paths.
- The composer defaults to no synchronization. A current allowed
  `relatedCampusSync` advisory offers a separate explicit switch and explanation.
  Its accepted author modes and comment-control hints are separate from the old
  local named-text reviewer. Final Review, Safety, Media and publication checks
  remain server-owned.
- Only true contributes `syncToRelatedCampuses` to the original publication hash,
  after `allowAnonymousDm`. False and omission are identical. Media protocols and
  existing absent/explicit-none component and DM hashes stay unchanged.
- An unfrozen selection resets when loading another composer, reloading or
  stopping. It is not a durable preference. Frozen pending requests preserve
  their exact flag and optional public viewing-space locator through account
  isolation, reload, original-key retry and cancellation.
- Comments and replies never send an independent sync flag. The server supplies
  an optional inherited-sync capability hint so the native UI does not impose
  the old local named-text heuristic on a related root's children.

## Discovery and navigation

`Post.space` and search-hit space remain the canonical original space. Remote
projections alone show the server-proved safe source-region badge. Detail,
thread, composer and pin navigation retain optional `viewSpaceId` separately;
that locator grants no authority. Page reload and discussion continuation
revalidate the selected view. Links to a different post's historical recovery
remain canonical unless its own journal retained a viewing space.

Feed, lexical search and hot pages accept optional `relatedCampusDistribution`.
An unavailable page explicitly says its related-school coverage is incomplete
and does not present a complete empty result or full-stream end. Semantic
unavailability remains its own error and never silently falls back to lexical
or local-only search.

## Scoped management

Fresh pin, unpin and read acknowledgements use strict version 2 plus the exact
destination space. Related-destination post/comment/reply removal uses pure
version 3 plus `viewSpaceId`, without punishment controls. Canonical-origin
compound removal and historical command recovery retain their prior contracts.

Nickname, avatar and category actions consume their own server capability
branches. Their related-target unavailable results do not expose private
profile/appearance data or enable confirmation. The source badge is never used
as a permission signal, including at the origin where it is false.

## Validation entrypoints

- `test/related-campus-sync.test.ts`: intent/hash compatibility, strict DTOs,
  original-key recovery, interrupted composer/account transitions, destination
  reads, related-only capabilities and versioned school-policy transport.
- `test/related-campus-navigation.test.ts`: template scope, unrelated recovery
  links and truthful incomplete discovery state.
- Existing pin/removal/profile/avatar/category test files include versioned
  commands, legacy golden hashes and unavailable capability regressions.
- `scripts/smoke-related-campus-sync.mjs`, registered in `smoke-build.mjs`, uses
  emitted Page handlers, the real native gateway/decoder and durable journal
  with synthetic transport responses.
- `../api/test/integration/related-sync-native-runtime.test.ts` runs
  `scripts/related-sync-native-child.mjs` against emitted App/Page/WXML and the
  production native gateway/decoder over real loopback HTTP to a normal
  AppModule and disposable PostgreSQL. It covers explicit settings and identity,
  Review and lost-response recovery across account switch/reload, shared
  discovery and discussion, scoped pins and pure removal, unsupported actions,
  topology withdrawal and a newly related destination. The parent inspects
  exact durable receipts and immutable origin evidence. Initial verification,
  topology, administration and Review acceptance are explicit synthetic facts;
  this test does not install a production policy or replace application owners.

The integration task records executed, failed and unrun checks on the final
combined tree. This document does not claim a validation pass.
