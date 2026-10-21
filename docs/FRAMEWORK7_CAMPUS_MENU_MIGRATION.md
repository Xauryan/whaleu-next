# Native Framework7 campus and service menu port

This is WhaleU's own native WXML/WXSS component transcription of Framework7
v9.2.0, commit `7668f883c29f69dd2ad7bd8ac3b35b9124082b0b`, not official
Framework7 WeChat support. The pinned MIT attribution is retained in
`docs/vendor/framework7-v9.2.0/LICENSE` and release notices.

## Exact scope

- `campus-hub`: current campus selector, authoritative tool actions, native
  learning/life navigation, contextual recovery/error states, and inert academic
  service availability. Existing native bottom navigation is unchanged.
- `account-menu`: existing native navigator destinations presented as an iOS
  list. No new permission, financial feature, or administrative operation.

Existing Button, List and ListItem components are reused. Navigator wrappers
contain noninteractive ListItems, with only presentation icons in named slots.
There are no nested interactive slot controls or duplicate navigation handlers.
Page/controller TypeScript, tool scope/route authority, and accepted Home,
Messages and Me sources are unchanged.

The three tool actions now use a flat component list. Unknown/missing catalog
entries still route to the authoritative tools catalog, not guessed identifiers.
Timetable and grades remain explicitly unavailable; this UI port does not claim
that their business capabilities are implemented.

## Evidence and precise test adaptations

- Seven original action/navigation nodes retain every original attribute,
  dataset and conditional/iteration scope; only known F7 press boundaries normalize.
- Six protected Page/controller/global/bridge sources retain exact captured hashes.
- The existing campus flow test now exercises real registered ListItem/Button
  events into the original Page and ToolHubController: route coalescing, missing
  catalog fallback, busy suppression, late hide cleanup, auth recovery, and a
  real synthetic gateway failure followed by explicit retry and successful load.
- The old core action inventory gains only `campus-hub` in its explicit known
  normalization allowlist. It does not accept arbitrary custom components.
- Original copies of both affected test files are retained in fixtures. No
  baseline expectation is silently regenerated after editing.
- 23 focused tests passed; an independent read-only review ran 29 distinct
  focused/foundation tests and the final four hub tests, with no confirmed issue.
- Six fictional states, twelve source-derived light/dark frames pass semantic
  checks. These are not WeChat compiler, hit-testing, accessibility, or device proof.
- Scoped ESLint and formatting pass. Final combined types/build/package tests
  remain part of the central source checkpoint.

Presentation bytes decrease by 801 before packaging: campus -1,087 and menu
+286. No new runtime dependency or component implementation. Final main-package
ownership and budget are measured centrally, not inferred from source size.
