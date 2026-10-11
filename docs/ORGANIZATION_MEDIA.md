# Organization image owner (Media10)

Organizations has its own `organization-media-v1` contract and SQL owner. It
shares immutable storage, whole-wire multipart admission, request/quota fences,
canonical decoding and re-encoding, image Safety review, lifecycle cleanup,
currentness, exact two-check delivery, and native transfer/local-file budgets.
It does not use Community assets, Profile avatars, School QR images, URLs, or a
business approval as image Safety approval.

## Authority and slots

Every prepare binds the original actor, organization, application revision,
slot, exact byte declaration, and current actual role/grant authority version.
A cancelled original request is a durable tombstone. Original-key recovery is
historical metadata, not a read grant. Grant, ingress admission, observation,
and finalize re-authorize the original target and role snapshot. Revision,
role transfer/revocation, expiration, and pending application state fail closed.

Slots are `avatar`, `mainQr`, `managerContact`, `linkedOfficialQr`, and
`introImage0` through `introImage8`. The manager contact exists only for WeChat;
the linked official QR exists only for QQ/WeChat. Organizations owns required
field validation on submission. Each slot is independently prepared and can be
recovered without disturbing ready images in the other slots.

`mutate` accepts an exact current pointer set and partial keep/remove/replace
changes. Omitted slots mean keep. Every retained image is checked against current
Media Safety evidence. The Organizations transaction publishes the returned
pointer set with revision + 1. Deferred SQL guards couple the original scope,
binding, immutable appearance, owner content event, pointer, and retirement in
both directions. Cross-organization, cross-slot, cross-actor, cross-revision,
foreign-owner and detached bindings cannot be adopted.

## Read and integration surface

All descriptor and byte requests require an authenticated current Organizations
read permission. Public reads require the exact currently approved organization
revision. `managerContact` is rejected on public routes before owner/media work.
The private management route relies on Organizations' applicant/role policy.
The exact same read authorization is repeated around immutable storage opening;
bytes are paused until the second authorization commits. No originals, redirects,
provider locators, signed public URLs, range responses, or public caching exist.

API prefix: `/v3/media/organizations`.

- `POST /upload-intents`
- `GET /upload-requests/:id`
- `POST /upload-requests/:id/cancel`
- `GET /upload-intents/:id`
- `POST /upload-intents/:id/{grant,finalize,cancel}`
- `POST /upload-intents/:id/uploads/:grantId`
- `GET /{public|management}/organizations/:organizationId/slots/:slot/descriptor?applicationRevision=N`
- `GET /{public|management}/organizations/:organizationId/slots/:slot/bindings/:bindingId/:variant?applicationRevision=N`

Register `OrganizationMediaController`, `OrganizationMultipartInterceptor`,
`OrganizationMediaRequestGuard`, and `OrganizationMediaService` with the shared
`MediaDeliveryBudgetPool`. `ORGANIZATION_MEDIA_RUNTIME` is explicit trusted DI;
normal production registration is null until real provider infrastructure is
independently configured. Null denies prepare/upload/read before native/provider
byte effects. Synthetic test DI does not activate a production provider.

Organizations implements `OrganizationMediaAccessPort`. Its write authorizer
locks real authority and retains external session, Verification, Campus, Safety
and Authorization evidence. `retainMediaCurrent` is called for prepare/ingress
flows. A content mutation instead finishes the Organizations current proof after
its own row write. Business review calls `requireCurrentBindings` independently
of its own approval decision.

Native integration uses `createOrganizationMediaRuntime`. Uploader `pick`,
`recover`, and `cancelPending` take organization/revision/slot; reader `load`
additionally takes public/management audience. After a successful business save,
call `reconcile(organizationId)` to clear only server-confirmed bound/terminal
original journals. `pendingTargets` exposes remaining original targets for
recovery/cancellation, including prior revisions. The origin/account-partitioned
journal is capped at 26 entries and stores only the original declaration and
request identity, never credentials, paths or image bytes. `hide` clears display
and cancels native work; account changes revoke held file authority. Shared native
credits are retained until actual completion, including late callbacks.

## Validation boundary

Focused tests cover closed backend/native codecs and matching request hashes,
opaque transaction proofs, foreign owner/revision/slot rejection, mandatory
private-slot exclusion, session switching, aborted downloads, required no-store
headers, and late byte cleanup. PostgreSQL and native roundtrip checks must run
against the final integrated owner wiring; unit tests alone do not establish
that a real provider, production deployment or production migration is ready.
