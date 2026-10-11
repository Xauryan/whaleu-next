# Repeatable simulated native user journey

This is a simulated end-to-end acceptance test for the bounded named-text journey.
It executes the actual emitted `App`, native Page entrypoints and rendered WXML
handlers, production WechatTransport, strict HTTP gateways, normal AppModule owner
services, every accepted migration, and disposable PostgreSQL 18.6. It does not
replace controllers, authorization services, review decisions, persistence or
receipts with canned successes.

## Run

Install the pinned Node/npm dependencies with `npm ci --ignore-scripts`. Provide
already installed PostgreSQL 18.6 binaries; no real credentials, WeChat AppID or
registered domain is needed. From the repository root:

```sh
NODE_ENV=test WHALEU_TEST_MAINTENANCE=controlled \
WHALEU_TEST_PG_BIN=/absolute/path/to/postgres18/bin \
npm run test:simulated:e2e
```

The command rebuilds the native bundle and runs its emitted smoke checks, creates
an isolated loopback cluster through the existing controlled-maintenance wrapper,
and runs only `community-text-review-native-roundtrip.test.ts`. The 300-second
process timeout is inside the wrapper so PostgreSQL is stopped normally on exit.
No existing database is adopted. PostgreSQL diagnostic files are retained at the
reported disposable path. The ordinary full CI already builds the native bundle
before running this same integration test. Running the integration file directly
requires that build output first.

## What is simulated

- WeChat `login`, `getPhoneNumber`, local storage and request callbacks. HTTP calls
  are forwarded only to the disposable loopback API. The real WechatTransport
  still handles timeout/cancellation and stale callbacks.
- The identity and phone adapters' external HTTP transport, with synthetic
  endpoint-constrained provider replies. The production adapters still validate
  those replies; neither is replaced with a fabricated successful identity/proof.
- A synthetic campus/region/space catalog, a test-process-only enabled native
  deployment configuration, and an operator's explicit decisions on exact named
  synthetic text. These are fixtures, never real configuration or student grants.

All user accounts start through the real login HTTP route. Phone absence enrollment,
reservation, claim, completion, proof and receipt use their real owners. The phone
code is sent only after the emitted `getPhoneNumber` event and never stored in
native persistence or view patches. No real WeChat/model/COS transport is enabled.

## Acceptance checkpoints

1. Fresh login and current session; native verification shows phone and student
   facts separately unverified. Browsing-campus selection grants no student fact.
2. Explicit phone reservation, denial with no request, acceptance with deliberately
   lost response, and original-key read-only recovery. One provider exchange only.
   Phone verification alone cannot enable a missing regional publication policy.
3. Explicit operator preview/apply for one existing region. The foreign region
   remains blocked. Named post review loses its queue response, recovers its
   frozen original intent, receives exact operator approval, and waits for an
   explicit publish click. A lost publication response recovers one real receipt.
4. Named root comment and reply each undergo their own exact review and explicit
   original-key publication. The post, detail, thread and keyword search Pages
   render the created records, including the search hit types and IDs.
5. Cancellation with a lost server response retains the local barrier, then
   recovers the durable cancellation fence and preserves the draft. Cancellation
   is not represented as a publication receipt.
6. An old owner's held review response arrives after logout and another login.
   Private text/search results remain cleared. The other account cannot adopt the
   pending key. Returning to the original account recovers that exact key and can
   explicitly cancel it without duplicating publication.

The test uses seven named checkpoints under one parent test. Independent focused
unit cases protect comment hints for missing phone, unknown affiliation/policy,
disabled comments, safety restriction, unavailable advisory, disabled review,
restricted posts and the anonymous-author boundary. Write-time authorization,
proof/currentness checks, hash identity, receipts and limits remain unchanged.

## Local differential result, 2026-10-11

The final focused run passed all 9 Node test cases (the seven-checkpoint journey
plus its parent, and the existing exact-review integration case), with zero skips.
The journey performed 93 loopback HTTP calls, three real login exchanges, one
explicit phone-provider exchange, three created publications and two independent
cancellation fences. PostgreSQL 18.6 passed fresh controlled admission and stopped
normally. Related focused unit tests passed 30/30, including ten negative/positive
comment-hint cases. API/native type checks, changed-file lint/format and the native
build with emitted smoke passed. This is differential local evidence; the entire
project suite was not rerun on this patch.

## Remaining boundaries

This is not WeChat DevTools rendering or physical-device acceptance. The bounded
repository WXML model does not simulate all native rendering/layout, privacy
prompts, domain registration, real WeChat eligibility/quotas, token coordination,
real provider faults, media upload/COS, or OS/process death. Semantic search and
other Next feature families are outside this journey. Full project parity and
production readiness are not implied. Long wall-clock expiry and operational
availability under default autovacuum remain separately required acceptance.

The same controlled runner also executes the public feedback roundtrip in a fresh
sequential fixture: anonymous native exact-key recovery, public contacts/school
projection, real synthetic Media9 and local super-admin notices. See
[feedback boundaries](PUBLIC_FEEDBACK.md); real providers remain disabled.
