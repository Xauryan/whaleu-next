# Native activity publication (local simulation slice)

This slice adds a separately identified `native` activity source. The accepted
legacy activity catalogs from migration 0036, their endpoints, entry/visit logic,
and read-only pages remain intact. Neither legacy labels nor accepted directory
IDs confer native publisher or organization ownership.

## Source-backed restoration

Authoritative old source: `WhaleUCampus/WhaleU` commit
`57cf169c11123acf249909a1a7215b8cb1ec1f8e`:

- `treehole/app/controller/Activity.php`, `publish` (519–695): approved organizer,
  target-scoped group owner/admin or official-account admin, required title and
  cover, immutable original `user_id` publisher.
- The same file, `getUserManagedGroups` (1510–1620): approved same-school managed
  organizations. The previous zero-school bypass is deliberately not retained.
- The same file, `getMyActivities` (770–795): owner history exists in the backend.
  The new native history Page is newly restored UI, not a claim that the old
  mini-program had an evidenced complete history UI.
- `miniprogram1/packageCommunity/pages/activity/activity_publish/activity_publish.wxml`:
  title 50 characters, description 1000, free-text time/place 200 each, cover plus
  at most nine detail images. Offline selection requires time and place in
  `activity_publish.js` 514–600. Existing actual `online`, `offline`, `reward`
  selections are now sent and stored exactly rather than lost through the old
  JS `types` / PHP `has_reward,is_online` mismatch.
- `treehole/route/app.php` 159–163 requires text and image auditing. Organization
  approval or manager authorization is not content-review approval.

Missing end time is `null` (未指定), never a fabricated 2099 date. The QR switch
now changes both the submitted content and public detail. It references only the
current organization's publicly readable `mainQr` binding with exact asset and
manifest evidence. It never copies an external URL or private `managerContact`.

## Actual workflow

`activity-list` retains the accepted legacy directory and links to these Pages:

1. `activity-publish`: choose a current approved home-school managed organization
   with an actual target `organization_owner` or `organization_admin` grant.
   Being a school reviewer by itself is insufficient.
2. Create an account-owned draft, upload its independent Activity Media11 cover
   and optional gallery slots, then save exact content and accepted image assets.
3. Submit an original-key publication. The server freezes an independent typed
   `publish_activity` envelope and creates a real pending review job. A second
   unresolved key for the same draft is rejected.
4. `ActivityReviewProcessor.processOne()` consumes the real queue through an
   explicitly injected `ActivityReviewRuntime` with `mode: simulation`. The normal
   AppModule registers no issuer/runtime, so production does not auto-approve.
   There is no public review-issuance endpoint and no real model call.
5. Recover/retry the identical original command. Ready review is re-proven with
   current actor/session/verification/home school/Safety, target organization and
   grant, exact content, independent media and optional QR. A durable receipt is
   returned once; lost responses recover it without duplicate publication.
6. `activity-native` and `activity-native-detail` show the native source, actual
   authenticated immutable media bytes, type flags, free-text time/place, and the
   explicit QR choice. `mode=mine` filters the immutable original publisher;
   transferring the organization cannot reassign publication history.

A local account/environment journal retains one unresolved original command,
plus the saved draft entry. Leaving or hiding a Page cancels transient work and
clears rendered fields/files. It does not silently cancel an uncertain server
request or invent another key. Rejected or unavailable review remains private;
explicit cancellation closes that original request before editing resumes.

## Persistence and final currentness

- New migrations only: 0103 activity publication and 0104 Activity Media.
- Draft/event/request/receipt linkage is atomic. Published identities, original
  publisher, content, review binding and media bindings are immutable.
- SQL guards also verify original command/CAS/content, cancellation fences, exact
  review request consumption and the reviewed media/QR asset identities.
- Existing organization-owned currentness facts and independent Activity/Review
  facts survive deferred waits. Required final proofs use bounded NOWAIT table
  fences and current row/version reads; registered expiration deadlines are
  evaluated after deferred work. Uncertainty rolls back the tentative publish.
- Opaque cursors are account/session/home-selection/source-epoch scoped, bounded
  through the existing shared continuation owner. There is no invented combined
  legacy/native total. Each candidate page is bounded. Explicit current Review revocation or Media
  Safety denial is omitted with its final evidence retained, and the cursor
  advances by the last checked candidate (short/empty visible pages may continue).
  Unknown or unavailable evidence still fails the page closed; it is not treated
  as a known denial or silently represented as an empty final result.
- At most 20 open drafts per account and one unresolved publication per draft;
  an original owner may explicitly `cancel_draft` after organization/grant changes,
  closing only an unfinished draft and releasing capacity with an original-key
  CAS receipt. Pending publication requests must be cancelled first. Its own
  unfinished image bindings are retired atomically into the existing reference-count
  and quiet-period cleanup path, without hard-deleting bytes or changing historical
  receipts. Published activities and organization-owned QR media are unaffected.
  request-family throttling and shared Media quotas remain enforced.

## Boundaries

No activity editing after publication, deletion, registration/sign-up,
subscriptions or legacy-to-native organizer/publisher migration is invented here.
The old backend `article_url` has no evidenced submit field in this old native
form and is not advertised as restored UI. Activity cancellation here means an original pending command or explicit
closure of an unfinished owned draft, not deletion of a published activity.

Simulation tests use the real emitted App/Page/WXML, native adapters, loopback
HTTP, AppModule and a newly provisioned disposable PostgreSQL database. Only
external wx/provider/storage/reviewer transport edges and initial school-reviewer
facts are synthetic. This does not establish WeChat DevTools, physical-device,
real provider, production deployment or complete project-wide parity acceptance.

See [Activity Media](ACTIVITY_MEDIA.md) and the generated
[Activity OpenAPI](openapi/activity-publication.json) for the exact media boundary
and routes. Test and verification results are recorded separately against the
final source tree; this document is not a blanket pass claim.
