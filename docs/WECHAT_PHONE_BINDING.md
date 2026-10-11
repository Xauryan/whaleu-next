# WeChat phone authorization, non-production acceptance slice

This is an implemented, **default-disabled** server/native slice with simulated
local acceptance. It is not a production-readiness or real-provider/device claim.
No live provider, real account, phone number or secret was used. The repeatable
[emitted native journey](SIMULATED_NATIVE_E2E.md) now exercises actual login and
phone HTTP routes, the production provider adapters with synthetic transports,
explicit consent/denial, lost-response recovery and account-isolated state.

## Evidence and uncertainty

Official WeChat documentation was inaccessible from this environment on
2026-10-11. The independent TypeScript adapter follows the library author's own
implementation and response fixture, pinned to wechatpy commit
`a695b89891e0473113c946a3a44d948fcf217404`:

- https://github.com/wechatpy/wechatpy/blob/a695b89891e0473113c946a3a44d948fcf217404/wechatpy/client/api/wxa.py#L484-L498
- https://github.com/wechatpy/wechatpy/blob/a695b89891e0473113c946a3a44d948fcf217404/wechatpy/client/base.py
- https://github.com/wechatpy/wechatpy/blob/a695b89891e0473113c946a3a44d948fcf217404/wechatpy/client/__init__.py
- https://github.com/wechatpy/wechatpy/blob/a695b89891e0473113c946a3a44d948fcf217404/tests/fixtures/wxa_business_getuserphonenumber.json

This is first-party evidence for that library's implementation, **not** official
WeChat contract approval. No Python runtime or package was added. The reference
uses a token query parameter and POST JSON `{code}`. The fixture contains
`phone_info.phoneNumber`, `purePhoneNumber`, `countryCode` and a watermark with
`timestamp` and `appid`. Unlike its blank sample app ID, runtime requires the
configured app ID exactly. The adapter requires successful bounded JSON, a
plausible phone value, and a fresh matching-app watermark, then discards all phone
values. Its result contains only app ID and authorization timestamp. It never
uses OpenID as phone proof.

The current app's eligibility, privacy declaration, quotas and pricing remain
unconfirmed. Operator acceptance must confirm them with WeChat before enabling.
The implementation deliberately does not inherit the library's automatic retry:
a phone code is single-use and must not be silently retried on any error.

## Configuration and setup

Use an isolated non-production API and its matching WeChat app:

1. Apply migrations through 0094 using the existing migration workflow.
2. Configure existing `WECHAT_APP_ID`, `WECHAT_APP_SECRET` and
   `AUTH_RATE_LIMIT_KEY` through the normal secret-management path. Do not put
   credentials into this document, client code, logs, fixtures or chat.
3. Set `WECHAT_PHONE_BINDING=enabled`. The default is `disabled` and production
   refuses `enabled`. No provider calls occur when disabled.
4. Set `WECHAT_PHONE_PROOF_TTL_SECONDS` explicitly (60–31536000). This is the
   operator's local proof lifetime, not a WeChat guarantee. There is deliberately
   no default perpetual phone proof.
5. If testing a genuinely new account's covered student/phone absence, separately
   set `NATIVE_VERIFICATION_ENROLLMENT=enabled`. It is not implied by phone binding.
6. Point the native build at this API using its existing configuration; register
   the API request domain and satisfy WeChat privacy/phone-authority prerequisites.
7. Use a single API/token issuer for this acceptance slice. The app token cache is
   process-local with a bounded lifetime and single-flight refresh; distributed
   token coordination is not implemented. Avoid conflicting external token issuers.

Only `https://api.weixin.qq.com/cgi-bin/token` and
`https://api.weixin.qq.com/wxa/business/getuserphonenumber` are provider destinations.
TLS verification remains enabled; redirects are refused; responses are limited to
8 KiB and each fetch to 5 seconds. Credential-bearing URLs, provider errors and
bodies are discarded rather than logged. The token remains in process memory.

## Owner lifecycle and HTTP contract

All routes are authenticated own-account routes with no account selector:

- `POST /v1/me/phone-binding/requests` with `requestId`,
  `consent: "wechat-phone-verification-v1"`, `replacesRequestId: null | UUID`
- `GET /v1/me/phone-binding/requests/:requestId`
- `POST /v1/me/phone-binding/requests/:requestId/authorize` with the explicitly
  authorized phone `code` and the same consent string
- `POST /v1/me/phone-binding/requests/:requestId/close` with `{}`

The response is exactly `{requestId,state}`. State is `reserved`, `processing`,
`unknown`, `verified`, `closed`, `expired` or `not_found`. A verified receipt means
that original request committed; it is not a replacement for current eligibility
queries after expiry/revocation. Existing phone policy and operation-specific
checks still decide access.

Reservation persists before native authorization. At most one reserved/claimed/
unknown request is active per account. New reservations are capped at five per
hour. The claim records original account, app, session audit UUID, base ledger
revision and a 30-second deadline, and commits **before** any provider call. Only
that claimant dispatches. Same-key retries, reloads and parallel calls return the
original state without transmitting another code.

A crash, network ambiguity or local commit failure after provider consumption
leaves `unknown` (an expired claim reads this state), never fabricated verification.
There is no automatic retry or worker that replays a code. The user may query the
original key, then explicitly replace an unknown/expired/closed request and obtain
**new native authorization and a new code**. Replacement closes the original key;
A verified historical receipt is immutable; users can separately prepare a new
authorization (for example after expiry) without rewriting that receipt.
Late completion checks original state, session, app, base revision and deadline
and cannot commit after closure. A still-live claimed request cannot be replaced.

The completion transaction creates protected opaque `phone_proofs`, a
`phone_provider` assertion, immutable snapshot/event, head transition and verified
receipt together. Deferred constraints reject partial publication. Non-phone
assertions/application coverage are preserved. A legacy/unknown account can gain
only phone verification; absent student coverage stays unknown. Existing proof
revocation remains supported. Historical request session UUIDs have no permanent
FK to deletable sessions, preserving Identity's retention owner.

No code, token, raw phone, phone hash or deduplication index is persisted. There
is no phone-based account merge, uniqueness rule, login identifier or contact
sharing feature. The native device saves only original/replacement request UUIDs
in an API-origin/account-scoped key. It never persists a code or verified fact.

## Native flow and acceptance checklist

From verification, open the separate phone-authorization page. Read the purpose,
prepare a request, and actively choose the native `getPhoneNumber` button.
Denial sends no code. Authorization POST has no auth replay; refresh/recovery is
read-only until the user explicitly starts a new authorization. Page hide/logout
cancels the local view, and late old-login callbacks cannot show success. Reopening
queries the same stored request key.

Written coverage: adapter origin/token/code/response constraints; default-disabled
and production guards; native denial/storage failure/original-key recovery/late
session callbacks; PostgreSQL duplicate dispatch, unknown replacement, ownership,
proofless forgery and a real 31-second late-completion/replace race. These tests
use explicit test-only transport/provider substitutions, not real-account proof.

Still required for real-account acceptance: confirm current official contracts,
WeChat app eligibility/privacy/fees, then perform explicitly authorized
sandbox device tests for accept/deny, code expiry, provider errors, process crash,
reload, logout, deadline races and original-request recovery. The simulated journey does not establish those real-provider or device results.
