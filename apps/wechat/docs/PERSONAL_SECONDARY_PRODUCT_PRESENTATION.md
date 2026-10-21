# Secondary personal pages: presentation and safety inventory

Scope: `public-profile`, `community-blocks`, `browsing-history`, `experience`,
`experience-ranking`, and `wallet`. The approved Home, Inbox and Me pages, global
styles, shared controllers, network gateways and shared templates are unchanged.

## Before → after

- Public profile: centered bordered hero, repeated page title and permanent policy
  paragraphs → actual cover and person first, opt-in capsules, compact follow/message
  actions, flat public content rows, and information/safety details behind the
  existing disclosure. All existing navigation, follow/block recovery, avatar and
  pagination actions remain. No owner-only publication or private detail fallback.
- My blocks: repeated title, full-width action cards and repeated explanations →
  compact ownership context, flat identity rows and a contextual unblock action.
  Snapshot names remain labelled. The incorrect claim that public-profile blocking
  was not implemented is removed; no new capability is introduced.
- Browsing history: repeated title and individual rounded cards → local retention
  scope with refresh/clear controls, readable flat rows and inline clear confirmation.
  Only current authorized summaries are displayed. The underlying account/session
  store, actual-detail-view recording, 200-record/30-day limit and logout clearing
  are untouched. No cross-device synchronization is implied.
- Experience: hard-coded light-only card stack and repeated title → actual
  experience summary, daily activity rows and initially closed title, record and
  redemption sections. Existing sign-in, equip, acknowledgement and exact-request
  recovery remain. A pending redemption opens its recovery context automatically,
  even when its optional section is collapsed. Experience is not money.
- Growth list: repeated title and name buttons inside cards → compact incomplete
  coverage context and flat person rows, preserving returned order. No invented
  ranks, total population, balance or sorting.
- Wallet: bare unavailable sentence → original local wallet icon and the same
  genuine unavailable state. No fake balance, payment action or experience substitute.

Native navigation supplies each page title. The body does not repeat it. Page-local
styles use the existing semantic light/dark tokens and local icon component. Shared
public-experience display styling is overridden only within these two page scopes.

## Action inventory

`test/fixtures/personal-secondary-action-inventory.json` was captured from the
working source before this pass. Tests match each original event/navigation action,
its datasets, disabled/loading/input bindings and every original conditional/loop
ancestor. Additional presentation disclosures cannot replace those guards.

| Page             | Original actions retained |           Added actions |
| ---------------- | ------------------------: | ----------------------: |
| Public profile   |                        34 |                       0 |
| My blocks        |                         6 |                       0 |
| Browsing history |                         8 |                       0 |
| Experience       |                        23 | 3 local section toggles |
| Growth list      |                         3 |                       0 |
| Wallet           |                         0 |                       0 |

The only runtime TypeScript edit is page-local experience disclosure state, with
three explicitly allowlisted keys. It resets on show, hide and unload and does not
call a controller, provider or persistent store. The public-profile available body
also has an added current/loaded/non-busy/non-block-pending ancestor guard; no
original permission guard was removed.

Existing read, hide, invalidation and recovery lifecycles remain in their original
controllers. No new full-screen overlay or exposure observer was introduced.

## Verification

- 173 focused tests passed across the new presentation suite and existing public
  profile, discovery, follow/block, browsing history, wallet, experience, redemption
  and growth-list controller/page suites.
- WeChat source and test TypeScript compilation passed.
- Focused ESLint passed for all six page TypeScript files, the fixture and test.
- Source-only preview batch: `personal-secondary`. There are 23 fictional states,
  each represented in both themes, with nonempty expected-text markers. Fixtures
  include available, hidden, guest, failed, empty and pending-result states. Public
  profile/post/capsule, block, experience and ranking samples pass actual decoders.
- Static HTML is a source-based approximation, not a WeChat or device screenshot.
  No browser, emulator, provider call, sign-in, redemption, commit or push was used.
- Source-only static preview validation passed all 46 personal-secondary frames,
  plus the existing 12 core and 4 menu/settings frames. The shared preview renderer
  converts native progress into a bounded semantic HTML meter, without relaxing
  the native-tag validation gate.
- Full-build and consolidated final validation belong to integration.

## Exact files edited by this pass

- `src/pages/public-profile/public-profile.wxml`
- `src/pages/public-profile/public-profile.wxss`
- `src/pages/community-blocks/community-blocks.json`
- `src/pages/community-blocks/community-blocks.wxml`
- `src/pages/community-blocks/community-blocks.wxss`
- `src/pages/browsing-history/browsing-history.json`
- `src/pages/browsing-history/browsing-history.wxml`
- `src/pages/browsing-history/browsing-history.wxss`
- `src/pages/experience/experience.json`
- `src/pages/experience/experience.ts`
- `src/pages/experience/experience.wxml`
- `src/pages/experience/experience.wxss`
- `src/pages/experience-ranking/experience-ranking.json`
- `src/pages/experience-ranking/experience-ranking.wxml`
- `src/pages/experience-ranking/experience-ranking.wxss`
- `src/pages/wallet/wallet.json`
- `src/pages/wallet/wallet.wxml`
- `src/pages/wallet/wallet.wxss`
- `scripts/fixtures/personal-secondary-preview.mjs`
- `test/fixtures/personal-secondary-action-inventory.json`
- `test/personal-secondary-presentation.test.ts`
- `docs/PERSONAL_SECONDARY_PRODUCT_PRESENTATION.md`
