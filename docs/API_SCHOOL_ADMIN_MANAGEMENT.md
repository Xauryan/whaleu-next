# School-administrator management

This is a bounded Authorization command owner and registered WeChat journey. It
creates no real grant, provider connection or production bootstrap. Only explicit
synthetic accounts in disposable PostgreSQL acceptance fixtures receive test roles.

## Source parity and scope

The behavioral source is WhaleUCampus/WhaleU at
`57cf169c11123acf249909a1a7215b8cb1ec1f8e`: `treehole/app/controller/User.php`
1489–1633; `AdminScopeService.php` 190–409; `SchoolRelationService.php` 32–67,
121–220; `TitleUtil.php`; and `miniprogram1/pages/admin/super/index.js` 348–532.
The implementation retains explicit school appointment, same-region repair,
fixed-region reassignment and revocation. It does not expose old mixed account
status edits, verification resets, bans, developer issuance or private UID search.

Only an active account/session/presented token with an actual current global
`super_admin` grant may start fresh management. A developer-only grant is
insufficient. An account holding both grants uses its actual super grant even
though its highest capability label is developer. Any unrevoked target global
role, including an unsupported future/expired combination, is protected.

Appointment requires current accepted complete affiliation provenance, the
matching accepted topology origin institution/group, and bidirectionally reconciled
physical campus/region inventory. Same institution alone does not prove same
school group. Unknown topology never means a known singleton. Known empty options
remain distinct from unavailable evidence. Identity-campus choice is only a
default hint: absent, expired or unreconciled selection does not veto an otherwise
proven explicit eligible region. Existing valid fixed assignment is the preferred
default. Nothing is automatically submitted even when only one region exists.

Reassignment revokes the exact unrevoked old row and creates a new immutable
school grant. It never edits old region, approval or validity. Future/expired
unrevoked rows remain visible and require explicit replacement. Same-region
current assignment is unchanged and does not execute any role DML. Revocation
needs no target login, phone, affiliation or complete topology, and changes no
other role or Verification/Identity state.

`role_admin` is the special title “管理员”. Appointment or same-region repair may
grant it once; it is not automatically equipped. Reassignment and revocation keep
the earned entitlement and any chosen appearance. It does not prove current
administrative permission. No private notice, unlock notice, reward, settlement,
account balance, baseline or provider identifier is created by this command.

## HTTP contracts

All responses are private, `Cache-Control: no-store`, `Vary: Authorization`.
Every request uses a bearer session; schemas reject unknown fields.

- GET `/v1/admin/school-administrators/management?targetProfileId=UUID`
- POST `/v1/admin/school-administrators/commands`
- POST `/v1/admin/school-administrators/commands/cancel`
- GET `/v1/admin/school-administrators/requests/UUID4`

The public profile reference must already exist. Missing references create
nothing. There is no account ID, student-number or anonymous-author resolver.
Management returns public target name/reference, opaque `stateVersion`, nullable
current fixed region/status (`active`, `future`, `expired`, `unavailable`), eligible
region IDs/names and optional default, and explicit action booleans. It returns no
target account, grant, assertion, snapshot, session, provider, phone or student data.

The complete frozen intent is
`{clientRequestId,targetProfileId,expectedStateVersion,action,regionId?}`.
`action` is `appoint`, `reassign` or `revoke`; the first two require `regionId`,
revocation forbids it. No role, approver, expiry, title key or arbitrary account is
accepted. Version is an optimistic state fingerprint, not an authority token.

Receipts echo only the public original intent and an immutable outcome.
Applied/unchanged receipts have `eventId`, `recordedAt` and `titleGranted`.
Rejected receipts contain `SCHOOL_ADMIN_MANAGEMENT_STALE` or
`SCHOOL_ADMIN_MANAGEMENT_CANCELLED`. Reusing an actor/key with a changed intent
conflicts. Recovery returns `{state:"recorded",receipt}` or
`{state:"not_recorded"}`; not-recorded is not evidence that a lost request failed.

