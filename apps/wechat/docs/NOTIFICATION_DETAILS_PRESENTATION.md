# Notification detail presentation

## Scope

Seven detail/timeline pages only: `community-updates`, `rating-updates`, `window-discussion-notices`, `major-discussion-notices`, `social-notices`, `system-notices`, and `notice-thread`.

The approved Home, Inbox, and Me surfaces are unchanged. No business-module sender rows were added. Social categories remain 赞和收藏 / 新增关注 / 回复和@; activity and follow notifications remain honestly unavailable until their providers exist.

## Presentation

- Flat, content-first event rows, local original `wu-icon` components, restrained hierarchy, semantic light/dark materials, 44 px minimum actions, and safe-area padding.
- Real preview text, source context, owner-provided unread states, explicit content targets, and exact existing per-row read actions. No invented sender, delivered state, read receipt, combined unread count, or history.
- Local display-only date labels retain raw server timestamps and original order. Older years remain explicit. Invalid dates render no invented date.
- Duplicate body titles and routine load-success messages are removed; category labels and action/uncertainty feedback remain. Account restriction time labels preserve seconds and fractional precision, and only a raw null end means permanent.
- Recovery/error text stays visible. Source-level coverage stays in an inline disclosure, not an overlay; partially available events stay visible.
- Public author/分身 boundaries and community identity privacy templates remain intact. Existing image controls and gallery ownership remain unchanged.

## Preserved behavior

The before-change action inventory records every original event, dataset, disabled/loading condition, and ancestor conditional/loop guard. Tests compare the new templates against those records. Original controllers, receipt ownership dispatch, route contracts, and aggregate timeline logic are protected by before/after hashes.

Only the notices render callbacks inside `window-discussion/page.ts` and `major-discussion/page.ts` add display labels. Tests hash all content before and after those specific registration functions to show that non-notice modes are unchanged.

No read is acknowledged by viewing a list. Opening, pagination, permissions, independent source cursors, session epochs, uncertain outcomes, cancellation, invalidation, and current-target resolution retain the original owning controller behavior. No new dwell observer or modal was introduced.

## Validation

- 15 presentation tests: all seven action/ancestor inventories, unchanged protected code, shared registration isolation, pure time mapping, semantic styling, real-source fixture content markers, and namespaced actions.
- 202 targeted tests passed across the presentation tests and existing community/rating/social/system/window/major owner and lifecycle coverage. Includes no eager reads, exact owner dispatch, duplicate IDs across sources, independently paged sources, partial failures, stale callbacks, account changes, hidden pages, unknown read outcomes, gallery lifetime, and recovery/CAS cases.
- WeChat source and test TypeScript checks passed.
- Scoped ESLint passed.
- 19 source-derived synthetic fixtures include loaded, unavailable, partial-source, uncertain-read, and invalid-link states. The integration preview generator owns paired light/dark rendering and final visual review. These are static approximations, not native WeChat/device acceptance.

No emulator, browser, build, deployment, provider activation, commit, push, or remote notification/read operation was run for this batch.
