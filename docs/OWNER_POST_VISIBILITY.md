# Author post hide and restore

## Boundary and source evidence

This is a new, independent author-visibility overlay, not moderation, deletion,
new publication, or renewed Review approval. Migration `0126` only adds new
objects. Earlier migrations, publication bodies/hashes, accepted Review envelopes,
publication receipts, Media bindings, pin identities and reward origins remain
unchanged.

The inspected legacy backend is
[WhaleUCampus/WhaleU Message.php at 57cf169](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Message.php),
blob `bbdf415a864e5a4c060efe4111f2b83378118b40`, retrieved again for this slice:

- `3573–3627`: `setHidden` authenticates the actor; validates exact post and desired
  flag; rejects deleted/missing posts and every nonauthor; updates independent
  `is_hidden`; invalidates distribution and detail caches. There is no admin
  override, republish, reward, or media deletion in this handler.
- `2343–2349`: hidden detail is only available to its author.
- Public list/hot/pin predicates exclude owner-hidden posts (`1170`, `1187`,
  `1468`, `2002`, `4444`).

These are backend facts. No claim is made about a legacy native page that has not
been inspected. Next's My Publications and detail controls are new native wiring.

## Commands and recovery

Authenticated authors use `/v1/me/community/owner-visibility-commands` with an
original UUIDv4 `clientRequestId`, exact `postId`, desired boolean `ownerHidden`,
and `expectedVersion`. Missing overlay means visible/version zero. Every accepted
command advances the version, including a same-state command, without replaying a
publication. Stale version, cancellation, and deleted-target receipts are terminal
and immutable. A request cannot be reused with different bytes or another actor.

The request route `/v1/me/community/owner-visibility-requests/:requestId` and its
`/cancel` action preserve the original actor/request/intent. A recorded result is
looked up before any new-operation gate. Cancellation never reverses an applied
command. Management at `/v1/me/community/posts/:postId/owner-visibility` returns
only post ID, overlay state/version and change eligibility; My Publications also
includes minimal overlay state. Neither route returns text, image descriptors,
underlying anonymous identities, or Review/Safety evidence.

The native journal is account-and-origin scoped and persisted/read back before a
request is sent. Response loss and a cold restart recover or cancel the exact old
request, never silently manufacture a replacement. Account/origin changes discard
late UI work and invalidate local content/media projections.

## Current access and deliberate Next restrictions

Public feed, hot, search (including descendants), profile/trading lists, saved and
liked history/counts, pin presentation and notice targets suppress owner-hidden
posts even for their author. A pin continues reserving its existing slot while
hidden; it is neither deleted nor acknowledged through author-private detail.

Private author detail and its children may remain readable only under all current
source, moderation, Review, Safety, account/session and Media gates. Moderation's
existing `visibility='hidden'` still denies the author. Hidden descendant authors
who do not own the parent have no exception. Media descriptors and delivery retain
parent proof before and after storage open, using the existing shared Media pool.
The independent state/version/row-lineage proof includes the absence baseline and
is revalidated under a final mutation fence; count/search epochs include this
owner. No raw body or old bytes are used to recover a command.

A conservative Next policy rejects new comments/replies, positive likes/saves,
votes, formation joins, new community-sourced DMs, trading reopening and new
pin/read operations while owner-hidden, including
for the author. Existing original receipts and bounded negative cleanup remain
recoverable. Hidden private detail contributes no new view heat; its reporting
acknowledgement has zero accepted views without consuming the later public-detail
counter. Closing a trading listing remains a permitted negative transition.
This is not a claim that every legacy interaction handler had the same
rule. Unhide uses current account/session and Safety write eligibility; it neither
republishes nor bypasses content read gates. Hide and minimal recovery can withdraw
content without relying on its body being readable. Clearing the overlay is not a
claim of public availability when another gate still denies the content.

No hide/restore operation sends a publish notification, repeats a reward, unbinds
Media, requests byte deletion, changes retention, or restores a deleted post.

## Verification scope

The new real PostgreSQL/AppModule and emitted-native journeys are registered with
Community integration ownership and the existing simulated journey runner. Local
acceptance logs and frozen source manifest are supplied separately with the final
candidate; a written test case is not itself a passing result.

Remaining independent gates include real source mappings and historical imports,
production provider/storage/retention activation, actual physical WeChat devices,
and the rest of legacy parity. Synthetic accepted fixtures demonstrate the bounded
journey without asserting these production gates are open. No production access,
provider activation, role creation, or legacy data import is part of this slice.
