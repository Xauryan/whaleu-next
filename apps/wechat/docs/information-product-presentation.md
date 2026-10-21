# Campus information presentation

Scope: `organizations`, `organization-editor`, `announcements`, `announcement-detail`, and `school-services`. Only their page markup, styles, component registrations and local disclosure adapters changed. The shared presentation stylesheet lives inside the owned `organizations` page folder. Home, Messages, Me, controllers, contracts, gateways and service permissions are unchanged.

## Content and actions

- Organizations opens with the application action and actual organization rows. Review tabs still require the original management capability; global school selection still resolves the real operating region.
- Organization editing leads with actual type, platform, category, name and introduction fields. The save action directly follows the fields. The complete 13-slot image library, individual image operations, members and version metadata are disclosed locally. Original-request and prior-image recovery always remain directly reachable. Public detail never renders the management-only contact image or infers editing authority.
- Announcements retain independent native and accepted-history tabs. The list uses full-width title rows; the article leads with its real title and body. Source, revision and scope explanations are secondary. Manual browsing still never acknowledges a popup.
- School services use flat sections, explicit contact values, copy gestures and controlled QR previews. Missing/disabled services remain distinct. Links are copied only through the existing refresh-before-copy controller, never opened as unvalidated URLs.
- Native icon assets and semantic theme tokens provide light/dark materials. Controls keep the shared 88 rpx minimum height. No promotional headings, duplicate native page titles, nested border cards, remote assets or runtime fixture data were added.

## Action and guard audit

`test/fixtures/information-actions-before.json` captures the original action, dataset, loop, conditional-ancestor and disabled expressions before edits. `test/information-product-presentation.test.ts` parses the final WXML and requires every original expression to remain on a matching action. The only added handlers toggle local disclosures; they do not dispatch service requests.

| Page                | Original bindings | Final bindings | Added UI controls                                   |
| ------------------- | ----------------: | -------------: | --------------------------------------------------- |
| organizations       |                10 |             10 | None                                                |
| organization-editor |                35 |             39 | Image library, slot, member and metadata disclosure |
| announcements       |                 8 |              9 | Source/scope disclosure                             |
| announcement-detail |                 3 |              4 | Article metadata disclosure                         |
| school-services     |                 9 |             10 | Source/management disclosure                        |

All 65 original bindings remain with their original datasets and ancestor/disabled guards. Existing guards still own edit/submit/review/member/owner permissions, original revision and slot selection, pending-operation locks, busy state, source separation and current visible media. The additional disclosures only narrow presentation.

The executable page test checks repeated toggle reversibility, rejection of nonexistent media slots, hide cleanup and repeated teardown. Existing controller/media tests cover lost responses, original-key cancellation and recovery, account/login-epoch replacement, stale callbacks, optional-guest reads, scope changes, popup acknowledgement separation, QR leases, clipboard refresh, media revocation and private manager-contact rejection.

## Validation

- Focused native source/controller/media suite: 61 tests passed.
- Presentation and action/guard suite: 11 tests passed, included above.
- Exact touched TypeScript, test and fixture ESLint: passed.
- Complete native source plus owned presentation test no-emit typecheck: passed. The final shared-test typecheck is owned by integration; the last local aggregate attempt was blocked only by the concurrent `package-local-icons.test.ts` ES2020 `replaceAll` diagnostic.
- Source-based preview: 16 synthetic populated/recovery fixtures, 32 light/dark frames passed semantic validation, including required content markers, no leaked WXML and no external assets.
- Preview command: `node --import tsx apps/wechat/scripts/preview-apple.mjs --source --batch=information --output=/tmp/whaleu-information-preview`.
- Preview artifact: `/tmp/whaleu-information-preview/information-product.html`; check result: `/tmp/whaleu-information-preview/information-validation.json`.

The preview is an HTML approximation generated from repository WXML/WXSS, not a native screenshot. One ordinary installed Chromium launch was blocked before a page loaded by the sandbox's socket restriction; no screenshots were produced and no escalation/retry was attempted. Pixel rendering, WeChat DevTools, physical-device, provider and production acceptance remain unverified. No shared build, service write, real publication, upload, sign-in, consent, transaction, commit or push was performed for this slice.
