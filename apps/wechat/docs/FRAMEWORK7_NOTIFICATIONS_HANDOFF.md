# Framework7 native notifications handoff

## Exact boundary

Seven existing routes only: community-updates, rating-updates, window-discussion-notices, major-discussion-notices, social-notices, system-notices, and notice-thread. Their WXML/WXSS/JSON are migrated; every Page/controller/gateway/aggregation TypeScript file remains byte-identical. Accepted Home, Inbox and Me, shared components/tokens, central coverage and preview generator remain untouched.

The pinned source is Framework7 v9.2.0, commit 7668f883c29f69dd2ad7bd8ac3b35b9124082b0b. The existing native f7-button, f7-block, f7-list and f7-list-item ports are reused without edits, dependencies, DOM runtime, H5 replacement or additional overlay. Upstream Button/List/Block LESS was inspected at the pinned reference. Existing 44 px interaction minimum and explicit compact spacing adaptation remain the component owners' contract.

## Composition and preservation

- Flat existing event bodies, source context, unread dots, dates and preview prose stay unchanged. F7 List groups existing native event rows; F7 Block owns existing footer/empty-state presentation. There are no new module sender rows or arbitrary cards.
- 37 Buttons and one social content-opening List-item replace the corresponding native tap controls. The read action remains a sibling of the actionable social row; no interactive slot is nested beneath its hit layer. All 19 native navigators preserve their original URL and visibility semantics.
- Exactly 57 original actions retain their datasets, loading/disabled constraints and full conditional/loop ancestry. Rating category buttons retain owner-controlled category selection and the original onCategory handler; they do not introduce a new selection adapter.
- Exact notice IDs/source namespaces, independent source pagination, current-target validation, partial availability and owner-provided counts are unchanged. Lists never acknowledge on view. Unavailable follow/activity providers remain unavailable; no combined count or source is fabricated.
- The existing discussion gallery templates and ownership remain unchanged, including local image source and hide/logout teardown. No shared window/major registration, formatter or controller is edited.
- 307 before/after protected hashes cover all relevant Page/domain/controller/aggregation files, media/gallery/privacy, the accepted roots, native component definitions and global tokens.

## Evidence

- 606 targeted tests passed, including 17 new migration tests, 15 prior notification presentation tests, full relevant community/rating/social/system/window/major owner regressions, native gallery tests, F7 foundations/segmented tests and source WXML expression syntax.
- Actual native Component registrations dispatch their isolated press event to the registered Page and real owner controller. Cases cover exact acknowledgment IDs, duplicate IDs across namespaces, no eager reads, opaque/independent cursors, category owner dispatch, partial availability, unavailable targets, unknown read outcomes, busy/cancel, hidden-page and logout fences, and invalid/unavailable routes.
- Source TypeScript, test TypeScript and scoped ESLint pass; the edited smoke script passes node --check.
- scripts/fixtures/framework7-notifications-preview.mjs exports the same default-array contract as framework7-collections-preview.mjs. It contains 19 exact bounded clones of the existing fictional notification fixtures, with unique Framework7-prefixed IDs. Existing content-marker tests pass.
- The exact test command, fixture IDs, file inventory and hashes are in framework7-notifications-handoff.json.

## Central integration still owned by the parent

1. Add framework7-notifications to the central source-preview fixture batches and render paired light/dark previews from actual components/slots. This batch does not run or modify the central generator.
2. Record these seven routes and 19 fixtures in the central coverage/review matrix only after integrated checks.
3. In scripts/smoke-build.mjs, replace the assertion `assert.match(updatesTemplate, /bindtap="onRead"/);` with `assert.match(updatesTemplate, /bind:press="onRead"/);` when integrating this migrated source. Do not rewrite the existing receipt/owner tests. scripts/smoke-system-notices.mjs now enumerates both native tap and custom press handlers without skipping original assertions.
4. Run the emitted native bridge/smokes, immutable export, package graph/license/budget gates and visual QA in the parent's next isolated snapshot.

No build/dist, release packaging, browser/emulator, provider/network operation, remote acknowledgment, commit, push or deployment was performed for this batch. Source/model tests do not prove Tencent runtime style isolation, accessibility/aria-expanded, slot hit testing, focus, navigation or native image-gallery behavior. Those remain explicit device gates, not completed claims.
