# Errand target-region services (E4a)

This bounded parity increment connects existing owners: Errands supplies a
currently readable order's immutable target; School Configuration owns the public
errand group and QR; Profile owns `showErrandGroupNotice` and its shared CAS
revision. No migration or production/provider activation is introduced.

## Legacy basis

The source is [WhaleUCampus/WhaleU at 57cf169c](https://github.com/WhaleUCampus/WhaleU/tree/57cf169c11123acf249909a1a7215b8cb1ec1f8e).
`miniprogram1/pages/fold1/errand/detail/detail.js` lines 152–153 and 651–665
resolve QR from the order target, not the selected school; lines 674–765 and
`detail.wxml` lines 69–85 implement the account notice preference. The native
customer-service button at WXML lines 35–41 is distinct from administrator contact.

## Contract and authority

- `GET /v1/school-services/errands/:orderId` returns `{context:{orderId,
targetRegion:{id,name}},entry}`. Only the public `errand` entry is exposed.
- The Errands read boundary shares detail's current session, phone, Safety,
  participant/base eligibility and exact content Review checks. It projects
  the immutable source/target region facts, then enrolls a final owner fence.
- No caller-supplied campus/region, arbitrary representative campus, current
  browsing selection or school management route is used to resolve this context.
- The descriptor and variant routes under
  `/v3/media/school-configuration/errands/:orderId` use a distinct authenticated
  order-target principal. Order read never confers management or upload rights.
- Current enabled entry, exact entry revision, binding, immutable object and
  image Safety are checked before and after storage open. Final owner fences
  cover order/region facts as well as existing School Configuration/Media facts.
  Invalid presented bearer never becomes guest access. No redirects/public cache.

## Native behavior

The emitted errand-detail Page/WXML renders the target-region card only when the
current account preference permits it. Missing/disabled QR remains explicit.
The shared School QR reader uses an inline leased file and a 30-second lifetime.
Close, page/app hide, account changes, cancellation and late callbacks clear the
presentation and release the file. Returning requires a fresh read.

Dismissal patches only `showErrandGroupNotice:false`. It uses the shared Profile
revision, re-reads on one explicit CAS conflict and retries that single field
once. An uncertain response is resolved with a read rather than a blind replay.
A failed recovery read leaves an explicit reload path. Other preferences and
other accounts remain independent. The existing Preferences page can re-enable
this setting. Reload clears the previous detail first, so an unchanged order
revision still re-reads failed group or preference state.

## Verification and limits

The targeted integration test `errand-target-services-native-roundtrip.test.ts`
loads the actual emitted App/Page/WXML through synthetic platform callbacks into
ordinary AppModule HTTP and disposable PostgreSQL 18.6. School publication,
Media9 processing/Review, order readability and Profile CAS remain real. Only
external provider/storage/native transport boundaries and initial test facts are
synthetic. It checks native configuration and real image upload/review, a
cross-region order despite an unrelated selected campus, exact variant bytes
against the stored manifest digest, preference conflict/reload, disabled/replaced
QR, scope/bearer/revision denial, hide/show/close/account changes, late callbacks,
first-read network recovery and lost-write/failed-read recovery. Storage-open
races invalidate both a disabled entry and a deleted order before bytes escape.

This is not physical-device or live-provider acceptance. The client currently has
no implemented explicit native customer-service capability; that distinct legacy
entry remains open and is not replaced by school administrator contact. E3 order
public/private images are covered separately in
[Errand image publication](ERRAND_IMAGE_PUBLICATION.md); external group dispatch,
historical import and production readiness remain unactivated. This candidate's hosted CI status must be checked
for its own eventual source commit, not inherited from an earlier green baseline.
