# Local social updates native integration

This slice adds real category-owned local readers to the existing social-notices
Page without changing accepted Inbox, Home or Me layouts, global app/runtime
ownership, or backend production configuration.

## Composition and privacy

- The Page injects `app.identity.api` only when its session store is the exact
  Community session store. Missing API configuration remains unavailable; there
  is no guest fallback or inferred empty history.
- `community-like`, `community-save` and `follower` namespaces remain separate
  from Community replies, rating likes/replies/subscriptions, window and major
  readers. Every source owns its cursor, errors and single-notice acknowledgment.
- Strict category-bound gateways use `/v1/me/social-updates`, `/unread-count`,
  `/:noticeId/target` and `/:noticeId/read`. Every route requires its category;
  reads send exactly `{}` and never account selectors. APIs are decoded again
  by the reader so substituted/fake gateways cannot bypass the private contract.
- Like/save DTOs have no actor or preview. UI labels are actor-neutral. Follow
  names come only from the public actor projection whose profile ID must equal
  the target. Native page data contains no actor/target/credential objects.
- Unavailable rows retain only notice ID, creation/read timestamps and status.
  A successful list with unknown unread coverage can display validated rows but
  remains partial. Null/unknown is never zero, a page length, or a cross-source
  total, and the client does not guess whether the cause is pending work,
  projection budget, safety, or an unavailable dependency.
- Newly integrated sources never acknowledge on list, category entry, or target
  open. Target navigation deliberately omits all notification-read query IDs.
  Only the explicit rendered per-row read control writes a receipt.
- Existing rating reply/like/subscription navigation from this merged Page keeps
  all original notice IDs and adds the exact non-authorizing
  `noticeRead=explicit` mode. The destination still performs owner-target,
  ancestry, content and position validation, but does not acknowledge after
  loading. The switch requires exactly one valid notice ID and has no role or
  access meaning. Window/major target proof and focus routes are unchanged;
  these destinations already have no automatic read call. Independent legacy
  rating notice pages keep their existing load-triggered read behavior and need
  a separate consistency pass. This slice is not global viewport/dwell acceptance.
- Strict validation covers exact fields, category/kind, UUIDs, valid UTC calendar
  timestamps through six fractional digits, nullable count/status pairs, bounded
  cursors, save post-only targets, reply ancestry, immutable duplicate receipt
  timestamps, matching target resolution and matching read IDs.

## Lifecycle and continuation

The reader is account, session-ID, login-epoch and request-generation owned.
Same-session token rotation preserves current safe display and ongoing requests.
Backend cursors are additionally token-bound: a later continuation rejected with
`DISCOVERY_RESTART_REQUIRED` clears old page/cursor state and requires a fresh
reload. No old cursor is carried into another login.

Page/app hide, account replacement, same-account re-login, logout, safety changes,
Cancel and disposal synchronously cancel requests and scrub rows, names, counts,
and cursors. Late list, append, target and read completions cannot repopulate or
navigate. No notice snapshots or credentials are written to storage. Uncertain
single-read results remain unknown and allow explicit identical-ID retry; only a
validated original read timestamp settles the row.

## Verification boundary

Source-only fictional fixtures are in `test/social-updates-helpers.ts`. Targeted
contract, gateway, controller and actual source Page/F7-control tests cover new
sources and existing social aggregation regressions. The reusable bridge is
`test/social-updates-emitted-harness.mjs`; it defaults to actual emitted `.js`
Page/component entrypoints and accepts a supplied real HTTP transport. Its
explicit `.ts` mode is only source-level synthetic testing, not emitted evidence.
It resolves the artifact path and uses component lifecycle `hide`/`detach`.

Current local checks: the targeted social and rating suites, scoped ESLint and
Prettier are recorded separately by the source owner. The
bridge's hide/show/detach lifecycle was also exercised against the already
existing emitted artifact, with zero network calls and no fabricated response.
That check is not acceptance of newly emitted feature code. New-artifact builds,
full source compilation, real PostgreSQL/HTTP/emitted journeys, visual inspection
and device/provider acceptance belong to the centrally coordinated validation
window; they were not run by this source owner. No generated dist, dependencies,
build scripts, backend files, provider settings or production deployment changed.
