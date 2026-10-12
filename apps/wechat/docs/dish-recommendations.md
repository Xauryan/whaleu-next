# W2 native dish recommendations

This bounded flow adds an independent dish recommendation page at `pages/window-dishes/window-dishes`. W1 window detail links to it without changing W1's signed integer scoring. Public rating recovery and the W1 catalog provide unconditional, query-less recovery links. That entry restores the original target from the current actor/API-origin journal even after a cold restart with source or phone access lost.

## State and authority

- Public pages contain exact dish names, UTF-8 hexadecimal identities, visible endorsement counts, and only the current account's membership flag/revision. Counts describe visible endorsements, not proven unique people. Pagination is server-revalidated and clears its old snapshot on drift.
- Names retain accepted bytes with no trimming, case folding, normalization, or truncation. Validation counts 1–10 Unicode code points, including ten single-codepoint emoji such as 🍱. Multi-codepoint sequences count each code point. Blank-only names, control characters, and lone surrogates are rejected. WXML disables the native UTF-16-length input limit.
- Exact-name own-membership lookup is independent of public-list access. Known active, known inactive, verified no prior recommendation, and unavailable history are distinct. Existing recorded own state carries historical catalog/window revisions solely for closure.
- Recommend requires a current public source snapshot and known own state, then the server independently rechecks phone, Safety, source/history, exact Review, and membership CAS. Retract uses actor-owned current membership CAS and historical source metadata, without requiring current public eligibility. A retract never grants fresh add authority.
- Each action requires a separate explicit confirmation. Repeated taps cannot produce a replacement key. Withdraw/re-add obtains new immutable membership versions; receipts never become current-state authority.

## Interruption and recovery

The durable journal uses a separate W2 namespace and saves account, origin, request, window, exact operation/name, expected revisions, and submit/cancel phase before dispatch, with readback. It stores no other actor identity or public list snapshot.

Recovery first reads the matching original receipt. Only genuine 404 `REQUEST_NOT_FOUND` permits exact resend or an explicit cancellation preview. Cancellation is itself durably persisted before dispatch. An applied response won by the original request is reported honestly; a cancellation receipt prevents delayed original writes. Restarted cancellation cannot issue the original mutation.

Session replacement, account switching, page/root hide, cancellation, and newer refresh generations fence late callbacks. Stopping a refresh also prevents its delayed list completion from starting a new own-membership read. Source/Review/history/phone/Safety failure clears public read authority while leaving actor-owned closure and receipt recovery reachable.

## Verification boundary

Synthetic unit/gateway/template tests cover strict privacy/identity decoding, exact names, source-independent closure, same-key journals, interruption fencing, storage failure, pagination, and cold recovery entry. The emitted App/Page/WXML acceptance uses production HTTP gateways, a real AppModule and disposable PostgreSQL; only native platform callbacks and independently issued synthetic Review/source/history facts are fixtures. Its large matrix respects the unchanged shared 120/minute rating request budget with a deliberate minute boundary.

No production/provider data, live Review issuer, admin UI, comments, images, rewards, notices, or new public profiles are introduced. W1 scoring remains separate. These checks are not physical-device or WeChat DevTools acceptance.
