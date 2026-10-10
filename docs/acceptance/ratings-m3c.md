# Scoped rating category management M3C acceptance

Status as of 2026-10-10 UTC: implementation and integrated full local acceptance
passed (5,543 tests; zero failures, skips, cancellations or TODOs). Hosted acceptance
remains a separate pending gate. The accepted M3B baseline is `4d4c77776062cfb44d6134f453f49066602fb493`;
its 5,364 local tests are not evidence for this new code.
See the [API contract](../API_RATINGS_CATEGORY_SCOPED.md).

## Code under acceptance

- Eight authenticated category-management v2 routes with exact schemas and
  shared Ratings guard/private cache headers
- Category-only Authorization and exact Campus management-domain proofs,
  including real exact-campus grants, all-of impact and bounded batch domains
- Nine strict create/base/override/visibility/lifecycle/scope/order/batch/system
  operation intents, typed preparation/outcome/recovery contracts
- Review v5 base/override reuse; metadata-only operations do not manufacture a
  body approval, while current body/ancestor qualification still gates text and
  public consumption
- Source issuance, immutable planning, atomic scoped/compatibility release and
  original-intent receipt/cancel integration
- Native category workspace and separate journal v10 recovery branch
- Additive OpenAPI source and public contract; generated artifact must be
  regenerated and verified during the execution gate

These are implementation scope statements, not a declaration of completed
business parity, tested behavior or production availability.

## Validation record

| Gate                                                        | Current M3C result                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent review                                          | Native/recovery completed; additional independent core review cancelled before final sign-off (not a pass)                                           |
| Required cheap pipeline                                     | Passed: lint, workspace TypeScript, stats 5, search evaluation 20, API units 1,339, native units 1,980, OpenAPI checks and both builds/emitted smoke |
| Formatting and diff checks                                  | Passed on final documentation and unchanged tested source                                                                                            |
| Development real PostgreSQL                                 | New authority/upgrade matrix 88/88; native nine-operation story passed; named deferred ancestry smoke 1/1                                            |
| Frozen complete focused PostgreSQL                          | Passed: 27 files / 383 tests (843.373 s), then 34 files / 439 tests (538.254 s); 822/822 total                                                       |
| Full repository PostgreSQL                                  | Passed: 2,172 main integration tests and 27 semantic tests; all zero failures/skips/cancellations/TODOs                                              |
| Optional local real-cloc integration                        | Not run successfully: local cloc 2.10 path unavailable; hosted code-stats remains separate                                                           |
| Production authority/source/provider/data/device acceptance | Not established                                                                                                                                      |

Hosted CI for this publication remains pending. Integrated full acceptance contains
5 stats, 20 search evaluations, 1,339 API units, 1,980 native units, 2,172 main
PostgreSQL tests and 27 semantic tests (5,543 total). Full lint/typecheck/OpenAPI,
build/emitted smoke, formatting and diff checks also passed. The full PostgreSQL
stage ran for 43 minutes 11 seconds; only the whole-suite runner budget increased,
not individual query/test performance thresholds.

Update this record only from executed results for the exact final tree. Do not
turn written unit tests, fixture issuance, static SQL inspection, a local build or
a previous phase's CI into a PostgreSQL or production acceptance claim.

The required cheap pipeline contains 3,344 tests, all passing with no skips or
cancellations. Old migration files 0001–0065 are byte-identical to the accepted
baseline. New additive migrations occupy 0066–0069. The 61-file focused matrix passed 822/822 with no skips or cancellations on
the same frozen source/test bytes. Final documentation updates change only
acceptance wording; source/test fingerprints remain unchanged. Development
runs are recorded separately and are not counted again in the final totals.

## Required adversarial cases

1. Global/region/exact-campus all-of checks; a campus grant cannot write its
   same-region neighbor. Expiry, future activation, absence/phantom insert,
   revocation and rollback invalidate owner handles and final proofs.
2. Public and managed-preview contexts cannot enter management; category
   management cannot grant target publication or broaden creator-only edits.
3. Revoked override and ancestor Review produces metadata-only reads/previews;
   compare exact current effective proof with stored lineage, not only a
   non-null current base. Final Review policy/visibility expiry is fenced.
4. Shared base updates re-review every exact effective dependent override and
   preserve explicit set/inherit modes. One missing authority/Review aborts all.
