# Framework7 native school and operations migration

This is a native WXML/WXSS presentation transcription using the existing pinned Framework7 v9.2.0 Button and Block components. No Framework7 DOM runtime, H5 page, browser router, dependency, provider connection or production management operation is added.

## Exclusive consumer scope

The ten registered routes are `school-admin-management`, `school-configuration`, `school-identity-management`, `school-posting-policy`, `school-uid-lookup`, `official-account-operations`, `announcement-edit`, `announcement-manage`, `errand-admin`, and `errand-restrictions`, each at `pages/<name>/<name>`.

Only their WXML/WXSS/JSON changes. Page/controller, contract, permission, journal, session, media and shared component sources remain unchanged. The two errand administration routes import `school-operations/f7-admin-command.wxml`, an isolated transcription of the unchanged original `errands/admin-command.wxml`. The existing native confirmation mask remains owner-controlled; this is not an F7 Sheet/Dialog migration.

## Preserved boundaries

- 184 original actions, complete ancestor guards, exact datasets, loading/disabled state, route targets and native field constraints are frozen before migration and compared against the current source. Only the known native F7 press boundary is normalized.
- 164 protected files and original legacy adapter evidence are SHA-256 checked. The shared native press bridge remains `f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05`.
- Native inputs, textarea, switch, picker, checkbox/radio groups, navigators and platform confirmation dialogs stay native. Their typed values, input lengths, consent, expiration and service ownership do not change.
- School/global authority, target public identifiers, both identity CAS versions, school policy revision, independent topic/reply flags, UTC expiration, command identity and same-key retry/cancellation controls remain controller-owned. Missing receipts remain unknown, not failure.
- Announcement audience and media revision/slot references are unchanged. The existing platform confirmation rejects a stale controller and cancellation does not publish. Official-account operations remain synthetic draft-only with no automatic publish or real provider connection.

## Verification

- Original focused preflight: 272 tests passed.
- Final focused suite: 314 tests passed, including 24 new migration checks and 18 actual native Component-to-Page tests. Original state-specific rendering covers all 50 fictional source fixtures.
- The frozen bridge executes real registered F7 Button code and unchanged Page handlers for all ten pages. The suite explicitly distinguishes exact controller-port checks from real controller/gateway/journal exercises. Real flows include school-admin management, school identity correction and cancellation, bigint-exact school UID lookup, posting-policy unknown-result recovery, and both errand management command families. Announcement modal and official recovery modes have native Page-boundary checks in addition to existing controller tests.
- School-service configuration, school UID, official draft-only, errand administration and errand mutation legacy smokes passed against current source using temporary extension-only source runners. These runs are source-model evidence, not emitted-build evidence. School-admin management also runs directly with its explicit TypeScript entrypoint option.
- Focused ESLint passed. No build, release, global typecheck, preview generator, coverage registry, browser, emulator, commit or push was run by this batch.
- The new preview fixture module exports the existing 50 fictional cases with a unique Framework7 prefix; it does not mutate the original fixtures or shared generator.

The central integration owner must run serialized typechecking, emitted build/smokes, source previews, package graph/license and budget checks against a frozen combined tree. Native device acceptance is still required for custom-component slot/style isolation, actual pressed and disabled rendering, scroll/IME/keyboard behavior, native modal focus and accessibility. There is no real provider, PostgreSQL or production acceptance claim from these source tests.
