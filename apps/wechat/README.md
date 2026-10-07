# Native WeChat client foundation

This is a greenfield TypeScript/WXML/WXSS Mini Program. It is **not a complete WhaleU app** and does not yet preserve all business features. The sole development-status screen is deliberately labeled incomplete; it must not replace the production app.

## Implemented

- A small native `wx` adapter, typed HTTP transport, cancellation, independent timeouts, and sanitized errors
- An explicit HTTPS API origin with root-relative paths; no baked-in production destination
- Runtime response validation for `/health/live` and `/health/ready`
- The new API's `{ error: { code, message, requestId } }` contract, including distinct authentication, verification and moderation conditions
- An abstract login/refresh gateway, single-flight refresh, at most one explicitly permitted replay, and account/login-epoch guards
- A namespaced, validated, single-record session store. Credentials are never logged or copied into ordinary request bodies; refresh credentials are only available to the injected auth gateway
- Fake-platform tests covering concurrent expiry, cancellation, timeout, late callbacks, account changes, same-account relogin and storage failures

Only `ACCESS_TOKEN_EXPIRED` with HTTP 401 can trigger refresh. An endpoint must explicitly allow auth replay. Network errors never cause automatic replay, which avoids blindly repeating writes with uncertain outcomes. Shared refresh continues for other callers when one caller cancels. Completing an older login attempt cannot replace a newer login, and a provider code received after the login deadline cannot start a new backend exchange.

The backend must determine the principal from authenticated credentials. There is no legacy API adapter, numeric business-envelope mapping, global request monkey-patch, automatic response-header credential adoption, or caller-ID injection.

## Run

From the repository root after `npm ci`:

```sh
npm run typecheck -w @whaleu/wechat
npm test -w @whaleu/wechat
npm run build -w @whaleu/wechat
```

Open `apps/wechat` as a Mini Program project in WeChat DevTools. The development project uses `touristappid`; the compiler output is `dist/`. Configuring an actual app ID, registered request domains and a separately reviewed non-production API destination is still required before provider integration. Do not disable request-domain validation to make a real deployment work.

`App.onLaunch` intentionally performs no real login, provider call or production request. Consumers must explicitly compose `WechatTransport`, `WechatLogin`, `WechatStorage`, `SessionStore`, `AuthService` and `ApiClient` with a new, reviewed `AuthGateway`. No auth route is implied by that interface; none exists in the current backend.

## Important remaining gates

- Implement every old **business feature** in the new modules and native pages, tracked in the root feature-parity plan
- Specify and implement new auth DTOs, provider code exchange, refresh-token rotation/revocation, logout and device/session handling
- Decide storage/restore behavior and user-facing recovery for unavailable device storage; storage removal can fail, and the adapter reports this rather than claiming guaranteed secure erasure
- Add upload/download/WebSocket adapters, pagination/query contracts, idempotency and feature-specific DTO validation when their server contracts are implemented
- Test actual WeChat DevTools compilation, navigation, real-device rendering, accessibility and interrupted flows
- Test provider integrations only with authorized staging credentials and synthetic accounts

Local checks verify TypeScript, generated files and fake-platform behavior. They do not verify native WeChat runtime compatibility, feature parity, real authentication, security of future gateways, deployed request-domain settings or production readiness. This package has no runtime npm dependencies.