5. Shrink, base edit and re-add preserve dormant body, order and hidden/lifecycle
   facts. Targets retain original category/origin/placement/history. Parent
   self/subtree closure includes descendants absent from the selected campus.
6. Complete sibling permutation, extra/missing/duplicate IDs, ordinal overflow,
   CAS-before-noop and atomic child batch; sorting issues no body Review.
7. System descendants retain configured depth, key/consumer/registry policy and
   protected lifecycle rules across base succession; unknown handlers block.
8. Multiple placements, native/adopted identity succession, exact absence sets,
   SQL reverse causality and complete compatibility impact reject partial or
   fabricated outputs. Direct SQL cannot bypass fresh issuance/Review.
9. Receipt-first retry and original cancel remain usable after visibility/grant
   changes and across account/session interruption; no duplicate publish,
   rewards, notifications or journal reinterpretation.
10. All nine SQL operations reject forged empty noops and nonempty auxiliary-only
    or partial outputs. Real equality noops keep sources, Review and effects
    unchanged. Create/batch node keys form an exact output identity bijection;
    nested batch parent keys are rejected by API and SQL.
11. Old single/multi-scope B lifecycle upgrades preserve original bytes, exact
    predecessor lineage and all dormant partitions through rollback/replay.
    Same-identity compatible multi-base scope merges are atomic; incompatible
    identity/body/base metadata/state return the explicit unresolved condition.
12. Cross-domain A/B-to-global-and-back publication checks each observed old
    compat version/catalog. Wrong version, catalog, scope set or omitted domain
    fails before any source/head publication. C-owned absence still supports
    legitimate native targets and original legacy bridges.
13. False issuer labels, stripped management fields, new B-shaped keys targeting
    managed bases and direct protected-system operations cannot bypass SQL.
14. Composite transactions cannot smuggle a foreign category, target placement or
    policy into a category release: the exact before-vector minus planned
    predecessors plus planned derivatives is the entire after-vector. Absence
    inventory is independently derived from those immutable placements. A legacy
    source shape cannot borrow a managed system ancestor, even when inserted
    before that parent.
15. Native emitted runtime/manage/editor load without a bare SHA dependency.
    Logout/login/relogin restores usable fresh navigation without resurrecting
    an old awaited path. Redacted previews never replay old override values.
16. One cumulative 64 MiB/release budget, full 1000-campus plus global domain,
    source overflow and final NOWAIT proof capacity under concurrent readers and
    writers; no truncated inventory or arbitrary subset is accepted.

17. Request-body preflight measures the actual prepare/commit/cancel JSON UTF-8
    envelopes and the largest one, including the 43-character preparation token
    and a 1,024-byte reserve below the unchanged 64 KiB HTTP limit. Exact boundary,
    one-byte overflow, Chinese/emoji/escaping and real gateway/Page behavior keep
    oversized complete drafts editable without freezing or sending.
18. The catalog verifier materializes eligibility once per distinct category in
    the current statement. Original 1,001/2,048 real-target scale tests pass with
    the unchanged 60-second statement timeout. Same-category cross-campus paths,
    ancestor subtree scope changes and fresh held/revoked Review remain exact;
    no cross-request eligibility cache is introduced.

## Regression repair record

The first complete 27-file candidate passed 372/373 tests and exposed repeated
recursive category qualification per target in the 2,048-target scale setup.
That candidate was invalidated. The verifier now materializes the already
verified complete category set and its current eligibility once per category,
then joins unchanged target placements. No assertion, timeout or capacity was
relaxed. The original scale file passed 8/8, new current-proof regression passed
3/3, and the full cheap plus both complete focused groups were rerun successfully
on the repaired frozen source tree.

## Production gates remain separate

No grant seeds, implicit first-admin setup, production source reconciliation,
legacy identifier mapping, approval provider, media import or operational
activation is supplied by these changes. Missing real provenance is unavailable,
not synthetic success. Production adoption/import belongs to M3D; physical
WeChat-device behavior, providers and production capacity require their own
recorded acceptance.

## Runner budget

The CI verify job budget increases from 45 to 60 minutes to accommodate the
expanded suite (the accepted M3B verify run consumed 43m53s). Semantic remains
30 minutes. No internal test timeout, capacity limit or assertion is relaxed.
Local focused PostgreSQL runs retain the serial 1,200-second wrapper budget; the
full integration run remains a separate final gate.
