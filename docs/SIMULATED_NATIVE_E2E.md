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
and runs the 45 integration files explicitly listed in
`scripts/run-simulated-native-e2e.sh` serially. The 1,800-second aggregate process
timeout is inside the wrapper so PostgreSQL is stopped normally on exit. This
budget includes deliberate proof-expiry waits; individual test bounds remain in
force. No existing database is adopted. PostgreSQL diagnostic files are retained
at the reported disposable path. Modular CI runs these files within its complete
integration inventory and verifies a shared native build artifact before use.
Running an emitted-native integration file directly requires that build output
first.

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

The controlled runner also includes the [school posting-policy](SCHOOL_POSTING_POLICY.md) journey: an actual native administrator publication and same-key lost-response recovery, a newly logged-in phone-authorized unverified user, exact Review post/comment/reply, then changed-revision conflict/cancellation and disabled-policy terminal rejection. A parallel focused PostgreSQL file covers CAS and cancellation races, provenance/synchronization blockers and grant/policy expiry after deferred work. These use the same original regional ledger and preserve prior journey tests.

The controlled runner also includes the [organization management](ORGANIZATION_MANAGEMENT.md) and [independent Media10](ORGANIZATION_MEDIA.md) owner journeys. Actual emitted Pages/WXML cover applicant drafts, independently reviewed required images, school rejection/resubmission/first approval, target-scoped membership and ownership transfer, two-source directory discovery and original-key response-loss recovery. Synthetic loopback provider boundaries do not establish device/provider or production acceptance.

The controlled runner also includes [Activity publication](ACTIVITY_PUBLICATION.md)
and [independent Media11](ACTIVITY_MEDIA.md). Actual emitted App/Page/WXML and native
transport submit cover/gallery content to the real AppModule and disposable PG,
wait for the explicit simulation queue processor, recover the original publication
key after a lost response, decode immutable public cover/gallery/organizer QR,
and clear hidden/account-switched views. Focused PG cases cover exact review/media
binding, target grants and organization revisions, cancellation/unfinished-draft
closure races, final deferred-wait proofs, bounded known-denial catalog continuation,
and real shared Media quota windows. The processor consumes actual submitted jobs;
no fixture inserts an approved Activity content-review result to bypass that flow.
Default runtime remains closed and no real WeChat/COS/model request is made.

Scoped post pins add `scoped-post-pins.test.ts`,
`scoped-post-pin-proofs.test.ts`, and
`scoped-post-pins-native-roundtrip.test.ts` to the explicit runner. The native
journey drives the emitted App and current community feed/detail WXML through
ordinary AppModule/loopback PostgreSQL. It is synthetic platform/owner-fixture
coverage, not production, historical import, related-campus/aggregate feed, or
physical WeChat acceptance. Detailed boundaries: [scoped pins](SCOPED_POST_PINS.md).

The 2026-10-12 pin acceptance passed its three suites within a 128/128-test serial
shared PostgreSQL batch, plus the 1,886 API / 2,713 native unit full check and
emitted builds. Hidden-slot management uses the same exact unpin recovery engine.
This differential run did not execute every other runner entry again; see the
[executed pin acceptance](SCOPED_POST_PINS.md#executed-local-acceptance-2026-10-12)
for the exact scope and remaining gates.

## W3 Window text discussion

The combined runner now includes `window-discussion.test.ts`,
`window-discussion-concurrency.test.ts` and
`window-discussion-native-roundtrip.test.ts`, preserving existing PM3/W1/W2/C2
and other simulation entries. The emitted native W3 journey crosses real App and
registered Pages/WXML through the production gateway, ordinary AppModule and
disposable PostgreSQL. It exercises named roots, flat addressed replies, reversible
likes, per-transition local notices, fresh notice targets, cold original-key
recovery/cancellation, account/lifecycle/storage interruption, and own-unlike
closure after source/phone/Safety withdrawal.

Creator notices require an absent accepted creator crosswalk and remain explicitly
unavailable. Images and image-only comment/reply publication, live Review/Media
providers, real nonempty import, physical devices and production remain distinct
follow-ons. See [W3 contract](WINDOW_DISCUSSION.md) and the exact final evidence.

### W3 local execution record (2026-10-12)

Against baseline `285d984` plus W3, all 42 files in that baseline runner's manifest
were executed through ordinary AppModule and controlled PostgreSQL 18. The original
1,200-second aggregate ceiling stopped the first invocation after 36 completed
files: 221 tests passed, zero tests failed, and six files were cancelled. This
invocation is recorded as incomplete, not a passed full run. Only the interrupted
student-verification native file and the five remaining files were resumed against
unchanged application/test source; all 43 tests in that continuation passed. The
exact split therefore covers all 42 files and 264 passed tests. Both disposable
servers shut down normally. Completed expensive files were not repeated.

The observed accumulated time includes intentional 30/60/120-second retention and
proof waits rather than a hung test. The aggregate ceiling is now 1,800 seconds;
serial execution, per-file bounds, every prior entry, and timeout placement inside
the controlled-cluster wrapper remain unchanged. This budget increase does not
retroactively turn the first invocation into a pass. Per-file manifests, logs and
source hashes accompany the W3 handoff.

The subsequent composition on `21b3422` preserves all three scoped-pin entries,
so the combined manifest has 45 files. The 42-file split record above remains
historical evidence for the original W3 source, not execution evidence for this
newly composed manifest. Its exact aggregate validation is recorded separately.
