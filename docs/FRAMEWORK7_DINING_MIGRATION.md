# Native Framework7 dining: five-page source freeze

## Scope and reference

This migration owns only presentation for `canteen-floor-scores`,
`canteen-floor-score-detail`, `window-ratings`, `window-rating-detail` and
`window-dishes`. Their Page TypeScript, controllers, contracts, gateways,
request journals, permission checks and recovery logic are unchanged.

The native Button, Block, List, ListItem and Input ports already shipped from
Framework7 **v9.2.0**, commit
`7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`, are reused without edits. The
pinned upstream button/block/list/input vars/base/iOS LESS references and full
MIT license remain under `docs/vendor/framework7-v9.2.0/`. No npm dependency,
DOM runtime, browser, H5/web-view, Apple font or symbol asset is introduced.

`canteen-floor-scores/framework7-product.wxml` and
`window-ratings/framework7-product.wxml` are isolated presentation forks of the
original status/summary templates. The new `dining/framework7-product.wxss`
is a host-layout adaptation imported only by these five pages. Original shared
product templates/styles and other dining/discussion/admin consumers remain
unchanged. Home, inbox, Me, app globals and native component implementations
are hash-protected.

## Component map

Counts refer to source nodes, not repeated runtime list instances. Imported
status-template actions are counted separately.

| Page                                   | Original action nodes | Added native components                                    |
| -------------------------------------- | --------------------: | ---------------------------------------------------------- |
| canteen-floor-scores                   |                     5 | 3 Button, 1 Block, 1 List, 1 actionable ListItem           |
| canteen-floor-score-detail             |                     7 | 6 Button, 1 Block, 1 Input                                 |
| window-ratings                         |                    10 | 5 Button, 1 Block, 1 List, 1 actionable ListItem, 1 Input  |
| window-rating-detail                   |                    10 | 9 Button, 1 Block                                          |
| window-dishes                          |                    20 | 16 Button, 1 Block, 1 List, 1 actionable ListItem, 1 Input |
| isolated floor/window status templates |                    16 | 14 Button; 2 native navigators retained                    |

All **68 original action nodes** retain their original datasets, destinations,
visibility/loop/hidden ancestor scopes, disabled/loading conditions, editor
constraints and native route targets. Only the explicit event boundary changes:
`bindtap` becomes isolated `bind:press`; `bindinput`/`bindconfirm` become
`bind:input`/`bind:confirm` for the three one-line editors. Added attributes are
restricted to documented presentation/accessibility properties. There is no
Page adapter or new business state. Actionable ListItems contain presentation
only, and window aggregate slot content has an explicit accessibility label.

Lists group complete rows and identify the final separator through the existing
native loop index. Selected canteen and signed-score states use the Button
variant, not selectors that cannot cross native style isolation. Primary actions
use the pinned large 48 px Button; the established 44 px minimum touch-target
and compact 16 px Block/List adaptations remain explicit.

## Protected behavior and retained native boundaries

- Floor scoring still accepts the controller's 1–5 decimal range and is
  first-active-score only. It remains independent from window scoring; no
  edit/delete entry is introduced.
- Window scoring keeps all 21 integer choices from -10 to +10, including valid
  zero, and version-fenced changes to the current owner's score.
- Recommendation lookup, recommend/retract confirmation, exact raw dish name,
  independent historical retraction, opaque dish identity and anonymous
  aggregate presentation remain unchanged. Unknown history is never presented
  as absence or zero.
- Unknown outcomes preserve original account/origin/target/version/request
  identity. Receipt reads precede retries; durable cancellation never resends a
  score or recommendation. Cancellation is not treated as undoing a committed
  operation.
- Native `picker` controls and native `navigator` routes are retained. Existing
  owner-controlled mask/sheet/confirmation containers remain native `view`
  structures; this migration does not introduce a new overlay lifecycle.
- These five pages have no media or long-press actions. Other routes' native
  media/security and long-press handling are outside this migration and remain
  untouched.

## Frozen evidence

The original action capture was taken before runtime edits. Its SHA-256 is
`80381739efc084ee4b263ebe538fa3b8502d575f4af77ec1be0b6d2a62c84485`.
The 92-file protected capture SHA-256 is
`68539e52c85883d2fdf1fa5625bbd7ce5ee0ebda1dfe7f8d858c16f8ad5eed4b`.
The tests assert both capture files' fixed hashes, preventing a re-recorded
expectation from silently masking changes. They then verify every current
protected source hash and each original action inventory.

The final owned manifest is `docs/FRAMEWORK7_DINING_SOURCE_FREEZE.json`;
it hashes all owned presentation, fixture, test and documentation files,
excluding itself. The raw presentation byte total grows from 21,036 to 32,104
bytes, **+11,068 bytes**, including the three new isolated presentation files.
This is a source-byte count, not a canonical package/upload measurement. No
new native component or runtime dependency is introduced. Integration owns the
combined build/package graph, byte budget and release gate.

## Observed validation

- Focused migration suite: **31/31** passed. Actual registered native Components
  execute their event methods and dispatch isolated events to real Page handlers
  and real controllers with synthetic gateways. Coverage includes decimal
  first-score, all signed window scores/zero/edit CAS, explicit confirmation,
  raw editor drafts, native picker/route identity, dish lookup/retract,
  continuation invalidation, receipt-first retries, durable cancellation,
  repeated/disabled/hidden/detached events and late account-replacement reads.
- Focused plus all floor/window-rating/dish contract, gateway, controller and
  template suites: **94/94** passed.
- The three approved legacy template suites retain their existing assertions,
  now matching actual native component tags/event bindings and the isolated
  status imports. No shared smoke generator or emitted harness was edited.
- **52 fictional fixtures** cover all five pages and their populated/empty,
  filtering/info, first-score/edit/recommend/retract confirmation, guest,
  busy/error, unavailable history, paging/restart and frozen cancellation states.
  Actual local Component WXML and slots expand for text-marker verification.
- Owned tests/fixture lint and formatting passed. Narrow ES2020 typecheck of all
  runtime TypeScript plus owned migration/legacy tests passed. The combined
  test typecheck at the time of this freeze had only unrelated active courses
  and private-chat migration errors; no dining diagnostics. Integration must
  rerun the combined gate after those owners finish.

## Limits

No canonical compilation, emitted-build smoke, package/release generation,
commit, push, deployment, browser, emulator, production provider or PostgreSQL
operation was run by this five-page worker. Parent-owned source light/dark
previews must be regenerated against the final manifest.

Source expansion and synthetic Component→Page tests do not prove WeChat style
isolation, keyboard/IME ordering, focus, scrolling, native picker operation,
real touch cancellation, screen-reader behavior, safe-area geometry or modal
occlusion. Those remain explicit Tencent DevTools and real-device gates.
