# Session revocation epoch foundation (0180)

Intermediate production foundation, not enabled account deletion. Base is signed
local registration commit `da2784781db741e2fff5ad279fe3bc853bab0552`, including
Home 0177/0178 and registration guard 0179. No production credentials/grants,
external provider calls, epoch advancement or erasure are performed by this slice.

## Runtime and persistence

Accounts have a nonnegative bigint `session_revocation_epoch`, initially zero.
Sessions retain immutable `(id, account_id, issued_revocation_epoch)`. Existing
rows become zero without rewriting their credentials or changing the absolute
30-day session lifetime. New sessions copy the locked account's exact epoch.
Unknown/missing values are not interpreted as zero and bigint is never converted
to a JavaScript number.

The account trigger currently rejects every epoch change, including increases.
Only a successor real accepted-request authority may replace that branch, tied
to exact request/account/generation/current transaction and an atomic +1. Cancel
must not reduce it. No arbitrary receipt or operator-supplied timestamp may grant
this authority. Tests that inject a mismatched epoch are rollback-only corruption
negative cases, not proof of real acceptance or completion.

Login issuance, standalone/transactional authentication, refresh, manual Rating
Promotion and Official execution-session reads check epoch authority. Managed
proofs revalidate after deferred constraints with existing 100ms statement /500ms
proof bounds, shared migration fencing and account-before-session NOWAIT row
locks. The schema qualification checks exact named columns/constraints, both
full INSERT/UPDATE triggers (including empty `tgattr`), and bounded exact function
bodies. No broad table lock, MAINTAIN or new runtime grant is introduced.

Twenty-two current SQL functions receive additional equality predicates, with
exact prior signatures, argument/default metadata and bodies verified before
replacement. They include Experience maintenance, Errand management, Rating
administrator deletion/target editing, phone claims, private-message delivery
holds, course/window/major sessions and deadlines, Community visibility/category/
pin completion, Profile moderation/self-edit, school-administration identity,
Safety punishment/appeal identity, and institutional SSO. Existing authorization,
identity, scope and temporal predicates are preserved. Historical migrations are
unchanged; schema drift rolls back the complete successor migration.

Refresh replay still revokes and commits before returning its public error.
Only successful refresh registers the live-session proof, so intentional replay
revocation does not roll itself back. A successful refresh retains the original
refresh/absolute deadline through final proof. Logout still accepts a known old
or expired access token solely to revoke its own session, including repeated
logout; it does not demand current epoch or grant account access.

## Historical evidence and deployment

Adding columns changes existing `to_jsonb(account/session)` identity fingerprints.
Do not rewrite old immutable facts or bind them to a new identity snapshot. Old
pending authority must be rejected when its original hash differs. Terminal
receipt-first replay remains exact and does not recalculate historical identity
hashes. The PG fixture executes an actual pre-migration Timetable operation,
preserves its returned receipt/intent hash, then replays via the real service
using a new valid session after migration.

A rolling, zero-downtime activation of real epoch advancement is NOT supported.
Install this closed foundation and all updated readers first. The later real
request activation must enforce a separately reviewed maintenance cutover:
stop old API/worker intake, drain/terminate old transactions and external
operations, admit only the fixed epoch-aware runtime, and prohibit downgrade.
An instance count, application_name or a configuration assertion cannot prove
an old reader will not return. If old and new programs still share working
credentials, no SQL flag proves their distinction and advancement stays closed.
Version-scoped least-privilege credentials and retirement of old read access
would require separately authorized operator actions; this slice does not
create/revoke credentials or privileges.

`npm run auth:epoch-status -w @whaleu/api` is a genuine read-only operator entry.
It qualifies the installed closed schema and prints protocol status only. It
explicitly reports advancement/admission unavailable and legacy-reader cutover
unproven. It accepts no activate/override/old-readers-stopped option. This output
is not an activation attestation or proof that a deletion lifecycle exists.

## Subsequent real lifecycle acceptance

Next connect real request/reauth/recovery authority and monotone +1 atomically,
then bounded owner erasure and completed-at +30-day guard closure. The first
native-pristine candidate has Identity credentials plus six Experience and two
Safety birth rows, excludes Verification and all unsupported owner footprints,
and needs real causal erasers and complete ownership/writer fencing.

An empty opaque-history gate is only a narrow bootstrap validation condition:
it may reject a pristine user because OTHER users have related history, so it
cannot be advertised as a generally usable deletion cohort. Production positive
coverage must prove one user's deletion while preserving other users' existing
history. Naked UUIDs, account hash buckets, polymorphic roots and opaque imports
need explicit finite ownership/retention/erasure contracts. Never substitute a
whole-database scan, a UUID-substring search or a synthetic baseline.

Remaining owners include Profile/media, posts/comments/reviews, Messaging,
Ratings, social/notifications, Errands/Activities/Announcements/Organizations,
Verification/authorization/moderation histories, Home/Reading and all coordinator
metadata. Each needs current schema/worker/late-write closure; unsupported
accounts remain explicitly unavailable. Neither 0180 nor a native-only bootstrap
is completion of full account deletion.

## Replay integration boundary

The original foundation above was authored on da278. Its first replay was composed
on `b93a78ec03a67db9200c76c4fedfdfaf3bca98d2`. The current integration is based on
`af9d847e4491ee10c5eaf21179bfeacbaf0b0b7f`, retaining the newer readiness gate
and raising its deployment-artifact floor to 0180. Earlier validation does not
certify this new stack. Exact 173/174 synthetic compatibility uses a test-only pinned
lifecycle-aware predecessor with original refresh/logout/lifecycle denial, not
a production fallback or current epoch acceptance. Current API and TLS fixtures
install the complete chain through 0180 and retain genuine current Identity.
No 0181/0182 request authority or 0185 erasure is included.
