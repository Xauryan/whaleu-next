# Native WeChat community C1, identity, campus, own-profile and verification-summary slices

This is a greenfield TypeScript/WXML/WXSS Mini Program. It is **not a complete WhaleU app** and must not replace production. Login and session management now have native pages and a concrete new-API gateway. Campus search/selection and own nickname, bio and eleven explicit preferences have native forms. Community C1 now has native regional/global feed, detail/root comments, text composer, desired-state likes, own deletion and durable publication recovery. It remains a partial slice: production authorization, phone/student verification applications and binding, moderation, binary media upload and all retained later business features are unfinished. Ordinary runtime gates fail closed.

## Community C1 and recovery

- `WhaleuApp.community` is the typed root facade. Native pages and small controllers reuse the existing session/API transport, cancellation and login-epoch ownership. There is no legacy wire adapter, fake post feed or synthetic verification switch in runtime code
- Feed navigation resolves the selected physical campus through the explicit community-space endpoint before requesting posts. Missing or inactive mapping stays unavailable. Switching to a global space is explicit; an institution code is never a region/space/identity grant
- Public visitors choose a campus from the real catalog and see the first-ten preview; signed-in phone-unverified users receive a distinct continuation blocker. Invalid supplied credentials cannot turn into a guest request. Every page/load-more result is scoped to account, login epoch, space/category and request generation
- Detail clears previous body/media/comments before refreshing and only exposes comments after a current parent visibility decision. A missing, hidden or deleted parent clears dependent content. Anonymous tagged decoders reject extra real identity fields, and anonymous comments cannot use a named parent's `isPostAuthor` flag to disclose the hidden relationship
- Post and root-comment composers show the effective identity. Defaults express intent only: a disallowed anonymous selection never becomes named silently. Own anonymous-post comments are forced anonymous; independent comment capabilities avoid incorrectly applying post-publishing policy. Identity-default conflicts require an explicit choice
- Editable drafts and frozen pending attempts use distinct API-origin/account-scoped storage keys. A UUIDv4 and exact CRLF-normalized text, operation, target, author mode, ordered completed asset IDs and comment policy are persisted and read back **before** dispatch. One account can have only one unresolved publication across posts/comments. UUID generation uses the native random-byte API with a deadline and fails closed if unavailable
- Timeout, cancellation, close/hide, 5xx, malformed response, auth failure and account switch preserve the frozen original intent. The page disables edits/replacement and offers receipt lookup or identical-request retry. `REQUEST_NOT_FOUND` never unlocks the form. Only a validated account-owned terminal receipt settles it; a stored created receipt remains recovery after content deletion
- Account changes clear private page/form state synchronously but retain the original account's pending recovery record. Same-account re-login can explicitly recover it. Successful publication clears its editable draft before releasing the pending protection. Local storage failures prevent first dispatch or retain the recovery barrier
- Likes use desired-state PUT/DELETE with one operation per target; duplicate taps do not toggle twice. Own deletion has a separate confirmation step and only changes body/count state after a known 204, or clears pending display and requires reconciliation after uncertainty
- Image publishing is **PARTIAL**. DTOs and recovery retain bounded asset IDs, and existing approved media views have strict HTTPS decoders. There is no binary chooser/upload/progress/preview/approval workflow yet, no image URL entry and no pretend successful upload. The UI says the feature is unavailable
- Own-publication recovery lists contain only IDs, scope, category, status and time. They never return hidden/deleted bodies or media

Community contracts live in `../../docs/API_COMMUNITY.md`. Later discovery/distribution, polls, trading, groups, replies, subscriptions, notifications/rewards, moderation/admin workflows and all other master-plan features remain retained scope. Synthetic fixtures are confined to tests and do not establish real provider or device acceptance.

### Developer-only identity overlay

The foreground feed/detail pages automatically request fresh server authorization for visible content. Only a server-confirmed developer can request the separately audited identity endpoint; school/super administrators do not gain this privilege through hierarchy inference. The overlay is a separate in-memory view, never merged into ordinary post/comment DTOs, drafts, storage, logs or sharing state. It displays authoritative UID/nickname and a verified student number only when supplied; unavailable student verification and real avatars remain explicitly unavailable.

Every target change and request begins by clearing the old overlay. Permission denial, incomplete/failed batches, logout, login-epoch/account replacement, page hide/unload and the root app-hide boundary cancel and clear it. Late callbacks cannot repopulate a new view. A 30-second display TTL clears sensitive values until the user refreshes content and authorization is checked again. This is bounded client retention, not a claim of instant remote revocation notification. Role grants are never seeded or user-selectable.

## Own-account verification summary (read-only)

