# School UID and verified-school correction

School UID is an institution-local permanent positive bigint namespace. Wire values are decimal strings, padded to at least six digits for display. Unknown inventory never means a zero floor. This slice provides synthetic inventory validation/application only; real legacy cutover and production admission remain closed.

An approved student decision creates exactly one immutable UID decision in its existing transaction: issued, retained, or deferred unavailable. Rejected/withdrawn applications issue nothing. Operational allocation failures roll the approval back. Existing student receipts and already-approved eligibility are unchanged. Native absence is established lazily from an exact original enrollment observation taken before source waits; ordinary GETs never write coverage or issue numbers.

An active explicit global super administrator can look up an existing profile by exact school code and UID. Current profile visibility, Safety, account state and aligned affiliation are required. Historical assignments and blocked/unavailable matches share the unavailable result. Developer or school-administrator authority alone does not qualify.

Verified-school correction preserves finite affiliation expiry, phone, independent student-number pointers, application state, profile identity, browsing preferences and fixed role regions. A different institution gets a new allocation atomically; A→B→A gets a fresh A number. Same-institution selection is unchanged, even if future issuance is suspended or exhausted. There is no new self-service re-verification flow.

## Endpoints

- GET /v1/me/school-uid
- GET /v1/admin/school-uids/lookup?schoolCode=00001&uid=000001
- GET /v1/admin/school-identities/management?targetProfileId=…&destinationCampusId=…
- POST /v1/admin/school-identities/commands
- POST /v1/admin/school-identities/commands/cancel
- GET /v1/admin/school-identities/requests/:requestId

Version 1 commands freeze the exact target state, destination provenance and original UUIDv4 request key. `correct_school` and `complete_uid` are separate actions. Cancellation stores the full original intent. Recovery after role loss needs the same active account and a current session, not the original session or current target visibility. `not_recorded` never proves a lost request failed.

Native pages persist public intent before dispatch in the actor/API-origin-isolated journal `whaleu.school-identity.pending.v1`. Back, hide, unload and stop-waiting do not cancel. Storage failure prevents mutation. A recovered historical receipt is not current visibility or permission.

## Source and proof boundaries

Migrations 0141–0143 own immutable inventory, reservations, allocations, assignment/decision/correction causes and command receipts. They leave all prior SQL files unchanged. Correction provenance is affiliation-only and is accepted by all six existing SQL consumers only with reciprocal cause closure. Source-generation statement hooks retain the initial complete 0138 vector, bracket its unchanged writer trigger, and prove exact own statement/row deltas. Completion and unchanged commands have zero source delta.

Public profile school and UID form one optional owner projection, separate from count/Media collection. One initial savepoint/checkpoint, one optional final proof and one joint expiry callback preserve profile basics on defined source contention. Required management proof remains mandatory, with the existing 500 ms owner budget. Optional proof uses the existing 100 ms statement / 600 ms total bounds. Historical admission evidence supports assigned display independently of future issuance capacity.

The offline `school-uid-inventory/v1` validator preserves trusted ceilings and holes, quarantines ambiguity or unbounded history, and emits a dry-run report. Synthetic application is bounded per institution/digest and checks a controlled disposable loopback database. Accepted historical assignments remain reserved; runtime allocations always advance above the admitted floor. Synthetic provenance revisions can suspend future issuance without invalidating prior allocations. No real school package, provider, role grant or production seed is included.

See the generated [OpenAPI contract](openapi/school-identity.json). Test assertions and passing execution evidence are distinct; acceptance results are recorded separately after the frozen source is run.
