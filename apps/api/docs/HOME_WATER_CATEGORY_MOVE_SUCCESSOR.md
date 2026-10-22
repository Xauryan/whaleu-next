# Home water category move-out successor

## Current status

Migration 0178 supports original Home water placement and its immutable distribution restriction. It does **not** admit category move-out for V7 water posts. The category owner's supported predicate still accepts only named V1/V2 originals, and its policy/event source checks exclude water. Source/reading owners deliberately reject category overlays. A readable category or native decoder change is not a production capability.

The client now understands a future explicit `canChange: true` response for current water, with nonempty legacy targets. With today's `canChange: false`, it displays no enabled move and sends no command. Public post categories and category command targets remain unchanged. First complete the 0178 fresh-PostgreSQL publication loop; implement the successor in a new forward migration afterward, without editing historical migrations or delaying that validation.

## Bounded transition and permission proof

Only permit an already authorized manager to move **from original system water to an existing legacy target**. Preserve the existing named, text-only, regional, native, no-component, no-sync, no-anonymous-DM scope. Anonymous-original management is not implicitly added.

Retain all current checks in `category-reclassification/service.ts`: authenticated current session and account policy, locked parent, current school-admin grant for the original region or super-admin grant, current ordinary visibility, exactly one accepted live transition policy, exact command Review, child/media continuation permission, revision continuity, input/command transaction proofs, and deferred SQL causal checks. Do not invent a grant, install an accepted policy, or fabricate Review evidence merely to enable the UI.

## Forward SQL owner work

1. Keep `post_category_candidate` and command target validation at the existing nine categories. Introduce a distinct bounded source predicate that also accepts water.
2. Extend only event `original_category` and `previous_category` constraints for water sources. Keep `current_category` and command targets legacy-only. Preserve original post/category/space, V7 envelope, Home evidence, decision, and digest unchanged.
3. Add an explicit versioned transition-policy contract for the water source crosswalk (`water: 9`) and water-to-legacy edges. Do not reinterpret existing accepted policy bytes or silently admit a new edge. Keep issuer, region, validity, withdrawal, unique-selection, exact Review, descendant, and media checks.
4. Extend `post_category_supported` only for exact supported named V7 water originals, proving current original Home Review, immutable disposition, canonical definition, and existing ordinary constraints. Do not replace the original category with the desired display category.
5. Reuse exact event/command/head chains and `post_category_live`; reject absent, stale, revoked, ambiguous, mismatched, or forged owner evidence. Review function volatility, lock order, deadlines, and final proof coverage when composing Home and category owners.

## Source, child, and reading composition

The following overlay fences must not simply be removed:

- SQL `home_parent_current`, `home_publication_authority`, and `reading_format_source_current`.
- TypeScript `text-source/publication.ts` (`requireOrdinarySourceParent`).
- TypeScript `reading-formatting/source-owner.ts` (initial and final category proofs).

For the new V7/V8 lane only, replace no-overlay assumptions with current exact category-owner evidence. Retain immutable original Home category/scope/source hashes. New children additionally require the existing supplemental child-current-parent Review and binding against the current event. Existing children require explicit continuation policy and current category-child context. Never substitute category visibility for ordinary access, original Home Review, current Media, owner visibility, account/Safety, or source authority.

The API internal `CategoryCommandReviewEnvelope.previous.category` can now represent water; target and current-head categories remain legacy. Existing category service flow needs no relaxed role/target check. Inspect runtime parent admission, source reconstruction, and child publication callers together before enabling a transition.

Audit reading-worker role contracts and database privileges for any additional exact owner tables/functions. Add only necessary privileges, never bypass the role contract with a security-definer shortcut. Preserve old V1–V6 behavior and denial paths.

## Restriction and surfaces after moving

Home restriction belongs to immutable `home_post_dispositions.evidence`, not the current category. `home_post_disposition_valid`, Home distribution read proofs, and candidate filters must continue using that original evidence after a move. Moving a restricted water post to discussion must not expose it to other viewers or enable related-campus/official distribution. Following retains its independent named-author rule. Hot excludes current water independently; a restricted post moved out remains author-only and still requires all ordinary hot proof.

## Required evidence before enabling

- Fresh PostgreSQL: authorized move and subsequent move; stale revision; wrong/expired/revoked grant, policy, issuer, or Review; ambiguous policy; forged water target; anonymous-original denial; failed final proof rollback; invalid event/head lineage.
- Before/after bytes: original V7/V8 envelope, requested intent, Home evidence, original decision/digest, source hash, and disposition remain identical.
- After move: author/non-author Home and Following; current-water Hot exclusion; moved restricted Hot author-only; disabled official/related distribution; direct/detail and own history remain under existing access rules.
- Existing and new plain/Markdown comments and replies: original Home proof plus exact supplemental category context, current descendant/media policy, and source/reading behavior. Retest races, withdrawals, and final deadlines; no silent legacy fallback.
- Native: server false never enables a move; explicit server targets only; denied reload clears confirmation; water never becomes a client target/publication category; stale/rejected recovery and account-switch behavior remain intact.

Unit/static readiness tests are not PostgreSQL authorization evidence. Report production move-out unavailable until this successor and its owner tests actually pass.
