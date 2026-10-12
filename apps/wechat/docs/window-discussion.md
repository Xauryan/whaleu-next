# W3 native window text discussion

Four registered surfaces provide window root comments, flat oldest-first replies,
local reply/like notices, and source-independent request/own-like recovery. W1
window details link to discussion. Window catalog and global rating recovery
link to recovery without a window route ID; community updates link to notices.

- Roots default to server likes descending, then time and ID descending; time
  sorting is explicit. Replies are time/ID ascending. Revision-bound cursors are
  discarded on any snapshot mismatch, unavailable history, or visibility failure.
- Strict named author projections contain only a safe profile ID and display name.
  “Named” means the public nickname/profile, not verified legal identity. Phone
  verification is required for fresh access; affiliation/student-number status
  does not grant or block this slice. Reply commands carry an explicit nullable reply-to-reply ID. The server derives
  the recipient. A root has no accepted window-creator identity and sends no
  creator notice. Score, dish recommendations, and course comments stay separate.
- The current slice accepts nonblank original UTF-8 text up to 8000 bytes, rejecting
  NUL and malformed surrogate input. Images and image-only legacy parity, anonymous
  modes, deletion, affiliation labels, rewards and pushes are unfinished.
- Desired-state reversible likes freeze the exact nullable membership revision.
  Old receipts are historical and do not install a heart or count. A fresh public
  read or independent same-account own-like request supplies current state.
- The versioned account/origin journal is durably read back before transport. It
  cannot replace unresolved intent. Recovery is receipt-first; only a validated
  404 REQUEST_NOT_FOUND permits an explicit resend. Cancel choice is persisted
  before transport and all future retries retain that choice. Unknown storage,
  missing history and unavailable Review remain unresolved.
- Recovery retains at most 20 recent like target locators (window/comment IDs only),
  account/origin-bound and explicitly not complete history or current membership.
  These, or manually entered known IDs, allow fresh owned membership lookup and
  unlike after source/phone/Safety withdrawal. No public content is restored from
  the journal or locator list.
- Every successful false-to-true like transition has its own historical notice;
  unlike, no-op and original-request replay create none.
- Notices fetch a fresh target before navigation; the receiving thread validates
  the notice target again. The thread remains oldest-first, highlighting a target
  on its current page and explicitly identifying when it may require later pages.
  Opening a target does not mark read. Exact per-notice read is explicit and remains
  available for unavailable notices. A confirmed read invalidates old cursors and
  rereads the current notice page/count; its acknowledgment remains visible if that
  refresh fails. Unread counts are independently known, never
  manufactured as zero after a failed read.
- Page/App hide, same-account login epoch, account switch, Safety invalidation,
  cancellation and replaced route controllers clear private view state and reject
  late callbacks, navigation and writes. Origin partitions storage and runtime.

Focused unit, strict ApiClient and rendered WXML tests are distinct from the emitted
App/Page/WXML native-platform simulation against ordinary HTTP AppModule/PostgreSQL
fixtures. No simulator result establishes production source enrollment, provider
qualification, WeChat DevTools/physical device behavior, deployment or legacy media
parity. Validation status is reported by the coordinating acceptance run.
