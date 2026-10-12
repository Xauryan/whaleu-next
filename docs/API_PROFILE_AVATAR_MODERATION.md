# Scoped custom-avatar clear

This independent development slice clears only the current custom avatar from a
currently readable, non-anonymous Community post, comment or reply. The result is
Profile `none`, using the existing “尚未选择头像” display. It does not select a
random default image, import any of the legacy 91 images, create a permanent
same-pixel ban, or claim full legacy parity. Non-anonymous means the account's
public nickname; no legal-name requirement is introduced.

## Authority and HTTP

The target resolver and exact authority match scoped nickname moderation: full
live ancestry (parents may be anonymous), original canonical publication Review,
current Safety, source, owner-hide, category and Media gates; active original
regional scope with `sync: none`; current original-region `school_admin` or global
`super_admin`. Developer labels, browse campus, subject affiliation and arbitrary
account/profile IDs grant no authority. Trading, poll, formation and image-bearing
nodes are not excluded by this action. Unknown original source/Media facts remain
fail-closed.

The authenticated no-store family is `/v1/community/profile-avatar-moderation`:

- `GET /management?kind=post|comment|reply&id=<uuid>` returns only target,
  public displayName, shared revision, canClearCustomAvatar and expectedAppearanceId
  (null when current source is not a proven custom image).
- `POST /commands` accepts only clientRequestId (UUIDv4), target `{kind,id}`,
  expectedProfileRevision, expectedAppearanceId and action `clear_custom_avatar`.
- `GET /requests/:requestId` returns the original receipt or `not_recorded`.
- `POST /commands/cancel` takes the same frozen original command.

Applied receipts contain the frozen original intent plus revision exactly +1,
eventId and recordedAt. Rejections are PROFILE_AVATAR_MODERATION_STALE for changed
revision, PROFILE_AVATAR_MODERATION_NOT_APPLICABLE for changed appearance or a
non-custom current source, and PROFILE_AVATAR_MODERATION_CANCELLED. Fresh stale
and not-applicable requests still prove current authority. They do not clear
anything, advance revision or notify again. Replay of the same actor/key compares
the exact independent canonical request hash; changed content conflicts.

Recovery, replay and first cancellation need only the original current
account/session/presented token. They do not reopen the grant, phone, target,
Review or storage, even after source removal. `not_recorded` keeps the same key.
Fresh commands acquire the existing Media policy writer gate after identity and
original-key checks, before source observations or subject locks. The order is
request key → policy writer gate → canonical source/authority → subject avatar
and shared Profile CAS → sorted Media rows → notice owner. Management remains a
shared read. Terminal replay and cancellation return before the writer gate;
raw duplicate keys reject before it. This matches self-selection and avoids a
late shared-to-exclusive policy-lock upgrade during detach.

Command metadata intentionally has no nullable grant/subject foreign keys: even
NULL foreign keys would open those relations in PostgreSQL during cancellation.
Source rows also use late-bound PL/pgSQL records: compiling a source-composite
rowtype on a cold backend would otherwise open the relation before the early exit.
Fresh-backend raw cancellation, duplicate rejection and ordinary API cancellation
are tested while source relations and the policy gate are exclusively locked.

## Independent cause, shared Profile revision

Migration 0129 adds independent immutable command/event/Profile-transition/
pointer-transition/notice records. It does not edit prior SQL bytes or relax
0128's nickname-only avatar-unchanged constraint. A forward function-local planning
barrier prevents repeated expansion of the existing at-most-three-node ancestry
function; its body, invoker authority and all facts remain unchanged. Original
100ms statement and 500ms required-proof deadlines are retained. A real Profile UPDATE must
preserve nickname, bio, campus, preferences, publicId and all other fields except
revision (+1) and updated_at. The real pointer changes from the exact old custom
appearance to the stable new system-clear appearance. Before fingerprints include
original row versions; the API compares its original Profile and avatar facts to
the SQL admission capture rather than rebasing them after waits.

