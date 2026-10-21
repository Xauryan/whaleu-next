# Management product presentation

## Scope

Eight native pages: admin-discussion-removal, admin-post-removal, profile-avatar-moderation, profile-moderation, safety-appeal-management, safety-punishment-management, student-verification-review, and feedback-notices.

The pass is presentation-only. It does not change controllers, gateways, journals, permissions, account contracts, or the shared student-page presentation callback. No live moderation, account change, evidence download, API write, production operation, or device/emulator acceptance was performed.

## Product structure

- Native navigation names the page. The body starts with current scope, selected case, queue or capability rather than repeating a generic banner title.
- A quiet white/dark semantic surface, local icons, 44-point minimum controls, compact rows and a single primary next step replace generic boxed forms.
- Source IDs and version references live in explicit detail disclosures. Current read-only capability, evidence expiration, irreversible consequences, actor/school scope and original-request recovery remain at the relevant decision.
- Confirmation surfaces retain consequences and cancellation semantics. A confirmed historical receipt is never presented as current permission or current punishment state.
- Management-only local markup isolates the two safety-management screens from the unchanged shared account-moderation template.
- The optional local disclosure adapter changes only transient display flags. It cannot change selected cases, reason, capability, busy/frozen state, confirmation, or controller state.

## Preserved behavior

The before/after inventory at test/fixtures/moderation-action-inventory.json records every pre-existing action and disabled control, including event identifiers, values, checked states, navigation targets, dataset payloads, length/type restrictions, disabled expressions, and ancestor branch/loop guards. The baseline action attributes match the original working templates; pre-existing terminology-only changes do not affect this audit.

No pre-existing action or permission guard was dropped. Newly introduced disclosure handlers only reveal local information. Original target and version revalidation, optional punishment selection, separate mute/suspension semantics, unknown-outcome journals, original-key query/retry/cancel, cancellation-without-rollback, evidence availability/cleanup, and administrator scope remain intact.

The existing post-removal test's accidental “回复、回复” text assertion was corrected to require the clearer “此主题及其全部回复将不可访问” consequence. Its irreversible-operation, notification, recovery, capability and identity-boundary assertions were retained.

## Verification

- 38 fictional static fixture states in scripts/fixtures/moderation-preview.mjs, each with mandatory semantic text assertions. Includes ready, confirmation, additional punishment, read-only/unavailable, evidence expired, empty, original-request recovery and cancellation cases.
- 232 relevant tests pass across management presentation, original moderation/controller suites, student verification and global WXML string syntax.
- WeChat source and test TypeScript checks pass.
- Scoped ESLint and formatting checks pass. WXML is deliberately not auto-reflowed inside quoted interpolation strings.
- Preview rendering and device/platform acceptance remain separate. Fixtures contain no real actor, evidence, request or provider references and do not fetch remote assets.

## File ownership

- The eight page folders: WXML, WXSS, JSON and display-only native page adapters.
- pages/admin-post-removal/moderation.wxss and presentation.ts: scoped visual materials and optional transient disclosure adapter.
- pages/safety-appeal-management/management.wxml: page-owned management template used by the two management screens.
- scripts/fixtures/moderation-preview.mjs, test/moderation-product-presentation.test.ts and test/fixtures/moderation-action-inventory.json.
- test/admin-post-removal.test.ts: corrected consequence text assertion only.

The central preview generator registration, build output and visual snapshots belong to the integration pass.