- `WhaleuApp.verification` has a real authenticated `GET /v1/me/verification` gateway and a dedicated native Chinese page, linked from profile/status. Returning to the page always starts a fresh read. Startup never calls a provider or requests verification
- The exact response contains only four nested status records: `affiliation`, `studentNumber`, `phone` and `application`. Facts independently support `verified`, `unverified`, `unavailable`, `expired` and `revoked`; applications support `none`, `pending`, `rejected` and `unavailable`. Unknown fields/statuses, private values and non-200 success responses are rejected
- Unknown/unavailable is visibly distinct from unverified. Verified affiliation with no verified student number is valid and expected; missing or overloaded historical number fields are preserved for later reconciliation, never interpreted as failed affiliation or a reason to force re-verification. Improving student-number coverage and any future institutional sign-in integration are deferred, with no backfill or provider activation in this slice. Phone ownership stays independent. Pending or rejected applications never imply verification. Browsing campus, public UID and administrative role do not supply verification facts or permissions
- The page receives no student number, phone value, legal name, institution guess, evidence, provenance or arbitrary account selector. Neither raw summaries nor rendered status are persisted, logged, placed in share state or added to ordinary community DTOs. The developer-only overlay remains on its existing separately authorized/audited endpoint
- Every query clears the previous snapshot before dispatch. Login-epoch/account replacement, logout, page hide/unload, root app-hide and cancellation synchronously clear the display, abort work and reject late results. Background reload is suppressed until the page is reopened. Repeated taps cannot duplicate an active query; one expired-access refresh is allowed for this read only, and a delayed old-token failure cannot erase a newer credential
- All permission/error/absence paths keep verification unconfirmed. Status snapshots are not operation permissions: actual capabilities are checked by the server at use time
- This is **only a read-only status slice**. Student application, evidence upload, reviewer UI, reapplication and native phone authorization/binding are visibly pending, with no pretend submission or success buttons. No real provider is enabled by this page

The ledger API contract is documented in `../../docs/API_VERIFICATION.md`. Synthetic decoder, gateway, controller and compiled-page smoke tests cover independent states, affiliation-only approval, revoked/expired records, cancellation, auth refresh, account switching, app/page hide, late callbacks and no persistence. Actual WeChat DevTools/device layout and real provider acceptance remain unverified.

## Campus and own-profile forms

- Native campus catalog search, optional district filter, pagination, active/inactive states, honest empty state, explicit selection confirmation and save. Public institution identifiers are canonical five-digit business-code strings, or `null` when unresolved; private institution UUIDs are never fallback business codes. Physical-campus, operating-region and community-space IDs stay separate UUIDs. The selected campus is only browsing context; it never represents student verification, identity-campus authority or administrator scope
- Own nickname and biography editing with source-grounded bounds and eleven boolean preference controls, including mutually exclusive comment defaults. Values are always read from the new backend; no generated personal data or seeded campus list is bundled
- Separate saves for profile and preferences preserve the other section's unsaved edits. Every mutation uses the shared expected revision and validates the returned account and revision. A conflict never blindly overwrites newer data; an uncertain save requires an authoritative reload
- Reads may refresh an expired session once. Mutations never automatically replay. Expired mutations require an explicit safe read before editing again; revoked/blocked sessions clear private forms. A delayed old-token rejection cannot clear a newer refreshed credential
- Session subscriptions synchronously clear old-account data and drafts on login-epoch changes. Same-tick cancellation prevents dispatch, late responses cannot repopulate a replaced account, and hidden/unloaded pages abort their work and discard drafts
- Strict endpoint-specific DTO/status validation, explicit percent-encoded query parameters, exact preference booleans, response identity/revision checks and sanitized Chinese errors. Public catalog requests carry no bearer token
- Chinese loading/error/retry/cancel/save/conflict views and navigation from verified login to campus/profile. Reload visibly warns when drafts will be discarded. Canceling a dispatched save does not claim server rollback

Contracts and remaining business scope are documented in `../../docs/API_PROFILE.md`. Relevant endpoints are `GET /v1/campuses`, `GET/PATCH /v1/me/profile`, `PATCH /v1/me/preferences`, and `PUT /v1/me/campus`.

Preferences here store intent only. C1 post/comment identity controls apply current server capabilities; notification delivery/consent, broader identity-default behavior, anonymous DMs and public-profile privacy enforcement remain pending. Theme/comment-banner settings, avatars/media, verification applications and binding, roles and all other old business features remain in the full parity plan.

## Identity foundation

