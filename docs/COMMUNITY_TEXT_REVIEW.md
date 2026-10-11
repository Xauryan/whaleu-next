# Non-production, explicit local text review

This slice supplies a real, local manual issuer for exact named Community text.
It does not certify a real WeChat account, bind a phone by itself, approve a
student, or establish production readiness. Existing-region policy can be appended
only through the explicit preview/apply operator commands below. Runtime never
imports test helpers. Tests still need synthetic identity/scope facts; passing
those tests is not real-provider or device acceptance.

## Bounded interface

- `POST /v1/community/reviews/posts`: existing PublishPost body.
- `POST /v1/community/reviews/posts/:id/comments`: existing PublishComment body.
- `POST /v1/community/reviews/comments/:id/replies`: existing PublishReply body.
- `GET /v1/community/reviews/requests/:requestId`: current owner-only review state.
- `POST /v1/community/reviews/requests/:requestId/cancel`: `{operation, intentHash}` identifies the original command to irrevocably fence.

All successful review responses use HTTP 200 and exactly `{requestId, operation,
status}`. Status is `pending`, `approved`, `rejected`, `unavailable`, `settled`, or
`cancelled`. The cancel endpoint instead returns an existing original receipt or
the existing exact cancellation contract `{requestId, operation, outcome:
"cancelled", intentHash}`.
It is not a PublicationReceipt. Missing owner request is `REQUEST_NOT_FOUND`.
No client field can supply an approval, issuer, review digest, effective scope or
envelope. Cancellation uses the existing original publication intent hash solely
to identify a key, never as approval evidence. It can fence a not-yet-received
request, closing recovery after a lost pre-queue response. Existing stored identity
and terminal receipts take precedence.

Only named, empty-image, component-none, non-trading text in the configured single
space/region can be submitted. Comments must be open and anonymous-DM opt-in must
be absent or false. Original phone/affiliation, safety, identity-scope and ancestor
checks all remain. Authorization-eligible capabilities become allowed only when
this configured review workflow has a current explicit policy. Media is unchanged.

Submission preserves the original client request ID and unchanged publication
intent hash. The normal preparation path derives its canonical envelope, stops
before publication, rolls back tentative work, then repeats preparation with fresh
locks/proofs before saving the pending snapshot. The original publication request
has no terminal receipt. Migration 0093 permits this only with an exact immutable
review snapshot; unrelated incomplete publication requests still cannot commit.

On an explicit allow, the issuer writes existing local-explicit-v1 decision,
event and head records plus the exact queue/decision association in one transaction.
A later original publish request repeats all current permissions and ancestor
checks and consumes that exact decision. Identical text under another request ID
cannot borrow the decision. A denial is finalized only through the original
publish path into its normal rejected receipt. Existing applied receipts replay
unchanged, including after withdrawal.

## Controlled local setup

Apply accepted migrations in order to an isolated non-production database. The
migration sequence includes the separately accepted 0088–0092 category-icon delta;
this work does not itself establish that delta's acceptance.

Use server environment variables (do not put database credentials in native code):

```
NODE_ENV=development
COMMUNITY_TEXT_REVIEW=local_manual
COMMUNITY_TEXT_REVIEW_SPACE_ID=<existing regional space UUID>
COMMUNITY_TEXT_REVIEW_REGION_ID=<that existing operating-region UUID>
COMMUNITY_TEXT_REVIEW_POLICY_ID=<fresh UUID for this explicit policy>
COMMUNITY_TEXT_REVIEW_OPERATOR=local:<actual hostname>:<actual OS username>
```

The CLI and API must select the same isolated database and policy. `production`
with local review enabled fails configuration validation. Default is disabled.
The OS label is audit attribution, not a standalone security boundary. Restrict
local shell access and the database execution credentials to the authorized
review operator. This CLI is not an HTTP/admin endpoint. Existing school/admin/
developer roles do not grant access to it. Do not expose it as a generic remote
command service or ship its credentials to a native client. Database superuser
access can alter evidence and is outside this application trust boundary.

The CLI does not load `.env` automatically. Supply approved non-production
configuration through the process environment. Never paste secrets into command
JSON. Initialize one explicit policy with a reviewable basis/reference:

