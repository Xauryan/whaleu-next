# Native WeChat identity, campus and own-profile slice

This is a greenfield TypeScript/WXML/WXSS Mini Program. It is **not a complete WhaleU app** and must not replace production. Login and session management now have native pages and a concrete new-API gateway. Campus search/selection and own nickname, bio and eleven explicit preferences have native forms. Other business pages, privacy authorization, phone/student verification, media and public-profile features remain unimplemented.

## Campus and own-profile forms

- Native campus catalog search, optional district filter, pagination, active/inactive states, honest empty state, explicit selection confirmation and save. The selected campus is only browsing context; it never represents student verification, identity-campus authority or administrator scope
- Own nickname and biography editing with source-grounded bounds and eleven boolean preference controls, including mutually exclusive comment defaults. Values are always read from the new backend; no generated personal data or seeded campus list is bundled
- Separate saves for profile and preferences preserve the other section's unsaved edits. Every mutation uses the shared expected revision and validates the returned account and revision. A conflict never blindly overwrites newer data; an uncertain save requires an authoritative reload
- Reads may refresh an expired session once. Mutations never automatically replay. Expired mutations require an explicit safe read before editing again; revoked/blocked sessions clear private forms. A delayed old-token rejection cannot clear a newer refreshed credential
- Session subscriptions synchronously clear old-account data and drafts on login-epoch changes. Same-tick cancellation prevents dispatch, late responses cannot repopulate a replaced account, and hidden/unloaded pages abort their work and discard drafts
- Strict endpoint-specific DTO/status validation, explicit percent-encoded query parameters, exact preference booleans, response identity/revision checks and sanitized Chinese errors. Public catalog requests carry no bearer token
- Chinese loading/error/retry/cancel/save/conflict views and navigation from verified login to campus/profile. Reload visibly warns when drafts will be discarded. Canceling a dispatched save does not claim server rollback

Contracts and remaining business scope are documented in `../../docs/API_PROFILE.md`. Relevant endpoints are `GET /v1/campuses`, `GET/PATCH /v1/me/profile`, `PATCH /v1/me/preferences`, and `PUT /v1/me/campus`.

Preferences here store intent only. Notification delivery/consent, downstream anonymous post/comment/DM behavior and public-profile privacy enforcement remain pending. Theme/comment-banner settings, avatars/media, verification, roles and all other old business features remain in the full parity plan.

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

`App.onLaunch` only creates local adapters and restores validated, origin-scoped storage when configured. It performs no provider call and no network request. Login is explicitly user-triggered. A restored local login stays visually unverified until the user checks the current session. The UI stays on the identity page after login and exposes explicit links to the implemented campus/profile forms. It does not pretend an unfinished business homepage exists. Campus/profile reads start only when a configured logged-in user opens those pages.

## Remaining gates

- Implement every old **business feature** in the new modules and native pages, tracked in the root feature-parity plan
- Implement privacy authorization, phone/student verification, remaining personal/public-profile features, device/session management and the remaining identity/business contracts
- Add upload/download/WebSocket adapters, remaining feature pagination/query contracts, idempotency and feature-specific DTO validation alongside corresponding backend features
- Validate WeChat DevTools compilation, native layout, accessibility, back-navigation and interrupted flows on actual devices
- Exercise provider integrations only with authorized staging credentials and synthetic accounts

Local checks verify TypeScript, build output and synthetic adapter/controller behavior, including all registered campus/profile handlers, navigation destinations, configuration gating and hide/show recreation. Tests cover invalid fields, empty/inactive catalogs, query encoding, pagination, distinct section drafts, mutual defaults, duplicate actions, stale reads/saves, account switches, conflict barriers and uncertain-save reconciliation. They do not verify actual WeChat runtime rendering, real authentication, deployed domain settings, full feature parity or production readiness. No real provider, production destination or paid API is used by tests. This package has no runtime npm dependencies.
