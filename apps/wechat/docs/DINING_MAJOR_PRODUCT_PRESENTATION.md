# Dining, window and major public journeys

## Scope and boundaries

This batch covers eleven native public pages:

- `canteen-floor-scores`, `canteen-floor-score-detail`
- `window-ratings`, `window-rating-detail`, `window-dishes`
- `window-discussion`, `window-discussion-thread`
- `major-directory`, `major-detail`, `major-discussion`, `major-discussion-thread`

The earlier nine ratings/course pages, Home, Messages, Me, global tokens, original
common templates, controllers, gateways, permission policies and request journals
are not changed by this batch. Administrative, independent recovery and notice
pages retain their current presentation. No new backend field or capability is
implied. Source previews are static WXML/WXSS approximations, not native-device
or browser-render acceptance.

## Product hierarchy

| Journey            | Leading content                                         | Primary action           | Secondary surface                                                           |
| ------------------ | ------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| Floor catalogue    | Real canteen and floor labels, flat floor list          | Open a floor             | Explicit floor picker                                                       |
| Floor detail       | Canteen/floor identity and known score/count            | Rate this floor          | Decimal entry sheet and separate immutable-first-score confirmation         |
| Window catalogue   | Actual window names, location, known score/count        | Open a window            | Canteen/floor/minimum-score disclosure, recovery links                      |
| Window detail      | Actual window identity, summary and own score           | Rate or change score     | All 21 signed choices in a sheet, separate confirmation, source information |
| Recommended dishes | Actual dish names and effective recommendation counts   | Find or recommend a dish | Exact-name lookup, own-state and retract sheet, separate confirmation       |
| Window discussion  | Flat public topics, author/content/time and replies     | Publish a topic or reply | Contextual composer, tools, publication/like confirmation                   |
| Major catalogue    | Search and department filter, real major/college labels | Open a major             | Recovery and notification tools                                             |
| Major detail       | Actual major identity and known topic summary           | View topics              | Related majors and source limitations                                       |
| Major discussion   | Flat public topics/replies, author/content/time         | Publish a topic or reply | Composer, server-authorized deletion, publication/like/delete confirmation  |

The dish and discussion view contracts do not expose a window/major name. These
pages lead with actual content rather than inventing an identity or adding an
unauthorized fetch. Native navigation owns generic page titles; body headings are
content identity or section names. Public profile identity is `公开`, not proof of
legal-name verification. Primary posts are `主题`, responses `回复`, and collective
references `帖子`.

Styles are isolated to `.dining-product`, `.discussion-product` or
`.major-product`. They use existing semantic light/dark variables, original icon
assets and at least 88rpx button hit heights. The UI removes stacked card borders
and permanent technical instructions from normal reading states. Detailed
recovery and irreversible-action cautions remain contextual.

## Action and guard map

Three frozen source inventories cover 146 original actionable elements:

- `test/fixtures/dining-product-action-inventory.json`: 55 actions
- `test/fixtures/window-discussion-product-action-inventory.json`: 37 actions
- `test/fixtures/major-product-action-inventory.json`: 54 actions

The tests compare event handlers, routes, datasets, values, list keys, disabled
expressions and original ancestor visibility/loop gates. Additional presentation
gates only move controls into disclosures; they do not replace authority checks.
Rendered tests additionally exercise known/unknown history, zero, first-score
immutability, image and deletion permissions, and source-independent recovery.

Important preserved distinctions:

- Floor score range remains 1–5 with decimals. A first effective score cannot be
  replaced or deleted. Its separate confirmation says so explicitly.
- Window scoring retains every integer from −10 through +10. Zero is valid,
  unavailable history is never displayed as zero or not-yet-rated, and changing
  a score retains the existing compare-and-set/version behavior.
- Minimum window score filtering retains its existing semantics: only a positive
  threshold enables minimum-score filtering. This is explained beside the field.
- Dish names are not trimmed, truncated or normalized by presentation. The
  controller remains authoritative for its 1–10 Unicode-code-point constraint.
  Own recommendation lookup and retraction remain reachable without a loaded
  public list. Pending actions and cancellation are never gated by that list or
  the name-entry sheet.
- All pending actions use their existing exact request and receipt paths.
  Stopping local waiting is not represented as server cancellation, and uncertain
  requests must not be replaced by new ones.
- Text and image publishing retain existing qualification, review and busy/frozen
  gates. Images are still viewed through authorized local gallery delivery, not
  invented remote thumbnails. Images may not be treated as available merely
  because an item has an identifier.
- Image progress and recovery are placed inside an active sheet rather than
  hidden behind its backdrop; outside sheets they remain visible independently
  of loaded content. Only one copy is rendered per state.
- Major author/administrator removal remains capability-scoped and separately
  confirmed. Public window discussion still does not invent a deletion feature.
- New UI state is transient only. Panels close on page/account/private-view/safety
  invalidation; image-picker suspension/resume retains the existing composition
  lifecycle. Display-only date labels leave source DTO timestamps unchanged.

## Preview and verification

Reproduce the source preview without writing native build output:

```
node --import tsx apps/wechat/scripts/preview-apple.mjs --source --batch=dining --output=/tmp/whaleu-dining-preview
```

`dining-preview.mjs` aggregates three fixture modules. Each fixture supplies plain
patch data merged onto real `Page.data` and mandatory text assertions. Synthetic
labelling belongs outside each app frame; examples are never imported by runtime
or backend code. The current gallery contains 27 states and 54 light/dark frames,
including populated reading states, composition, confirmation, unknown history
and pending recovery.

Targeted checks:

```
npm run typecheck -w @whaleu/wechat
node --import tsx --test apps/wechat/test/{canteen-floor-scores*,window-ratings*,dish-recommendations*,dining-product*,window-discussion*,major-*}.test.ts
```

The pre-existing floor/window/dish template tests now load the new templates and
explicitly open score or own-dish sheets. They retain all decimal, zero, unknown,
permission, irreversible-action and independent-recovery assertions. The original
confirmation tests now assert the editable selector is replaced by the separate
confirmation, rather than requiring both to be visible simultaneously. Existing
major/window discussion template tests likewise exercise the new actual product
templates and disclosures, not legacy markup. No test is removed or skipped.

Final source evidence: 242/242 focused tests pass; 54/54 preview frames pass.
Full WeChat source/test TypeScript, targeted ESLint and scoped whitespace checks
pass. The final source-only HTML and semantic JSON are in
`/tmp/whaleu-dining-preview/dining-product.html` and
`/tmp/whaleu-dining-preview/dining-validation.json`.

The integration owner runs aggregate native build, emitted smokes and release
packaging. This worker did not write shared dist output, install software, commit,
push, activate production, or claim native visual acceptance. DevTools/physical
hardware checks for keyboard movement, safe areas, large fonts, scrolling, screen
reader focus and touch targets remain required.
