# c27 native source integration

The current c27 integration implements plain/Markdown draft writing and preview plus source-aware detail/thread reading. Original source can be read without M2; production-capable human `source_manual` review and optional formatting each require their own explicit opt-in. Normal migrations now include immutable source 0175 and formal durable-reading 0176. See [READING_C27_INTEGRATION.md](READING_C27_INTEGRATION.md) for exact source hashes and current validation. This is implemented local code, not a provider or production activation. The original native-v1/v2 lineage is retained below as history.

## Native product routing

- Fresh ordinary supported text defaults to explicit plain/auto. Posts use the 300-Unicode-scalar threshold; comments/replies use 200. Author can turn optional formatting off. CRLF is canonicalized only when freezing the publication; editable/draft raw text is retained.
- Ordinary plain is a user format preference, not a source-only backend mode. Before creating a request, only a supported text-only shape with current matching capability receives the source descriptor. Images, poll/formation components, sync or other existing unsupported source combinations use their existing publication path without stripping any data. The preference may stay in the draft. There is no compatibility-mode UI.
- Explicit Markdown never silently changes format. This first slice is text-only and blocks unsupported images, internal references and incompatible features while preserving draft/attachments. The bounded native parser executes no HTML, URLs or remote images; unsupported syntax stays literal. Inline images are not implemented.
- Existing descriptor-free drafts, media journals and pending commands are never automatically upgraded. A frozen pending or Review request is never rerouted. Exact request ID, author, source descriptor and hash remain bound for retry/cancellation. Source-owner denial never triggers a legacy retry.
- Shared publication contracts contain only the small descriptor/hash/capability path. Large source decoders, versioned read gateway and renderer are feature-only detail/thread/composer dependencies. The feature facade reuses the existing authenticated ApiClient, SessionStore, private-view lifecycle and pending stores; it creates no parallel session/journal owner.

## Read and privacy contract

The six `/v2/community` detail/discussion routes return an explicit server-owned body discriminator beside the unchanged legacy DTO. Legacy classification never guesses Markdown. Reviewed sources require the genuine stored v6 source definition and current binding in the same transaction as the existing canonical read, including viewSpace access. Unknown/missing stored versions fail closed. The separate Home v7 envelope is not composed in this candidate.

Native decoders require exact source identity/hash/text/ancestry and exact preview reply coverage. A denied or malformed mandatory source clears the page. Only malformed optional formatting in that same authorized response falls back to its verified source. Source rendering accepts complete safe UTF-16 slices and keeps exact original text available. On the four accepted detail reference surfaces, reviewed plain source containing a valid existing native reference deliberately presents the complete canonical original text through the existing current-capability reference component, rather than splitting formatted spans. Explicit Markdown never activates reference parsing. Source-only preview replies and off-page located roots retain explicit current-row/generation-bound thread controls outside the action-free renderer. Descriptor-free legacy DTOs use explicitly guarded legacy branches. Existing author privacy, Media, root visibility, identity, session and cancellation guards remain. Account change/root hide clears source, plan and derived preview state and rejects late responses.

## Current verification and admission

Runtime-identical deployable-stage-v2 passed 5,334 native tests and 2,638 API tests, complete native strict checks, OpenAPI/build/release-package checks and 126 reported PostgreSQL tests across C/en_US.utf8, including the actual native reading roundtrip suite. The later test/CI-only CLI-stage-v1 passed source and ordinary compiled worker acceptance over real verified TLS. Exact attribution and limits are in [READING_C27_INTEGRATION.md](READING_C27_INTEGRATION.md); these are not physical-device, Docker/password-TLS CI or production acceptance. The original single-Program full API typecheck remains a cloud gate.

Plain/Markdown draft editing is implemented only before intent freezes. No published-source editing, inline Markdown media or full-source Markdown reference AST is implemented. Source/M2 erasure qualification remains excluded and fail closed. Default-disabled review/worker configuration is deliberate, not evidence that the implemented paths are missing.

## Historical native-v2 verification and admission record

At the native-v2 handoff, complete native production/test strict compilation,
321 focused native tests across 28 selected files and scoped lint had passed.
The earlier 141-case native-v1 and 16-case CI-inventory passes, 34 focused API
passes and 814-route policy inventory remained exact-input historical evidence.
C/en_US native-roundtrip, full build and device gates had not run then; the
current local SQL/build results above supersede that old execution status, not
the remaining device gate.

That successor registered the four inherited source/M2/deletion-current files
and native-roundtrip test with existing Community/Identity CI ownership and
emitted the six routes from runtime schemas. Its M2 schema was still a controlled
draft at that time. Formal 0176 and the production-capable worker/role checks are
later implemented changes. Neither the old record nor today's local passes
qualify source/M2 for erasure or activate a provider/production service.

## Historical native-v2 successor proof and failed-gate provenance

The successor is not type-only. It fixes real TypeScript control-flow/literal narrowing without relaxing runtime decoding, adds only the exact source-contract importer to the existing SHA vendor rewrite allowlist, restores both source thread controls and plain reference actions, and guards descriptor-free legacy render branches. An isolated regression executes the actual build rewrite loop and emitted source leaf with the vetted SHA payload; this is not a full build or package measurement.

The original business/reference proof helpers and every original historical inventory stay byte-identical. A separate fixed 22-existing-path plus 9-added-production-path proof authenticates the complete frozen integration-v2 predecessor manifest, original bytes, exact runtime delta and current bytes. Full parsed-template equality after removing only enumerated source siblings, two source-thread buttons and the exact composer options block proves every original action, binding and ancestor remains unchanged. Two explicit business-history joins preserve the original manifest, helper, evidence and after-to-before hashes. The affected composer, collections, notifications, support, core presentation, Media gallery, reference and notice-proof test callers compose this bounded proof; unknown paths/hashes and corrupted source/evidence are rejected. These projections do not stand in for the independent current-source behavior tests.

The original native-v1 strict failure was reproduced and saved before edits. An initial native-v2 test compile exposed cross-project static API imports and ES2020 test-fixture incompatibilities; parity tests now call the actual API leaves through a validated runtime module boundary. Session 52965 then passed native production types but failed three new test-fixture typings: an optional expression was insufficiently narrowed, a deferred reference result was typed unknown, and an assertion used an unsupported undefined predicate argument. The subsequent test-only corrections use explicit string narrowing, the existing ReferenceDestination type and the correct assertion overload. Session 86887 separately passed both complete native strict gates. The first historical bridge run also failed on missing legacy readingBody; production guards were corrected and the actual unchanged bridge subsequently passed. All failed logs remain in evidence.
