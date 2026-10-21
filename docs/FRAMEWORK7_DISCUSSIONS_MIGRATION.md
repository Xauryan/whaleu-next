# Native Framework7 major and window discussions: six-route migration

## Scope and provenance

This migration changes only WXML/WXSS/JSON for `major-directory`, `major-detail`,
`major-discussion`, `major-discussion-thread`, `window-discussion`, and
`window-discussion-thread`, plus five isolated presentation assets:

- `src/majors/framework7-product.wxml` and `.wxss`
- `src/major-discussion/framework7-product.wxml`
- `src/window-discussion/framework7-product.wxml` and `.wxss`

The existing project-owned native Button, Block, List, ListItem and Input are
reused. Their provenance is Framework7 v9.2.0, commit
`7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`, with pinned button/block/list/input
vars, base and iOS LESS sources and MIT license under
`docs/vendor/framework7-v9.2.0/`. The fixed local reference was inspected.
No Framework7/Dom7/browser runtime, dependency, web-view, font or icon package
is added. No Page/controller, contract, pending-store, gateway, media or other
business TypeScript is changed. Home, inbox, Me and global tokens remain frozen.

## Action and presentation mapping

| Source                                       | Captured original actions/navigation |
| -------------------------------------------- | -----------------------------------: |
| major-directory                              |                                    7 |
| major-detail                                 |                                    4 |
| major-discussion                             |                                    7 |
| major-discussion-thread                      |                                    5 |
| window-discussion                            |                                    7 |
| window-discussion-thread                     |                                    5 |
| Original majors product templates            |                                    4 |
| Original major-discussion product templates  |                                   34 |
| Original window-discussion product templates |                                   30 |
| Total                                        |                                  103 |

The pre-edit inventories preserve all original handler names, datasets,
conditional/loop ancestry, disabled/loading expressions and native editor
constraints. Only the explicit Component event boundary is normalized:
`bindtap` becomes `bind:press`; the directory Input uses `bind:input`.
The factual major row becomes an actionable ListItem with title, subtitle and
presentational summary slot, without nested independent controls. Multi-action
comments use Block, not an actionable row overlay. Native navigators, the
native department picker, multiline textarea, and controlled local `image`
remain explicit platform exceptions.

Existing disclosure, compose, review, cancellation and gallery containers remain
owned by their current Pages. This is not an unreviewed Sheet/Dialog conversion.
The family-only styles preserve host geometry and current safe-area ownership;
isolated components own their native surfaces, press events and state guards.
Button targets retain the established 44 px minimum; primary actions use the
48 px large source style. Compact Block/List spacing is the existing explicit
16 px project adaptation.

## Safety and source freeze

The original 103-action inventory SHA256 is
`75315012d59d1edf832158d4b1a30bb99cd7bb663414099fa0b7653beec145dc`.
The original 162-entry protected inventory SHA256 is
`3bc0b16593d7d2e2daeebe9fd4bb7ccd51f737de7fe9a531f1b327e8f6616ab8`.
Neither baseline was re-recorded after edits.

150 protected entries are checked directly against current files. Twelve
explicitly allocated presentation/test adaptations preserve their exact
pre-edit bytes as frozen text evidence instead of replacing the old hashes:

- Four allocated public presentation/media test adapters retain every original
  assertion while adding actual native Component delivery and new regressions.
- Six recovery-page WXML/WXSS/JSON files belong to a separate recovery migration.
- Two discussion-template tests belong to that same independent migration.

The two recovery Page TypeScript files and all original shared templates,
controllers, pending stores and media sources remain direct immutable checks.
The test records these ownership exceptions explicitly, rather than silently
adopting new hashes. The shared native press bridge remains unchanged at
`f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05`.

Major facts do not acquire invented ratings or creator identities. These
existing discussion contracts expose public named authors; the migration
preserves that exact contract and adds no anonymous/named toggle, avatar URL,
profile navigation or creator disclosure. Unknown summaries/history remain
unknown, not zero or empty success.

Confirmed publication/like/deletion use the existing current source, capability,
revision and request identities. Query-first retries and confirmed cancellation
retain unknown outcomes and original journals. Image uploads keep ordered
facts and metadata-only recovery; Major still requires text while Window keeps
its existing image-only publication capability. Gallery access stays first-party,
short-lived, and generation fenced. Thread navigation does not mark a notice
read; the explicit existing acknowledgement pathway remains separate.

For v2 publication, the original visible final button is disabled by `busy`,
not `imageBusy`. A rapid second native Component emission can therefore occur
before that presentation changes. The unchanged Page `imageBusy` guard rejects
it, and the actual bridge test verifies exactly one publication. This migration
does not falsely claim that the Component alone suppresses this second event.

## Observed verification

- 236 focused tests passed, including all `major-*.test.ts`, all
  `window-discussion-*.test.ts`, the new migration suite, discussion error
  ownership, F7 foundation/form controls and WXML expression syntax.
- The new migration suite checks exact action parity, immutable captures,
  registration, non-nested activation and factual/identity constraints.
- Real source Component entrypoints emit through the frozen bridge into actual
  Page and controller code. Covered flows include factual filters/navigation,
  paging, related majors, roots/replies, directed reply reset, explicit
  publication/like review, capability deletion, lost responses, original retry,
  durable cancellation, stale captures, busy, hide, safety and session fences.
- The four discussion routes exercise actual image Button → Page → gallery
  behavior with numeric ordinals, boundary navigation and close/hide late-file
  revocation. Both families exercise actual image recovery/cancel controls.
  Existing upload generation, picker, ordered finalization, journal and
  wrong-target receipt assertions remain in place.
- `scripts/smoke-framework7-discussions.mjs` exports
  `smokeFramework7Discussions({ app, dist, extension = 'js', flush })` for the
  central emitted gate. It restores its synthetic runtime fixtures and globals.
  The same entrypoint passed locally with actual source Page/Component modules
  using `extension: 'ts'`; this is not yet an emitted-build run.
- 81 unique fictional default-array fixtures cover the six routes and their
  reading, guest, loading/error, editor, publication/like/delete review,
  unknown/cancelled original, image recovery and gallery states. A source-branch
  projection check verifies every expected text marker against actual Page
  defaults. The integration owner subsequently reported successful generation of all
  162 Component-expanded source theme frames (81 fixtures × light/dark).
  That is source-preview generation evidence, not visual/device acceptance.
- Focused ESLint and formatting passed. No full-workspace typecheck, build,
  dist/release export, browser, emulator, provider, PostgreSQL or production
  operation was run by this migration worker.

## Remaining acceptance gates

The integrator must run canonical serialized typechecks, emitted build/smoke,
package graph/license/budget checks, final source-bound light/dark previews and
combined-source regression gates. Tencent DevTools/real-device acceptance is
still required for native stylesheet isolation, slot layout, hit targets,
keyboard/IME, focus, pressed-state cancellation, scrolling, overlay occlusion,
accessibility and actual dark-mode behavior. Synthetic source/model tests do
not establish any of those device properties or real backend/provider results.
