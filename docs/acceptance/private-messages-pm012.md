# PM0–PM2 local text acceptance

Status: focused local validation passed on 2026-10-09, zero failures/skips in the final runs. The private-message module remains PARTIAL. A final normal-AppModule full regression gate, publication and hosted CI are separate checkpoints; none is implied by this working-tree report.

## Delivered local scope

- Immutable named, same-post anonymous and reviewed-opt-in mixed conversation identities; exact profile/post/comment/reply source resolution and retained entry provenance.
- Text-only local list/detail/history/events, independent unread, server-observed read watermarks, owner hide/reopen and incoming restoration, inclusive database-time 120-second recall, and identity-specific bilateral blocking.
- Independent canonical/DM-purpose Verification, Safety and exact DM Review binding/current-state/final-proof integration; missing production evidence remains unavailable.
- Account-owned immutable request receipts and original-key cancellation, including concurrent send/cancel and same-account recovery after logout without private message bodies.
- Native entry/list/detail/recovery pages, exact source actions, separate profile badge, account/session/lifecycle clearing, bounded foreground polling and rendered-visible read acknowledgement.

## Evidence rules

Focused PostgreSQL checks use the ordinary AppModule and a disposable loopback PostgreSQL 18 database, with test-only explicit canonical owner facts. No production issuer, provider consent, credential, real-account grant or historical completeness is manufactured. The real recall boundary test waits through the actual 120-second publication window and a deferred-constraint wait; it does not alter publication time or replace the production clock.

Native build smoke executes emitted CommonJS Page handlers and actual WXML through the repository's bounded synthetic renderer. Both missing/malformed detail routes and an explicitly valid route are checked. This is not physical-device rendering or platform/provider acceptance.

The cancellation result distinguishes `cancelled` from `already_terminal`. Both cancel and the original operation contend on the same account/request key with exact operation/hash matching. Missing original text disables retry. Logout scrubs bodies but preserves up to eight account-isolated minimal unresolved commitments without silently evicting another account.

## Focused local evidence

| Gate                                                     | Result                |
| -------------------------------------------------------- | --------------------- |
| Whole-tree Prettier write/check                          | Passed                |
| API and native runtime/test typechecks                   | Passed                |
| Whole-tree ESLint and generated OpenAPI drift            | Passed                |
| Native compiled CommonJS Page/WXML aggregate build smoke | Passed                |
| Focused API/owner unit tests                             | 36/36                 |
| Focused native unit and actual Page tests                | 53/53                 |
| Genuine PostgreSQL focused tests, nine explicit files    | 76/76                 |
| Historical migrations 0001–0058 versus accepted M3A tree | All 58 byte-identical |

The PostgreSQL files report 12 named-text tests, 9 identity/source tests, 10
concurrency/state tests, 7 Review tests, 3 deferred-final-proof tests, 5
cancel/recovery tests, 4 owner-proof tests, 1 actual recall-boundary test and 25
Community runtime-policy tests. The final serial PostgreSQL run exited 0 after
166 seconds and stopped its disposable server cleanly. The actual recall-boundary
test took 121.9 seconds, including the real window and deferred-constraint crossing.

Validation found and fixed real compiled-page route wiring and PostgreSQL
record/table-alias ambiguity; the initial failures are retained separately from
final passing evidence. Independent review added immutable local-block originating
request provenance, exact block receipt-to-effect constraints, rejected-original
new-draft recovery, cancellation freeze/fail-closed handling, confirmed-open route
retention and native pull-to-refresh completion checks. These fixes are in the
final focused-test snapshot.

## Remaining root integration gates

- Integrate this exact snapshot and run the ordinary full regression/build gates.
- Verify the exact published commit and its hosted CI separately.
- Retain the current local-only, unavailable-production defaults and the unchanged historical migration bytes.

Migrations 0001–0058 must remain byte-identical to the accepted M3A baseline. Only forward migrations 0059–0061 belong to this slice.

## Remaining product gates

PM3 private images and authorized private media delivery, PM4 real provider issuance/consent/mapping/delivery and device/platform acceptance, and PM5 authoritative legacy history/schema/object reconciliation and cutover remain unavailable or unimplemented. Local outbox rows are not delivered notifications. This slice does not add an administrator private-message body endpoint or claim complete legacy migration.
