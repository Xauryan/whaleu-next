# Native Framework7 personal surfaces: five-page source freeze

## Scope and provenance

This migration changes only the WXML/WXSS/JSON for `public-profile`,
`community-blocks`, `experience`, `experience-ranking`, and `wallet`, plus the
isolated personal recovery template and host stylesheet under `public-profile`.
The original shared block-recovery template stays unchanged. All five Page
TypeScript files, business controllers, contracts, stores, gateways, public
media/privacy readers, accepted Home/inbox/Me pages and global tokens are
byte-identical to the captured baseline.

The pages reuse the already shipped project-owned native Button, Block, List,
ListItem and Input adaptations of Framework7 **9.2.0**, pinned commit
`7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`. Reference and MIT provenance remain in
`docs/FRAMEWORK7_NATIVE_PORT.md` and `docs/vendor/framework7-v9.2.0/`.
No package, dependency, DOM/H5 runtime, browser router, web-view, icon or font is
added. Shared components and their source tokens are unchanged.

## Migration and preserved boundaries

| Route              | Original page actions | Native components in page source      | Explicit native exceptions                                          |
| ------------------ | --------------------: | ------------------------------------- | ------------------------------------------------------------------- |
| public-profile     |                    34 | 18 Button, 1 Block                    | Media/error/preview controls, expanded-state disclosure, navigators |
| community-blocks   |                     6 | 4 Button, 1 List, 1 Block             | Pull-to-refresh lifecycle, navigators                               |
| experience         |                    26 | 18 Button, 8 Block, 1 Input           | Progress, color swatches, expanded-state disclosures, navigators    |
| experience-ranking |                     3 | 2 Button, 1 List, 1 ListItem, 1 Block | Public experience display                                           |
| wallet             |                     0 | 1 Block                               | Honest unavailable status, no financial action                      |

The isolated recovery template retains its six original bindings: four are
Button presses; destructive confirmation and dismissal stay native inside the
existing accessible dialog container. No new overlay/session protocol is
introduced. Actionable ListItem content is presentational only.

All **75 original action nodes** retain handler identity, datasets, disabled and
loading conditions, navigation/editor constraints and ancestor conditional,
loop, hidden, disabled and loading gates. Only event boundaries change:
`bindtap` to `bind:press`, and the redemption editor's `bindinput` to
`bind:input`. The four former view-based public filter controls become real
native-button targets with the same Page handlers and datasets. This bounded
normalization is explicit in the migration and legacy presentation tests.

Public cover and demographic fields remain gated by current available profile
identity and no unresolved blocking. Named/anonymous identity boundaries are
unchanged. Unknown counts remain unknown; no likes, followers, rankings, wallet
balances, payment or provider capabilities are invented. Blocks and follows
retain original-account immutable recovery. Sign-in retries preserve the exact
original day/request, and redemption preserves literal input while storing only
the non-secret recovery handle. No new request/retry runs in a component.

The 44 px Button target and compact 16 px Block/List spacing are the existing
explicit native adaptations. The page-local stylesheet only handles host
spacing and slot layout; native components own their isolated visual states.

## Baseline and shared harness correction

`test/fixtures/framework7-personal-before-actions.json` records the original
source hashes and action inventory. The independently captured protected
manifest covers **123 source files**, including all relevant business/privacy
modules, original templates, components, Page TS, accepted root pages and global
app/design files. These baselines are not rewritten to hide differences.

One explicitly allocated shared test-harness correction changes only
`native-press-emitted-harness.mjs`'s `datasetTree` string branch. The legacy parser
already decodes attributes but leaves text entities encoded. Source text now
decodes `quot`, `apos`, `lt`, `gt`, then `amp` exactly once before rendering.
Runtime user values, host datasets, raw handler delivery and expression
execution are unchanged. Literal `&amp;gt;` remains `&gt;` rather than becoming
`>`. Regression coverage includes escaped text expressions, literal entities,
typed numeric/boolean datasets, disabled, stale and detached captures.

- Original helper SHA-256: `085e3f616ded754cb13694157e9598efe1de296c92d2b4e56748bcfb0c727d98`.
- Corrected helper SHA-256: `f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05`.

## Observed verification and integration requirements

- Dedicated migration suite: **21/21** passing, including real registered
  Component → Page → real controller flows for follow retry/block consent and
  recovery, public discovery privacy, block-list recovery, sign-in same-request
  retry, title draft/save/cancel, secret redemption recovery and ranking routing.
- Focused suite with existing privacy, media, discovery, follow, block and
  experience tests: **220/220** passing on the final source snapshot.
- Scoped ESLint passes. An earlier canonical WeChat source/test typecheck passed.
  The later combined-workspace run reported only concurrent activities/errands
  test-fixture type errors, with no personal-file error. Final serialized
  integrated typecheck remains pending with the integration owner.
- The 19 fictional fixtures render **38 light/dark source-preview frames** with
  semantic assertions, including unavailable, guest, hidden, incomplete and
  uncertain recovery states. These are actual component-source/slot expansions,
  not a native renderer or real data.
- The allocated four emitted smoke scripts use the actual registered Button or
  ListItem bridge for migrated positive paths, and actual Input methods for
  redemption. Native controls and deliberate negative controller probes remain
  explicit. Emitted smoke execution requires the integration owner's final
  combined build; it was not run by this worker.
- Only binding-boundary expectations change in the allocated legacy personal,
  following and ranking tests. Business assertions remain intact.

The runtime presentation-source total increases from **47,615 to 59,821 bytes**
(**+12,206 bytes**) across these five pages and the two new presentation files.
No new component implementation or transitive module is introduced: the same
already-shipped component/design closure is reused. These are source byte
measurements, not release package measurements. The central package graph,
license, icon closure and main/subpackage budgets must be checked on the combined
emitted artifact.

No build, dist/release write, browser, emulator, database, provider, external
mutation, commit, push or deployment was performed by this worker. Source/model
checks cannot prove WeChat stylesheet isolation, IME/keyboard order, secure input
presentation, focus, safe-area, touch/scroll cancellation or accessibility.
Tencent DevTools and real-device acceptance remain open.

`FRAMEWORK7_PERSONAL_SOURCE_FREEZE.json` contains the exact owned-file manifest
and SHA-256 hashes, excluding its own hash. Verify it before integration.
