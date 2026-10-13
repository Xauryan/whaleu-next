# Scoped administrator discussion removal

This bounded slice removes one ordinary readable native-origin root comment or
reply in an active original regional space with `sync:none`. It does not implement
account bans, hidden-content queues, associated/university-city scope, arbitrary
identity lookup, notifications, historical import, production activation or an
undelete operation.

## Source and authority

Legacy `WhaleUCampus/WhaleU@57cf169c11123acf249909a1a7215b8cb1ec1f8e`
`treehole/app/controller/Comment.php:2702–2816,2882–3000` makes an ordinary
`ban_user=0` deletion without notification or an Experience event. Ownership is
that of the selected child. Parent-post ownership alone grants no deletion of
another author's content. The selected child's own author retains the existing
own-delete route and Experience semantics. Target authors holding administrator,
super-administrator or developer roles are not protected by an invented rule.

The real backend requires an exact current original-region school-admin grant or
global super-admin grant, active account/session/presented token, current phone,
Safety action eligibility, current approved native source and Media evidence.
Display labels, browse campus and developer-only grants cannot authorize removal.
Post direct reads preserve the existing two-way named block rule; child projection
preserves its existing outgoing-only rule. Anonymous source does not become an
identity locator. All actual ancestry remains readable; a reply's referenced reply
is not an ancestor.

## Routes and strict contract

- `GET /v1/community/admin-discussion-removal/management?kind=comment|reply&id=UUID`
- `POST /v1/community/admin-discussion-removal/commands`
- `POST /v1/community/admin-discussion-removal/commands/cancel`
- `GET /v1/community/admin-discussion-removal/requests/UUID4`

A command contains exactly `clientRequestId`, `target:{kind,id}`,
`expectedTargetVersion` and `action:'remove_discussion'`. The independent
`whaleu:admin-discussion-removal-command:v1` canonical hash includes the actor,
kind, id, action and target version. Management returns only target, targetVersion
and canRemove. Applied receipt adds eventId and recordedAt; rejected receipt adds
`ADMIN_DISCUSSION_REMOVAL_STALE` or `ADMIN_DISCUSSION_REMOVAL_CANCELLED`.
No public response includes the private author, old preview, original grant or
identity-privacy link.

The exact original actor/key can recover, replay or cancel with only the same
active account and a current session token, even after source removal, grant
revocation or phone expiration. Cancel-first wins against late apply; apply-first
returns the original applied receipt. Cancellation is not restoration. A changed
intent under the same actor/key conflicts.

## SQL causality and existing owners

Forward migration 0132 keeps all previous SQL bytes unchanged. One command admits
one actual live-to-tombstone child update and its genuine local-deletion stamp.
Only the selected child fingerprint may change. Actual post/root ancestors and
all initial non-target source facts remain unchanged and live. The single original
Community epoch slot advances exactly once; Media and other owner vectors do not.
Zero-row, same-value, ABA, additional target writes and late writes after an early
constraint flush cannot substitute for the transition.

A root releases only its own comment pin. Parent post, post pins, other roots and
actual reply tuples remain. Root ancestry hides its thread. A removed reply hides
only itself; siblings and replies referring to it remain and serialize its target
as unavailable. Later unrelated legitimate owner work is not frozen.

If the post has an actual 0031 comment baseline, its canonical capture supplies
one exact negative source linked to that child's original positive source and
actual author, routing and transaction. Enrolled content without that source
fails closed. Genuine older unenrolled content remains unenrolled and receives no
invented component history. Global source sequences may have ordinary gaps.
The existing component settlement consumes each original source once. Its derived
hotness counts do not replace public visible discussion counts.

Canonical 0078 capture supplies one pending cleanup job. The existing worker
handles root self then replies in pages of at most 16, or selected reply self only.
Logical denial, binding retirement and physical object absence are distinct.
No new provider or physical deletion guarantee is introduced. Already-finally-authorized streams and pixels previously delivered to a client cannot be recalled.
Existing private conversation history is retained; opening a removed source fails.

## Native lifecycle

Actual Detail and Thread root/reply buttons and a targetless My Community recovery
entry lead to the independently registered `admin-discussion-removal` page. Its
confirmation distinguishes root/thread impact from reply-only removal and says
no author notification is sent. It freezes and reads back the exact journal before
HTTP, retains cancellation phase under the original key and never silently sends
a replacement intent. Account, API origin and session generation isolate callbacks
and recovery. Storage failure fails closed; confirmed applied outcomes invalidate
old content/media even if journal cleanup fails. Same-owner linked report-progress late
denials during recovery can retry only the exact durable receipt GET.

The old post/profile/owner visibility/pin/category/publication/report journals and
four system-notice kinds remain unchanged.

## Verification scope

The new integration specifications are registered exactly once in the existing
Community/Media job, without changing the ten-job inventory or maximum parallelism.
They use actual emitted native pages, loopback AppModule HTTP, PostgreSQL 18.6,
synthetic accepted source/Review/Media fixtures, raw SQL negative cases, observed
lock races, original component settlement and original cleanup owners. Each
executed check must be reported against the precise source tree and emitted bytes;
file existence alone is not a test pass. Device acceptance, real source/grants,
provider activation and production deployment remain separate release gates.

## Related original-journal correction

The existing post-removal controller receives the same bounded original-intent
anchor correction: same-account Safety invalidation or replacement session cannot
discard an unresolved exact pending pointer, and a missing, corrupt or legally
shaped replacement journal fails closed. Confirmed applied outcomes clear linked
readers even if journal cleanup fails. Its existing v1 wire contract, storage
namespace and backend remain unchanged. This correction needs the original post
native tests and emitted PostgreSQL journey on the final tree.
