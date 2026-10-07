# Campus directory and own profile API

This is a **partial greenfield business slice**, not a legacy-route compatibility layer, a legacy-data import, or full campus/profile parity. All routes use the safe error envelope and request IDs described in `API_AUTH.md`. Own-profile routes require `Authorization: Bearer <accessToken>`; the account is resolved through the identity module's public session facade. No account/user ID is accepted in query or body.

## Directory

`GET /v1/campuses` is public. The optional query parameters are:

- `q`: trimmed literal substring, at most 100 Unicode codepoints, searching campus full/short names and institution name
- `district`: trimmed exact district, 1–100 Unicode codepoints
- `page`: decimal integer string, 1–10000, default 1
- `pageSize`: decimal integer string, 1–100, default 20

Unknown/repeated parameters, coercions, leading zeroes, malformed Unicode and control characters reject with `400 BAD_REQUEST`. Search `%`, `_`, quotes and backslashes are literal input, not SQL wildcards. Names are compared with PostgreSQL's configured `lower()` behavior; Unicode collation parity with the source database has **not** been established.

The response is `{ items: Campus[], page, pageSize, total }`. `total` is a nonnegative 32-bit integer, including for an empty/out-of-range page. Count and page use one database snapshot. Ordering is active first, descending internal sort order, then UUID ascending. Pagination is offset-based; catalog changes between separate requests may change page membership.

A `Campus` has exactly:

- `id`: physical campus UUID
- `institutionId`: reviewed five-digit school business identifier string (for example, `"10001"`); `null` while unresolved. The private institution UUID is never exposed here. Campus and operating-region UUIDs are different identifiers
- `institutionName`, `fullName`: strings of 1–200 Unicode codepoints
- `shortName`: null or 1–100 Unicode codepoints
- `district`: string of 1–100 Unicode codepoints
- `isActive`: boolean

Inactive campuses remain visible but cannot be newly selected. The migration installs an empty catalog; a fresh environment honestly returns an empty directory. Only disposable integration tests create explicitly synthetic campus fixtures. No invented production campus data or administration/import endpoint is included.

## Own profile

`GET /v1/me/profile` returns:

```json
{
  "accountId": "11111111-1111-4111-8111-111111111111",
  "nickname": null,
  "bio": "",
  "selectedCampus": null,
  "revision": 0,
  "preferences": {
    "showOfficialAccountTip": true,
    "showHotTopic": true,
    "showGroupNotice": true,
    "showTradingGroupNotice": true,
    "showErrandGroupNotice": true,
    "defaultAnonymousEnabled": false,
    "defaultCommentAnonymousEnabled": false,
    "defaultCommentNonAnonymousEnabled": false,
    "defaultAllowAnonymousDm": false,
    "hideProfilePosts": false,
    "activitySubscribed": true
  }
}
```

The example account is synthetic. An untouched account is represented by these defaults without inserting a profile row. `nickname: null` means it has not been chosen/imported. This slice deliberately does not generate the legacy random-phone-based nickname or expose a synthetic phone. A non-null `selectedCampus` is a `Campus` object, including when a previously selected campus has since been disabled.

`PATCH /v1/me/profile` takes `expectedRevision` and at least one of:

- `nickname`: trim surrounding whitespace, then 1–20 characters matching `^[\u4e00-\u9fa5a-zA-Z0-9_#&@.+-]+$`. Blank/null names, emoji and internal spaces are rejected. The bounds and allowed character set come from the source profile validator
- `bio`: normalize CRLF to LF and trim surrounding whitespace, at most 100 Unicode codepoints, at most five LF line breaks. Empty text clears the bio. Tab/LF are allowed; other ASCII controls, DEL and unpaired surrogates are rejected

Example: `{ "expectedRevision": 0, "nickname": "泡泡_1", "bio": "你好" }`.

`PATCH /v1/me/preferences` takes `{ "expectedRevision": 1, "preferences": { "hideProfilePosts": true } }`. At least one of the eleven named preference keys is required. Values are JSON booleans only; arbitrary keys and legacy string/number booleans are rejected. Omitted keys are preserved. The two comment-default flags cannot both be true, including after merging a partial update. Change modes atomically by sending the desired flag as true and the other as false; both false means neither override is chosen. A preference is stored user intent: this slice does not implement notification delivery, comment/post defaults in future content modules, anonymous-message permissions, or public-profile privacy enforcement.

`PUT /v1/me/campus` takes `{ "expectedRevision": 2, "campusId": "22222222-2222-4222-8222-222222222222" }`. The campus must exist and be active. No current clear-selection operation is defined. This changes the account's browsing campus only. It does not confer student verification, select a verified identity campus, change a fixed administrator scope, or select a global/university-city feed. Future content and authorization modules must not treat it as authority.

Every successful write returns the complete own-profile response and advances the shared revision once, including an accepted no-op. `expectedRevision` must be an integer from 0 through 2147483646. Responses can contain revision 2147483647; exhaustion fails closed rather than wrapping. The profile row is locked within a transaction; all three mutations participate in the same concurrency check. Initial writes are also race-safe. Selection locks the campus through commit so a concurrent deactivation cannot invalidate eligibility between check and write. Reads and profile updates never query identity tables; the account UUID foreign key is the supported persistence boundary.

