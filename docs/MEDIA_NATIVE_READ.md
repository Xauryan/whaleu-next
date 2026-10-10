# Native authenticated media read: N1

## Scope and activation boundary

N1 adds a read-only viewer for the ordinary Community detail page's single post
image. It does not depend on upload selection or upload availability. Comments,
replies, feeds, multi-image posts, other owners, uploads, compression and recovery
journals are not enabled. Server S1 contracts, provider configuration and database
migrations are unchanged.

The app constructs the runtime with `verifiedNativeDownload = false`. It remains
explicitly unavailable until the target WeChat runtime, legitimate download
origin and Authorization/redirect behavior pass device acceptance. Tests may
construct the adapter or opt in a synthetic native bridge. This is not a public
URL fallback or a production environment toggle.

## Request and local-file ownership

- Decode descriptor v1 exactly. Build only the configured HTTPS origin's fixed
  `/v1/media/bindings/:bindingId/:variant` route. No remote URL, token, original
  variant or local path is accepted in an attachment descriptor.
- Every initial display, page re-show and expansion/collapse makes a current
  authenticated request. Duplicate in-flight expansion taps share one operation.
  The caller's account/epoch remains fixed while token revision may refresh.
- At most one same-account refresh/replay, only after the explicit
  `401 ACCESS_TOKEN_EXPIRED` JSON envelope. Delete the failed response before
  refresh. A raw 401, media denial or 503 does not trigger refresh.
- Require real `onHeadersReceived` metadata before success; reject duplicate
  header events, non-200, partial/redirect response, wrong type, absent or
  mismatched length, missing no-store, oversized or malformed local output.
  Compare platform file size and local image dimensions/type with the descriptor.
  `getImageInfo` is only presentation validation, never a frame-count proof.
- Request and file-validation waits are bounded. Native progress and response
  length enforce a 5 MiB application limit; abort cannot promise zero additional
  platform bytes. Two whole download/validation operations are admitted at once.
  Two native tasks can remain outstanding; a cancelled task that never calls
  complete retains its native slot rather than allowing unlimited abandoned IO.
- Opaque handles require in-memory object identity, viewer account/epoch and
  page-owner identity. Only the registry resolves a path into ephemeral page
  data. No `saveFile`, storage entry, journal, remote URL or global image cache.
- Up to four leases/cleanup tombstones are admitted, with at most 10 MiB in live
  leases. Two already admitted callbacks may temporarily add cleanup tombstones
  beyond that threshold; this blocks further work until cleanup succeeds. Files
  produced after cancellation are removed, and output from the same callback is
  not deleted twice. Cleanup retries run before later requests.
- Revocation precedes unlink. Failed deletion consumes capacity and never
  restores a handle. New-process handles cannot resolve old files. Native temp
  files can outlive the process; no restart scan or persistent cleanup index is
  claimed. Never scan/delete arbitrary paths or assume platform secure erasure.

## Page and preview lifecycle

The existing detail controller's fresh-parent callback supplies the descriptor;
its null callback clears media before refresh, parent disappearance or deletion.
Page hide/unload, account/epoch change, App hide and private-view/Safety clearing
synchronously remove the source, then cancel and release owned files. An old
image error event cannot invalidate a newer source. A missing local file fails
closed. Unknown denial responses remain unavailable rather than asserting a
known authorization decision.

Expansion is an in-page image, not `wx.previewImage`. Native preview success or
complete is not a close signal. Already seen bytes, screenshots, platform decoder
caches and an uncooperative OS cannot be remotely withdrawn by clearing the page.

## Platform evidence and outstanding acceptance

The narrow adapter follows the official [WeChat API typings](https://github.com/wechat-miniprogram/api-typings)
and [generated API definitions](https://raw.githubusercontent.com/wechat-miniprogram/api-typings/refs/heads/master/types/wx/lib.wx.api.d.ts),
checked 2026-10-10. Download response headers are available on the task callback,
not the success result. Bounded `readFile` position/length and download timeout
require base library 2.10.0; headers require 2.1.0. The supported target therefore
must be at least 2.10.0 and expose headers/progress/FS/image-info methods.

Static source compatibility is not device validation. Real iOS/Android callback
ordering, credential forwarding during redirect, legal domains, temporary-file
lifetime, filesystem behavior, resource containment, COS and independent-account
checks remain mandatory release gates. No new package was installed for these
structural types; adopting a pinned official typing package is separate tooling
work. Unit/HTTP-native bridge execution results must be recorded separately from
these implementation statements. No real device/provider acceptance is claimed.

## Executed local acceptance (2026-10-10)

- Native focused tests: 165 passed; complete native suite: 2,165 passed.
- Native/API TypeScript checks, changed-file ESLint/format checks and native build
  passed. The build includes the emitted real detail Page smoke with the synthetic
  SDK bridge, including repeated expansion/collapse and hide/late-file cleanup.
- Six PostgreSQL integration files passed 62 tests serially through the repository
  PostgreSQL wrapper. This includes real PNG/JPEG HTTP-to-native file downloads,
  actual Page concurrency, server content hashes, revocation, session replacement,
  expired access-token refresh, token rotation and real rate-limit records, plus
  existing community/reporting/Safety/Updates contracts and Media publication.
- The synthetic fixture's explicit test-only `authRateLimit` option configures the
  real limiter with a fixed public test key. Its default remains unavailable;
  provider login stays unavailable even with the option. Default refresh does not
  consume the token, and fixture construction failure closes the real application
  before removing its temporary storage. These paths have PostgreSQL coverage.

Only device IO is replaced in the HTTP-native bridge. The synthetic server uses
its existing exact content/Review proof fixture; ordinary production AppModule
Media proof remains unavailable. These local checks do not satisfy the device,
legal-domain, redirect or COS release gates above. The normal app keeps native
media download disabled until those gates are independently accepted.

The subsequent integrated root gate passed 5,798 tests (2,207 main PostgreSQL,
27 semantic, 1,374 API, 2,165 native, 5 stats and 20 search evaluation), with zero
failures/skips/cancellations/TODOs. All lint/typecheck/OpenAPI/build/format gates
also passed. Hosted publication checks remain pending; device and production
activation requirements are unchanged.
