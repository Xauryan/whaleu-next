# Ratings and course product presentation

Scope: the nine public pages `rating-catalog`, `rating-detail`, `rating-thread`,
`rating-create`, `rating-scoped`, `rating-random`, `course-ratings`,
`course-rating-detail`, and `course-comments`.

This is native TypeScript/WXML/WXSS presentation work. It neither activates a
backend/provider nor changes a domain controller, policy, request journal,
permission, mutation key, source record, or deployment configuration. Home,
Messages, Me, dining/window/major journeys, and administrative/recovery pages
are outside this batch.

## Information architecture

| Page             | Leading content                                                  | Primary action                        | Secondary surface                                                                     |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| Rating catalogue | Course/dining/major entrances, actual categories, actual objects | Open category/object                  | Range selection, category create/random, recovery/management menu                     |
| Rating detail    | Actual object, compact known score, flat evaluations             | Write evaluation                      | Own score, distribution, sorting, per-evaluation deletion menu                        |
| Rating thread    | Actual object and root evaluation, flat replies                  | Reply to root                         | Per-reply actions, collapse, anchored first page, recovery menu                       |
| Add object       | Name and optional description canvas                             | Submit application                    | Existing pending recovery/cancellation remains visible                                |
| Scoped ratings   | Explicit campus scope and actual catalogue/object                | Open object or write evaluation/reply | Range, cover, creation/editing, management, subscriptions and updates                 |
| Random choice    | Chosen object's identity and known score                         | Open result / draw again              | Explicit global/campus scope and optional minimum score                               |
| Course catalogue | Search, department, course names, three independent scores       | Open course                           | Category filter and recovery menu                                                     |
| Course detail    | Course identity and three independent scores                     | Rate course once                      | Score sheet, separate irreversible confirmation, provenance disclosure                |
| Course replies   | Exact body, date label, like count                               | Write reply                           | Compose sheet; separate publication, irreversible-like and cancellation confirmations |

`ratings/product.wxss`, `ratings/product.wxml`, and `course-ratings/product.wxml`
are imported only by this batch. Native navigation owns page titles; body headings
are reserved for actual object/course/campus identity. Original `wu-icon` components
replace text glyphs, and named identity is labelled `公开`, never legal-name proof.
They use existing semantic theme variables and
leave legacy recovery/management styles untouched. All interactive text, tabs,
and score controls retain at least an 88rpx hit height. No personal reference
image/artwork or example profile content is included in runtime assets.

## Action and safety map

The frozen inventory in `test/fixtures/ratings-product-action-inventory.json`
contains 201 original actionable elements. The matching test retains event names,
routes, identity/target datasets, values, loop keys, loading flags, and per-control
disabled/visibility guards. Presentation-only classes, style, placeholder and
accessibility labels are excluded from identity matching.

- Score selection still requires the original known-current-score and server
  permission gates. Unknown is not shown as zero or not-yet-rated.
- Course first-score confirmation remains separate and explicitly irreversible.
  Zero is not confused with an unset value; three dimensions remain independent.
- General evaluation and reply identity is still an explicit allowed-mode choice.
  Public course replies still expose no author/persona/avatar identity.
- Pending requests keep original recovery/retry/cancellation actions visible,
  including when content cannot load. None of the added disclosures settles or
  replaces a request.
- A failed likes sort still exposes an accessible time-sort exit outside the
  loaded-detail block. This avoids trapping the reader in a failed sort.
- Deletion actions moved into row-local menus without changing authorization or
  the separate destructive confirmation. Rendered smoke tests now open each menu
  and assert only the permitted row exposes deletion.
- Scoped thumbnails gained a nullable entry guard before reading local media;
  missing thumbnail state never becomes permission to render a cover.
- Only transient `uiPanel` state was added. It closes on show/hide, invalidation,
  account/session changes and loss of loaded/authenticated state. Publication and
  scoring drafts remain owned by existing controllers.
- `ratings/presentation.ts` derives display-only date labels. It does not rewrite
  DTO timestamps or invent "just now" for missing/invalid dates.

## Verification

Reproduce source preview with:

```
node --import tsx apps/wechat/scripts/preview-apple.mjs --source --batch=ratings --output=/tmp/whaleu-ratings-preview
```

The fixture module supplies 16 explicitly fictional states, including populated
catalogue/detail/reply lists, score/compose sheets, and pending recovery. The
renderer labels synthetic content outside every app frame. The source-based
light/dark HTML and semantic validation JSON are output separately; all required
fixture markers must be present in both themes. This is not browser screenshot
or native-device acceptance.

Targeted checks:

```
npm run typecheck -w @whaleu/wechat
node --import tsx --test apps/wechat/test/{ratings*,rating-*,course-*}.test.ts
```

Existing presentation tests were retained with new-copy/new-disclosure assertions,
not removed. Specifically: three course-reply tests still prove identity absence,
exact-body/irreversible confirmations and pending cancellation; the course-detail
test checks pending-vs-unrated and opens provenance explicitly; the scoped-native
test verifies the same real handlers/routes and now toggles its range disclosure;
the random-native smoke still validates the complete 2,048-candidate pool and
unknown/zero/empty/race behavior using its new text labels. General emitted rating
smokes now load both original and scoped product templates and open contextual
controls before checking their original permissions.

Current final source checks: 840/840 focused tests pass; 32/32 light/dark
preview frames pass their required-content gates; targeted ESLint and whitespace
checks pass. Source and test TypeScript checking also passed after implementation.

The integration owner runs aggregate native build, emitted smokes and release
packaging. This worker did not overwrite shared build output, install software,
activate production, commit, push, or claim WeChat rendering. Native DevTools and
physical-device keyboard, large-font, safe-area, back navigation and accessibility
acceptance remain required.
