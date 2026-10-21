# School and operations presentation

## Scope

The final school/operations UI batch contains exactly these ten registered native pages:

1. `school-admin-management`
2. `school-configuration`
3. `school-identity-management`
4. `school-posting-policy`
5. `school-uid-lookup`
6. `official-account-operations`
7. `announcement-edit`
8. `announcement-manage`
9. `errand-admin`
10. `errand-restrictions`

Each page owns its `.wxml`, `.wxss`, `.json`, and page registrar `.ts`. The only shared presentation addition is `src/school-operations/presentation.wxss`. It is not imported by Home, Messages, Me, public school services, public announcements, public errands, or any other batch.

## Presentation

- A small original local icon and task-specific context replace duplicated generic page headings and developer-style branding.
- Forms and records are flat, separated by whitespace and one-dimensional separators rather than nested border cards. Primary, secondary and destructive actions use the existing semantic system light/dark palette.
- School-service QR controls, official artwork controls, announcement audience and images, order participants/history, and restriction source metadata open beside their owning fields or records.
- Unknown-result recovery, authority/provider errors, expired assignments/policies, current targets, selected school/region/policy, restriction duration and destructive consequences remain visible when relevant. Confirmation and recovery are never hidden inside a discretionary detail disclosure.
- The announcement editor is text-led. Its body limits remain honest and non-truncating. Publish/update/enable/disable/cancel still use the original native confirmation handler, including selected audience.
- UID identity renders only within the original found and non-busy branch. The UI adds no private identity evidence, account lookup, role inference, external image source, provider enablement, or real operational action.
- Posting-policy display distinguishes themes from replies and corrects the former contradictory footer about its existing related-school synchronization switch. Internal fields and contracts remain unchanged.
- Official-account readiness and withdrawal enums have human-readable labels. The explicit synthetic-only, no real account connection, no automatic publishing warning remains visible.

## Preservation evidence

`test/fixtures/school-operations-action-inventory.json` was captured before edits. It records 166 page controls, 10 shared command-template controls, their event/route/dataset attributes, original ancestor conditions and loops, disabled/loading conditions, and field constraints (`maxlength`, input type, checked/value, picker mode/range).

Forty-nine controller, contract, gateway, journal, QR/identity/recovery, and shared errand-confirmation files are SHA-256 protected and remain byte-for-byte unchanged. The shared `errands/admin-command.wxml` is not edited.

All ten pre-edit page registrar hashes were verified against the existing checkout HEAD. Additional token-equivalence tests remove only the explicitly added transient `uiPanel` field, disclosure handler, lifecycle clears and render-reset spread. The remaining original registrar tokens must equal the captured pre-edit baseline, ignoring whitespace/comments and formatting-only trailing commas. This covers native confirmation handlers, exact dispatch arguments, owner checks, cancellation, media callbacks and route validation, not only imported controllers.

`uiPanel` is page-local and never persisted. Disclosure-only handlers never call controllers. Hide, Show and Unload clear the disclosure; current-view reset or authority loss also clears it. Existing account, origin, generation, request-ID/CAS, journal, receipt and media teardown logic is unchanged.

## Validation

- `test/school-operations-presentation.test.ts`: 84 passing tests covering all original controls and ancestor guards, all protected hashes, all registrar equivalence checks, in-memory compiled disclosure toggle/Hide/Show/Unload behavior, all 50 synthetic fixture markers and policy/privacy warnings.
- Final focused school, official-account, announcement, errand-administration, restriction and WXML-expression run: 244 tests passed, including the 84 new presentation tests. The integration owner records the separate full aggregate result after the frozen source snapshot.
- WeChat source and test TypeScript checks pass.
- Focused ESLint on all ten registrars, the fixture and new test passes.
- The integration-owned static source preview batch has 50 explicit fictional fixtures, rendered in both themes (100 frames). It covers loaded, denied, protected, expired, confirmation, cancellation, upload disclosure, historical detail and original-request recovery states.
- Static WXML/WXSS previews and mocked page callbacks are not native WeChat rendering, device, provider, authorization-source or production acceptance. No browser, emulator, real-role operation, identity lookup, announcement publication, official push, order action, dependency installation, commit or push was performed by this batch.

## Exact added files

- `src/school-operations/presentation.wxss`
- `scripts/fixtures/school-operations-preview.mjs`
- `test/school-operations-presentation.test.ts`
- `test/fixtures/school-operations-action-inventory.json`
- `docs/SCHOOL_OPERATIONS_PRESENTATION.md`

Together with the four page files for each of the ten pages above, the batch owns 45 files. The integration owner exclusively owns preview-generator registration, all aggregate build/release work and any combined presentation report.
