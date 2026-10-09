# Ratings R3R: full-pool random selection

This slice adopts a **new, explicit contract**. The exact legacy random SQL is
unknown; this is not a claim that the old random behavior is fully equivalent.

## Native behavior

- Each category card and current-category catalog section links to the separate
  `rating-random` page with **only `categoryId`**. The current catalog region is
  never guessed to be a physical campus.
- Entry is visibly **global only** and performs no draw. The user confirms the
  conditions by pressing the draw button. There is no automatic use of identity,
  browsing preferences or previous selections.
- The explicit physical-campus picker reuses the existing campus search gateway,
  strict campus decoder and paginated `/v1/campuses` read. It does not load a
  profile, update browsing preferences or change identity campus. Selection is
  temporary and is cleared on page hide/reopen.
- A selected physical campus requests its institution's complete canonical
  campus-region scope plus global. The backend checks all required regions and
  fails the whole request closed. A browser preference cannot grant permission.
- Minimum average is optional, numeric 1–5 with at most one decimal. Omitting it
  includes known-zero and unknown summaries. A threshold requires a positive
  score count and compares raw sum/count, not the rounded display average. Any
  eligible unknown summary with a threshold makes the request unavailable.
- Each explicit draw is an independent uniform server choice from the complete
  eligible pool. Repetition is allowed. The client neither samples nor
  shuffles catalog pages and keeps no candidate cache. Zero candidates is a
  successful empty result, distinct from unavailable or unauthorized. A server
  business budget failure is unavailable, never a truncated successful pool.
- Detail navigation uses the **returned `item.regionId`**, whose canonical
  catalog membership the backend validated; it is not inferred from target or
  campus. The existing detail page reauthorizes current content.

## Frozen endpoint and decoder

`GET /v1/ratings/random-target` requires authentication and accepts only
`categoryId`, optional `campusId`, and optional `minimumAverage`. Omitting
`campusId` means global only. No region, identity selector, pagination or limit
is accepted by this client.

The exact response is `{context, candidateCount, item}`. Context contains exactly
`{campusId: UUID|null, categoryId: UUID, minimumAverage: number|null}` and must
match all request coordinates. Candidate count is a safe integer from zero to
`Number.MAX_SAFE_INTEGER` (including 1,001 and 2,048) and is zero
if and only if item is null. A non-null item contains exactly
`{regionId: UUID|null, target: RatingTarget, summary: RatingSummary}`. Existing
target/summary decoders are reused. A global-only request cannot return a
regional item. Threshold replies are checked again against raw sum/count and
cannot return unknown or zero-count summaries. Descendant category targets are
allowed; category-tree membership and complete-pool proof remain server-owned.

## Lifecycle and validation boundary

New reads and filter changes clear old results. Repeated in-flight draw taps
dispatch once. Cancel, newer request, picker close/search changes, category
change, page/root hide, Safety invalidation, scope changes, account switch and
same-account login epoch changes fence old responses and navigation. No body,
summary, pool, selected campus or filters are persisted.

Focused contract/gateway/controller tests cover strict keys, bounds, context
binding, raw-score rounding edges, unknown versus zero, explicit global entry,
physical campus selection without profile writes, fresh repeated draws, returned
region navigation, and cancellation/lifecycle races. Emitted page-handler/WXML
smoke is synthetic and is distinct from backend HTTP/PostgreSQL integration and
unverified WeChat DevTools/physical-device/provider acceptance.