`avatar_definitions.authority` distinguishes historical `self_selection` from
`scoped_moderation_clear`. Historical selection still requires exactly its own
canonical envelope/hash, receipt, Review consumption and runtime. The new branch
can only be `{kind: clear}` with null binding, has its own digest and appearance
identity domains, and binds moderator, subject, request/event, target/original
region, previous appearance and shared before/after revision. It cannot authorize
new bytes or create a self-selection receipt/Review.

The immutable system cause remains valid after the administrator's grant expires
or the source becomes unreadable. Current own/public reads still prove subject
visibility, current Profile, exact pointer and revision; an event-authorized
system-clear returns none before the optional avatar runtime. New self selection
uses the new shared revision and previous appearance, with the original exact
self Review. Concurrent avatar/nickname/bio/preferences/campus edits compete on
the same CAS; only one expected-revision effect wins.

## Media composition and exact retirement

The new owner has a narrow mutation-aware collector for one target and its at-most
two ancestors. Initial canonical authorization really executes. The ordered image
sets and exact binding/asset/intent/Safety/manifest/variant row versions are kept
from before mutation and checked again afterward. The original non-Media, grant
and phone facts remain enrolled. The original Media epoch is checked inside SQL
command admission, so even a zero-row Media writer during initial authorization
is not silently absorbed. After admission, raw statement/row guards allow only
the precise old-avatar retirement. Every actual installed epoch-source table,
including sources outside the Media schema, has a qualified statement guard;
admission and final checks reject newly installed uncovered sources. Each allowed
statement consumes one actual nested epoch transition receipt, and the continuous
hash chain starts at the original epoch and ends at the final sealed epoch.
Earlier ordinary Media facts outside the callback are never removed or replaced.

The removal proves the old custom image's subject ownership and exact current
binding, even if its Review or asset Safety is held/revoked. This is not preview
authority. It uses existing prepareProfileReplacement(subject, old, null) and
finishProfileReplacement, locks exact sorted intents/assets/bindings/quota/ingress,
detaches exactly one binding and stages the existing known-object obligations.
No other user's image, Community binding, catalog object or unbound new upload is
changed. Existing two-minute image retention, exact-locator deduplication and
actual ingress quiescence remain mandatory. The receipt proves logical removal,
not completed physical deletion.

Current bytes are unavailable to new requests for the old appearance. The existing
two-stage exact storage-open authorization also rejects a clear occurring while
open is paused before its final check. Already-final-authorized streams, downloaded
files and screenshots are not recalled. Native uses the existing 30-second local
display lease and lifecycle invalidation; there is no new global push, forced
logout or whole-site instantaneous cache guarantee.

## Notices and native recovery

The private `profile_custom_avatar_cleared` notice exposes only noticeId, kind,
createdAt and readAt. Its immutable event/owner relation, unique cross-kind UUID
registry, initial unread state and first-read timestamp are SQL-closed. Jury,
nickname and avatar notices remain independently typed and owner-only; old v1/v2
cursors remain readable and new cursors are v3. No old bytes, target link, private
subject/moderator identity or free-form reason appears in the notice.

The native action has a separate page, frozen revision+appearance confirmation,
request hash and storage namespace. The nickname pending journal is unchanged.
Account/origin isolation, storage readback before sending, original-key recovery,
unknown outcome, cancellation races, double taps, cold restarts and late callbacks
follow the existing command pattern. Current page image leases are invalidated
before navigation/submission and refreshed through current owner reads.

## Evidence and release boundary

Synthetic tests use real disposable PostgreSQL 18.6, native publication/Review,
custom multipart upload/processing, exact Media retirement and emitted App/Page
HTTP flows. Plain AppModule has avatar runtime null. Image-target tests explicitly
inject the existing CurrentContentMediaProof read leaf into a separate synthetic
AppModule while leaving avatar runtime null; ordinary production DI intentionally
keeps its unavailable Media gate. This is not provider activation or production
source acceptance.

Still outside scope: actual licensed/accepted 91-image catalog, new image-selection
moderation, related-campus/university-city expansion, real legacy identity or
crosswalk/history import, production Media/Review/provider/device acceptance,
legacy status-code forced-relogin parity and revocation of already authorized
streams. Test outcomes belong to the exact run-start source manifest; focused
checks alone do not establish aggregate or hosted acceptance.
