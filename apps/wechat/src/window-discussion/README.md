# Native Window discussion images

The registered Window root, thread, notice, and recovery pages use the App's
`windowDiscussionV2` and `windowDiscussionImages` assembly. This is a bounded new
Next policy, not a claim that the old application enforced these image limits.

- Root and reply allow exact text, text plus images, or image-only content.
- Add at most three JPEG/PNG images, one at a time, at most 5 MiB each. Uploads and
  publication facts retain the order in which images were added.
- Individual removal and arbitrary reordering are not implemented. To remove,
  replace, or reorder a draft image, explicitly cancel the entire original image
  publication and its uploads. Wait for the server-confirmed cancellation, then
  start a new draft and select the desired images in their new order. An unknown
  cancellation or `not_recorded` response never authorizes a new request key.
- A cancellation cannot undo an already-applied publication. Its historical
  receipt is recovered instead; there is no new Window author-delete feature.
- Images open inside the current page with fresh first-party authenticated
  descriptors and downloads. There is no `wx.previewImage`, remote DTO URL, or
  background image cache. Only causal reply notices may offer their first image;
  like notices never have an image.

The App passes its existing single `MediaLocalFiles` registry to this owner:
10 MiB total local budget, two native transfers, and four handles. Native upload
success and native `complete` are distinct; files and capacity are retained until
quiet completion. Picker-induced hide is an explicitly scoped suspension with a
bounded foreground wait. Normal hide/unload, session changes, safety invalidation,
and late callbacks revoke the displayed or selected images.

The v2 journal is account/origin-specific metadata only: immutable request/target
identities, exact intent hash once submission is frozen, and ordered upload keys
and hashes. It stores no body, image pixels, local paths, descriptors, or credentials.
After a cold restart, query the original receipt or explicitly cancel the original
key; a cold journal cannot reconstruct and resend the original body.

The old v1 text contract, command hash, receipt, and journal remain unchanged.
Default upgraded Pages can recover an existing v1 journal. Likes and own-like
recovery remain on their original v1 routes and CAS semantics.

Verification uses focused codec/native callback tests and emitted App/Page/WXML
workers against the ordinary HTTP/PG fixture. Synthetic platform tests do not
establish real-device redirect, registered-domain, header, or production media
processor acceptance.