```
npm run review:text -w @whaleu/api -- '{"command":"init-policy","basis":"Local development review policy reference and operator authorization"}'
npm run review:text -w @whaleu/api -- '{"command":"list"}'
npm run review:text -w @whaleu/api -- '{"command":"show","accountId":"<UUID>","requestId":"<UUID>"}'
```

`show` requires a private interactive terminal and displays the exact canonical
content and server digest. It cannot pipe content to an ordinary log. Do not
screen-share, record or publish the terminal. `list` returns bounded metadata
only. Review the full displayed content, identity/scope and ancestry, then explicitly
choose one decision and copy the displayed digest:

```
npm run review:text -w @whaleu/api -- '{"command":"decide","accountId":"<UUID>","requestId":"<UUID>","digest":"<displayed SHA-256>","decision":"allow","basis":"Specific review basis/reference"}'
```

Use `"decision":"reject"` for a rejection. There is no default decision, bulk
approval, automatic approver or external model transmission. Decisions retain
operator identity, actual database principal and basis/reference. They cannot be
overwritten. The user queries review status and explicitly retries the original
publish request; approval never auto-publishes. Native recovery retains the
existing actor-isolated pending draft/key and adds no new body storage.

## Explicit existing-region policy

Fresh native accounts may have proven `unverified` affiliation only when the
separate native enrollment flag is enabled. A verified phone still does not imply
student verification. To enable the original regional named-only exception, use
the same controlled CLI to preview the exact existing configured region and space:

```
npm run review:text -w @whaleu/api -- '{"command":"preview-region","postEnabled":true,"commentEnabled":true,"namedOnly":true,"categories":["discussion"],"validForHours":24,"basis":"Explicit policy authorization/reference for this development region"}'
```

Read the existing region/space IDs and names, current revision and proposed
switches. Only then explicitly apply those exact choices with the returned revision
and digest:

```
npm run review:text -w @whaleu/api -- '{"command":"apply-region","postEnabled":true,"commentEnabled":true,"namedOnly":true,"categories":["discussion"],"validForHours":24,"basis":"Explicit policy authorization/reference for this development region","expectedRevision":0,"previewDigest":"<returned SHA-256>"}'
```

Every field is explicit; there is no whole-site default. Preview is read-only.
Apply locks the original policy writer gate and appends a new immutable regional
revision/head. A stale or mismatched preview fails. The policy expires after the
explicit 1–168-hour duration and records the real OS/database operator and basis.
The policy basis is limited to 160 characters to fit the existing policy-reference
contract; an overlong combined OS/database attribution fails without truncation.
Trading and related synchronization cannot be enabled through this CLI. Named-only
remains the existing unverified exception, not a new student authorization.

For disabling posts use `postEnabled:false` and `categories:[]`; choose the comment
switch explicitly and repeat preview/apply. This does not rewrite existing reviews
or content. No institution, campus, operating region, space, topology, identity
selection, verification assertion or role is created by this configuration command.
If the intended real campus/region catalog does not yet exist, catalog provisioning
is still a separate required operator task; never use test fixtures as configuration.

## Expiry, withdrawal and recovery

An allow has a 24-hour consumption window. Once bound, its durable visibility uses
the existing current-head policy and can be held/revoked. Expiry or unavailable
facts never mint a replacement request or silently reapprove text. `approved` is
advisory and does not bypass current authorization. Scope/content changes are a
conflict against the frozen review snapshot; the app must retain the original
recovery obligation. A new draft requires an explicit new intent under the
existing cancellation/recovery contract. The native cancellation button calls the
owner cancellation endpoint and verifies the original local intent hash against
the durable server fence before releasing the pending barrier. Current publication
eligibility or issuer availability is not required to cancel; an active owner
session is. A network failure retains the frozen request and is recovered with the
same key. Created/rejected receipts win a race with cancellation unchanged.

Review submissions are limited to 32 live pending requests and 128 new reviews per
account per UTC day; these are queue-specific limits, not changes to ordinary
publication admission. Each queue snapshot has an immutable 7-day expiry. CLI
cannot extend it or decide it after expiry, and publication cannot consume it.
Run the bounded expiry command during local operations to close expired requests
with the same irrevocable original-owner cancellation fence:

```
npm run review:text -w @whaleu/api -- '{"command":"expire","limit":32}'
```