- Native WeChat login, session verification and logout UI, composed from a small `wx` adapter and typed application controller
- A concrete `HttpAuthGateway` with explicit HTTPS origin, endpoint-specific status/DTO validation, cancellation, independent deadlines and sanitized errors
- Direct new-API identity contracts:
  - `POST /v1/auth/wechat/login` with `{ code }` → credentials, HTTP 200
  - `POST /v1/auth/refresh` with `{ refreshToken }` → rotated credentials, HTTP 200
  - `GET /v1/auth/session` with bearer access → session metadata, HTTP 200
  - `POST /v1/auth/logout` with bearer access → no body, HTTP 204
- Credential DTO: `{ accountId, sessionId, accessToken, refreshToken, expiresAt, refreshExpiresAt }`; session metadata contains those fields except tokens. IDs are UUIDv4, timestamps are integer epoch milliseconds, access expires no later than refresh. Tokens are purpose-separated `wu_a_` / `wu_r_` plus 43 base64url characters
- A validated, single-record session store scoped to the reviewed API origin. Restore uses the same concrete identity decoder; credentials from another environment or an old unscoped key are never imported
- Single-flight refresh, one explicitly allowed replay for read-only session checks, and account/login-epoch/session guards
- Visible unconfigured/provider-unavailable, rejected/expired/revoked login, blocked account, timeout, cancellation, storage and uncertain-logout states
- Synthetic adapter and controller tests for interrupted login, repeated taps, page disposal, restored-session checks, concurrent refresh, account changes, malformed responses and native timeout/cancellation callbacks

No tokens, provider codes, provider IDs or invented profile data enter page `setData`. Native platform and server diagnostic text are not displayed or logged. Only whitelisted error codes and a validated correlation ID are retained.

Only `ACCESS_TOKEN_EXPIRED` with HTTP 401 can trigger refresh. Ordinary network errors never retry a mutation. Refresh tokens are one-use: **any failed or uncertain refresh clears the current local login and requires fresh login**. A lost response is never treated as permission to reuse that refresh token. Shared refresh continues for other callers if one cancels its wait.

Logout clears memory synchronously before server revocation, and same-tick logout prevents pending login/refresh dispatch. Server revocation uses the captured old access credential and cannot clear a newer local login. If server revocation is unconfirmed, the UI says so. Storage removal can fail; the UI warns that persisted credentials may remain and may require clearing the Mini Program cache. This is not a claim of encrypted storage or guaranteed erasure.

## Run and configure

From the repository root after `npm ci`:

```sh
npm run typecheck -w @whaleu/wechat
npm test -w @whaleu/wechat
npm run build -w @whaleu/wechat
```

Open `apps/wechat` as a Mini Program project in WeChat DevTools; generated output is `dist/`. The existing development project keeps `touristappid` and domain validation enabled.

`src/config.ts` deliberately ships with an empty API origin and provider login disabled. Enabling the client requires separately reviewed non-production configuration, the actual authorized development AppID, registered HTTPS request domains, and server-side provider configuration. Never put a provider secret or other credential in the client bundle. Do not disable request-domain validation to make a deployment work.

`App.onLaunch` only creates local adapters and restores validated, origin-scoped storage when configured. It performs no provider call and no network request. Login is explicitly user-triggered. A restored local login stays visually unverified until the user checks the current session. The UI stays on the identity page after login and exposes explicit links to the implemented campus/profile forms. An explicit community entry supports guest catalog/feed reads in a configured build; private detail/profile/composition/recovery still require a current login. No request starts merely from `App.onLaunch`.

## Remaining gates

- Implement every old **business feature** in the new modules and native pages, tracked in the root feature-parity plan
- Implement remaining privacy authorization, phone/student verification applications and binding, remaining personal/public-profile features, device/session management and the remaining identity/business contracts
- Add upload/download/WebSocket adapters, remaining feature pagination/query contracts, idempotency and feature-specific DTO validation alongside corresponding backend features
- Validate WeChat DevTools compilation, native layout, accessibility, back-navigation and interrupted flows on actual devices
- Exercise provider integrations only with authorized staging credentials and synthetic accounts

Local checks verify TypeScript, build output and synthetic adapter/controller behavior, including every registered community/campus/profile/verification handler, navigation destination, configuration gating, root app-hide identity and verification-status clearing and hide/show recreation. Tests cover invalid fields, empty/inactive catalogs, query encoding, pagination, distinct section drafts, mutual defaults, duplicate actions, stale reads/saves, account switches, conflict barriers and uncertain-save reconciliation. They do not verify actual WeChat runtime rendering, real authentication, deployed domain settings, full feature parity or production readiness. No real provider, production destination or paid API is used by tests. This package has no runtime npm dependencies.