Replay, recovery and fresh cancellation require only the same active Identity.
They happen before fresh super/target/source/title checks, so losing the role or
changing the target does not hide an existing receipt. Cancellation competes on
the same actor/key/full intent: first committed result wins. Cross-account recovery
cannot disclose the other account's result. Invalid current session still denies
recovery. Old receipts say what happened, not what current permissions are.

## Transaction protocol and causal evidence

Migration `0133_school_admin_management.sql` is additive; 0005–0132 are unchanged.
Commands and assignment events are immutable. Session UUIDs remain audit metadata
without a lifetime foreign key: normal Identity retention can delete a terminal
session, while another active session of the same account recovers the old key. Trigger-generated statement/row
transition/epoch records prove exact real grant DML. Title grants and entitlements
are mutually linked to the same transaction and command. Raw productized grants,
forged receipt/title provenance, missing/reused transitions and late owner changes
fail closure. Existing historical grants and explicit disposable synthetic seeds
remain consumable; this is not approval to issue production privileges.

Lock order: common Safety/catalog gate (exclusive for fresh apply, shared read),
active actor Identity and immutable observation, actor/request, public target and
Identity, canonical ordered full unrevoked role set, affiliation head, accepted
topology/physical inventory, exact role mutations, terminal Experience owner lock,
deferred closure, mandatory bounded nonblocking final proofs, final database
clock, commit. Recovery/cancel take no unrelated source gate. Multiple managers
must not upgrade each other's account locks. No Identity/Role/Verification/Campus
row lock follows the terminal Experience lock.

Initial source facts are retained before source waits, including tuple lineage
and role-set absence. Required final `SHARE NOWAIT` table fences reject ordinary
noncooperating writers and phantoms instead of waiting into a fresh authority
snapshot. Exact PostgreSQL expiry text is retained for the final clock. Migration
0124's per-statement authority epoch and the existing late-DML consumer hooks are
preserved: unrelated/zero-row role writes cannot be silently absorbed; unchanged
commands do not manufacture an epoch. Budgets are not widened.

## Native durability and boundaries

Registered `pages/school-admin-management/school-admin-management` and the existing management and
public-profile entries use the independent `schoolAdminManagement` capability.
Input is explicitly a public profile ID. Confirmation names the target, public
reference, old/new fixed region and title behavior.

The API-origin/account-bound journal persists and reads back the whole frozen
command before dispatch. Single flight, original-key cold recovery, an explicit
cancel phase, storage failure blocking and account/session/navigation generations
prevent stale callbacks or new-key retries. Permission loss does not hide pending
recovery; 403/not-recorded do not discard unknown intent. Closing the page does not
cancel on the server. Terminal receipts refresh current management/capabilities.

## Verification and remaining gates

Integration inventory includes management lifecycle/strict privacy/active-only
recovery and session retention, accepted topology/physical reconciliation, real
raw writer/late-DML/final proof races, exact token/session/grant/affiliation expiry,
and actual maintenance/sign-in/publication-settlement/appearance owner contention.
It also covers emitted App/Page/WXML through real HTTP
AppModule and isolated PostgreSQL. Distinct consumer mutation suites use grants
issued by the new HTTP endpoint for post/comment/reply removal, nickname/avatar
moderation, pinning, rating category management, Major deletion, school
configuration/posting policy, announcements, errands, organization first approval
and student-verification decisions. They retain old displayed intents across
reassignment/revocation and assert denied new writes preserve committed history.
Committed verification-head replacement is observed across an actual source wait;
existing catalog gates serialize committed topology/region changes before source
observation, then the old displayed version is rejected. Unit tests cover strict contracts and native journal state transitions.
Each integration file is registered once in `scripts/ci-integration-modules.json`.
Execution outcomes and exact frozen hashes belong to the delivery evidence; this
contract does not claim a test run passed. Real provider, device/DevTools,
production bootstrap and real historical-data acceptance remain separate gates.