Repeat while there are expired pending requests. Existing 128/day cancellation
quota remains authoritative; quota exhaustion must be retried later, never bypassed
by deleting requests. Querying a fenced review returns `cancelled`; native recovery
retrieves and verifies its exact fence. A late approval cannot resurrect that key.
No expiry or rejection is misreported as a created publication. Pending/review
content remains private operator evidence in this slice; content-retention/redaction
policy and tooling are a separate unimplemented operational requirement. No body
or issuer evidence is included in ordinary API status responses or logs.

```
npm run review:text -w @whaleu/api -- '{"command":"withdraw","accountId":"<UUID>","requestId":"<UUID>","digest":"<displayed SHA-256>","state":"held","basis":"Temporary hold reference"}'
npm run review:text -w @whaleu/api -- '{"command":"withdraw","accountId":"<UUID>","requestId":"<UUID>","digest":"<displayed SHA-256>","state":"revoked","basis":"Explicit withdrawal reference"}'
```

A held/expired decision remains unavailable to consume. A revoked decision is
rejected by the existing gate; retrying the original unchanged request obtains
its normal terminal rejection when the request's current eligibility still
permits reaching review. No CLI operation clears a client journal or rewrites an
applied receipt. Existing media cancellation fences remain authoritative.

## Acceptance still required

Local code/contract/transaction acceptance is recorded below; hosted acceptance
is still pending. Independently configure a real
WeChat AppID/API HTTPS origin/secret through approved secure channels, activate the
phone-owner integration and explicit single-region policy, and validate a fresh
real account on a device: explicit phone consent, named post review/allow/retry,
comment/reply, reject, held/revoked, logout/account switch, lost responses and same
key recovery. No real provider, secret, production database or device was used to
implement this code. Missing phone, affiliation provenance, regional policy or
real app configuration must remain unavailable instead of being replaced by test
fixtures or an OpenID-based verification shortcut.

## Code acceptance coverage

The generated `openapi/usable-text-workflow.json` documents all five private
review and four private phone-binding operations; its emitted-controller drift
check performs no database, provider or network work. Focused tests cover the
actual local issuer and same-request publication, an actual native controller and
HTTP gateway roundtrip to AppModule/PostgreSQL, cancelled-response recovery, and
emitted native page buttons/phone authorization events. Provider/platform and
account/scope facts in those tests are synthetic. None establishes device acceptance.

Storage tests exercise both sides of request coupling, immutable snapshots,
32-active and 128-daily limits, and refusal to forge/shorten queue expiry. The
seven-day positive wall-clock expiry case is not accelerated by changing clocks,
weakening guards or backdating evidence; real operational expiry remains an
acceptance boundary. Existing cancellation and transaction-deadline suites cover
the reused fence/deadline machinery. Review evidence retention/redaction remains
an explicit operational requirement before use with sensitive real content.

## Local acceptance, 2026-10-11

The functional tree `44f55bb3fae302603c91b9b60dfd0931efcbdc2c` passed all 2,637 main PostgreSQL cases. Earlier cheap tree `e50d6ac0b4f3d43e138fc483fb54bc64610ee3d9` passed 5 statistics, 20 search, 1,755 API, 2,481 native, 7 Category emitted and 3 text/phone emitted cases. Their only difference was one strengthened native enrollment/phone/review roundtrip fixture, with final API types and focused validation repeated.

Final candidate `527ce00d9c4f0d08c0891af8a6859955b8c00110` adds migration 0095 and eleven associated test/helper files. The original full-run semantic failure was an unavailable final Media NOWAIT proof; the conflicting holder was not identified. Four explicit healthy fixture/read windows now acquire their actual owner locks inside the original transaction; unisolated real conflicting-writer cases still require failure and unchanged state. Product NOWAIT, deadlines, proofs and rollback behavior are unchanged. Intermediate test-observation mistakes and the original failure were retained, not counted as passes.

Final differential validation passed the two affected media files, combined 0093–0095 byte-equivalence parity, random 8/8, semantic 42/42 and migration unit 2/2, plus API types, changed-file lint/format and source hashes. Independent 0095 Category acceptance passed 11 cases including real 32-image and 1,001/2,048 full-pool scenarios. This is explicitly composed local evidence, not a claim that the final candidate reran the complete main suite. Hosted full verification remains required; real provider and device acceptance remains separate.