A revision conflict requires reloading and reconciling the user's intent; clients must not blindly replay a stale write. A lost network response can mean the write committed. Reload before deciding whether another write is appropriate.

### Business errors

| HTTP | Code                        | Meaning                                                                    |
| ---- | --------------------------- | -------------------------------------------------------------------------- |
| 400  | `BAD_REQUEST`               | Invalid/unknown fields, malformed query, conflicting comment-default flags |
| 404  | `CAMPUS_NOT_FOUND`          | Campus UUID does not exist                                                 |
| 409  | `CAMPUS_UNAVAILABLE`        | Campus is inactive                                                         |
| 409  | `PROFILE_REVISION_CONFLICT` | Shared revision is stale/exhausted; reload                                 |

Authentication, expiry, blocking and revocation use the identity module's existing errors. A stale revision is checked before campus eligibility. Error bodies disclose no submitted content or database/provider details.

## Source grounding and remaining business scope

Reviewed baseline: `WhaleUCampus/WhaleU@57cf169c11123acf249909a1a7215b8cb1ec1f8e`. Relevant paths and methods:

- `treehole/app/controller/School.php`: `getSchools`, `getEnabledSchools`, `getSchoolsByDistrict`, `searchSchools`, `getSchoolDetail`; catalog visibility, institution/campus distinction, district and ordering
- `treehole/app/controller/User.php`: `updateSchool` changes browsing `school_id` independently of verified university, identity campus and administrator scope; `getUserInfo`, `updateUserinformById`, and profile-privacy accessors establish separate concerns
- `treehole/app/validate/UserValidate.php`: nickname 1–20, allowed CJK/Latin/digit/symbol character set, bio 0–100; legacy SQL-keyword denial is not carried forward as an SQL-security mechanism because every value here is parameterized
- `treehole/app/controller/ButtonSetting.php` and `treehole/app/service/ButtonSettingService.php`: five flags default off, other buttons default on
- `miniprogram1/packageUser/pages/setting/setting.js`: concrete button keys, separate activity subscription, and mutually exclusive comment defaults; when legacy local state has both flags true, the non-anonymous override takes precedence. Import must explicitly reconcile that historical conflict rather than discard it
- `miniprogram1/packageUser/pages/geren/geren.js`: biography trim/100-character/five-line-break UI rules and profile editing

**Still required, not removed from scope:**

1. Student/phone verification, review/proof workflows, verified institution and verified identity-campus selection, role/privilege assignment and fixed administrator scope
2. Avatar upload/default-avatar catalog, image history, profile/background media, safe media references, ownership, moderation, storage lifecycle and deletion. No arbitrary URL or remote-image fetch is accepted here
3. Titles, title colors, entitlement/unlock/redemption/experience checks and source nickname/bio moderation-policy reconciliation before production. The inspected profile-update controller directly invokes its validator and writes; this slice makes no claim to have completed broader moderation/provider integration or production policy review
4. Public profiles, posts/trades, block/privacy rules and enforcement of `hideProfilePosts` on those reads
5. Additional campus detail fields: university short name, type/address, student email domain, coordinates, school level/type/count, logo/description/website, unverified-post policy and timestamps; district discovery, campus groups, region relations, location hints and administrative catalog maintenance
6. Independent global-feed/university-city context and campus-versus-institution routing/access policies
7. Notification delivery/subscription consent, guide-hint states, local theme/comment-banner preferences and all settings found outside this explicit eleven-key subset. Unknown legacy preference keys must be inventoried, preserved and reconciled during migration rather than silently dropped
8. Authored-content display-name/title propagation (the old update writes denormalized message/comment/post fields) and cache invalidation needed when content modules arrive. Normalized author-profile references can supply current named-author display data without bulk rewrites; anonymous identities must remain independent and must not expose the named profile
9. Legacy record mappings, catalog/profile/preference import, source default reconciliation, conflict resolution, encoding/collation checks and production backup/restore/reconciliation/cutover gates

`0003_campus_profile.sql` creates new target schemas and constraints only. It is not evidence that any production record has moved or that legacy import is safe. The older platform is neither queried nor run by this implementation. Full production rollout stays blocked on the release/migration gates and the remaining business slices above.

## Verification

- Schema/unit tests cover query bounds, Unicode/length rules, unknown fields, self-escalation attempts, exact booleans, defaults and all endpoint authentication wiring
- Disposable PostgreSQL 18.6 integration tests use loopback and the dedicated `whaleu_test` name, a shared exclusive suite lock, refusal of pre-existing owned schemas, and serial execution. They cover real Nest HTTP, real identity authentication, migrations, literal search, initial/update races, optimistic conflicts, merged preferences, constraints, selection row locks and blocked/revoked accounts
- Cleanup is limited to schemas the guarded suite created in that disposable database. No production cleanup, import, provider call or moderation service call is performed
