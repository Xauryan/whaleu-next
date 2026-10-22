# Explicit human review for immutable text sources

This is a source-only human-review deployment procedure, not an automatic WeChat
moderation integration or a claim of completed production acceptance. It requires
the `source_manual` implementation in the deployed API. Normal installation keeps
`COMMUNITY_TEXT_REVIEW=disabled`: migrations and API startup alone do not authorize
source publication. Do not copy development database credentials into production.

## Preconditions and startup

1. Before running the current API binary, apply the complete normal migration
   chain with `npm run db:migrate` and inspect `npm run db:status`, through
   `0181_identity_real_deletion_preparations.sql`. This includes source storage (0175),
   durable formatting (0176), Home admission/publication (0177/0178), registration
   (0179), closed session epochs (0180) and non-destructive preparations (0181),
   as required by [Home activation](../apps/api/docs/HOME_PUBLICATION_ACTIVATION.md)
   and the [registration guard](IDENTITY_REGISTRATION_GUARD.md). Do not stop at
   0175, apply files alone or use draft migrations. `source_manual` selects the
   review issuer, not a schema version. Installation creates no review policy,
   reviewer, campus catalog or publication rights.
2. Independently provision the real existing regional space/operating region and
   accepted publication policy, account/session, phone and affiliation evidence.
   Never replace missing production facts with test fixtures. This operator cannot
   provision regions, grant identities, or administer unrelated policies.
3. Supply database and application configuration through the deployment's secure
   process environment. Production requires `NODE_ENV=production` and
   `PG_SSL_MODE=verify-full` with a valid trusted certificate matching the database
   host. Do not bypass TLS or put credentials in commands, client code or this file.
4. Build the integrated API using `npm run build -w @whaleu/api` and start the built
   API with `npm run start -w @whaleu/api`. These are existing scripts; the review
   CLI below runs TypeScript through the existing `tsx` dependency, so its secured
   operator installation must retain that dependency and source files. A
   production-only dependency install without `tsx` cannot run that CLI.

The complete chain through 0181 is required even when preparation/status remain
disabled. `REAL_ACCOUNT_DELETION_ENTRY=disabled` remains the default; source review
does not opt into preparations. The separate `prepare_only` entry implements only
non-destructive prepare/status, not acceptance, cancellation, epoch advancement
or erasure. See [real deletion preparations](REAL_DELETION_PREPARATIONS.md).

Supply these explicit values to both API and authorized reviewer process. The
angle-bracket values below are placeholders, not usable fixture identities:

```text
NODE_ENV=production
PG_SSL_MODE=verify-full
COMMUNITY_TEXT_REVIEW=source_manual
COMMUNITY_TEXT_REVIEW_SPACE_ID=<existing regional space UUID>
COMMUNITY_TEXT_REVIEW_REGION_ID=<matching operating-region UUID>
COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID=<new authorized policy UUID>
COMMUNITY_TEXT_REVIEW_OPERATOR=manual:<actual hostname>:<actual OS username>
```

Leave `COMMUNITY_TEXT_REVIEW_POLICY_ID`, `COMMUNITY_RELATED_REVIEW_POLICY_ID` and
`COMMUNITY_FEEDBACK_SPACE_ID` unset. Setting them in `source_manual` is a
configuration error, not a way to enable legacy, related or feedback publication.
The existing `local_manual` mode remains non-production-only; its region-policy
commands must not be used as a production bootstrap shortcut.

The CLI derives the reviewer label from `node:os` hostname and username and
requires exact equality with the configured operator **before connecting**. Obtain
that label on the actual authorized reviewer host, not on the API host:

```sh
node --input-type=module -e 'import {hostname,userInfo} from "node:os"; console.log(`manual:${hostname()}:${userInfo().username}`)'
```

The API uses the same configured label to verify the policy issuer. The label is
attribution, not authentication or an independent security boundary. Restrict
operator host/shell and database access; use separately controlled database roles
with reviewed grants. The source-only human-review TLS acceptance used a shared disposable database
role and did not validate a least-privilege reviewer deployment. The separate M2
worker test did verify its own restricted direct LOGIN contract; that result does
not qualify the human reviewer role. A database superuser can alter
evidence outside the application boundary. No HTTP admin endpoint is added.

## Initialize the source policy and review each request

`review:text` does **not** load `.env`; inject the approved environment into the
operator process. Run the following from the repository root. Initialization is
an explicit one-time insert with an approved basis, not an idempotent repair tool.
Keep its resulting policy ID and issuer consistent with the deployed environment.

```sh
npm run review:text -w @whaleu/api -- '{"command":"init-source-policy","basis":"<authorized human source-review policy reference>"}'
npm run review:text -w @whaleu/api -- '{"command":"list"}'
npm run review:text -w @whaleu/api -- '{"command":"show","accountId":"<queued account UUID>","requestId":"<queued request UUID>"}'
```

`list` returns at most 100 oldest live source requests, excluding expired or
cancelled entries. Map its `account_id` and `client_request_id` to the `show`
arguments. `show` requires a private interactive stdout terminal, refuses pipes
and displays private content: do not record, screen-share or send it to CI logs.
Inspect the complete canonical envelope, source text/format/hash, account, scope
and ancestry. Copy that exact displayed digest; never invent an approval based on
a client digest, a matching-looking body or another request's result.

```sh
npm run review:text -w @whaleu/api -- '{"command":"decide","accountId":"<queued account UUID>","requestId":"<queued request UUID>","digest":"<exact displayed 64-character SHA-256>","decision":"allow","basis":"<specific human review basis/reference>"}'
```

Choose `"decision":"reject"` instead when appropriate. There is no default
approval, bulk allow or automatic publication. Decisions preserve reviewer and
actual database-principal attribution and bind the canonical version-6 envelope,
source hash/format and original publication intent/request. The historical storage
policy key `local-text-source-v1` is not a claim of external provider approval.

The client submits its original post/comment/reply intent to the corresponding
`POST /v1/community/reviews/...` route, polls its owner-only request status, and
retries the **same original publish request** after approval. Current authorization,
policy, deadline, ancestry and cancellation checks still apply at consumption.
Do not generate another request ID to recover a lost response or bypass a conflict.

## Capability and reading checks

API `/health/ready` checks database connectivity/version, existing runtime
configuration and the exact complete deployed migration ledger (currently through
0181). It does not attest live catalog integrity or current source policy; see
[application readiness](APPLICATION_READINESS.md). Still inspect migration status
before deployment. With the actual signed-in eligible account, check
`GET /v1/community/text-source-capabilities` with `spaceId`, `category` and
`authorMode=named`. Only a current matching source policy, scope and current
publication eligibility can advertise source operations. Before explicit setup,
expect `availability: "unavailable"` and empty source operations/formats. A
configuration flag alone is insufficient. Native composer choices are not proof
of an accepted review; Markdown must not silently downgrade to legacy plain text.

Source coverage is named, text-only, empty-image, no structured components,
non-trading, no related synchronization, no feedback, open-comment mode and no
anonymous-DM opt-in. Markdown asset references and `#` followed by a digit remain
unsupported. Both plain and Markdown support post, comment and reply creation.
Draft text can be edited before its intent freezes; **published-source editing is
not implemented**. Submitted intent changes require explicit recovery/cancellation,
not in-place modification of the pending review or immutable source revision.

Formatting processing may remain disabled on the fully migrated current deployment.
The installed M2 schema is still required as part of the complete chain, and
fresh eligible source publications may enqueue ordinary pending jobs even with no
running formatter. Disabled processing does not mean absent queue tables or jobs.
The six v2 detail/thread readers retain canonical source independently of optional
formatting: post detail, post comments, comment detail, comment replies, reply detail
and post discussion context. The v1 capability's `formatter: "not_configured"` is a
fixed wire contract, not proof of running worker health. Formatting never grants
reader access or changes the reviewed source. Use M2's separately versioned
capability/operations contract for its schema/configuration observation.

Exact-0175 source production without M2 remains a historical compatibility contract,
not a deployment option for the current API binary. The dedicated
`apps/api/test/integration/text-source-m1-compatibility.test.ts` keeps the historical
producer and current six-reader compatibility coverage separate from the current
full-chain production API/PTY acceptance.

## Expiry, withdrawal and operational limits

```sh
npm run review:text -w @whaleu/api -- '{"command":"expire","limit":32}'
npm run review:text -w @whaleu/api -- '{"command":"withdraw","accountId":"<queued account UUID>","requestId":"<queued request UUID>","digest":"<exact displayed SHA-256>","state":"held","basis":"<hold reference>"}'
```

Use `"state":"revoked"` for explicit revocation. Neither operation rewrites
an applied receipt. Pending review expires after seven days; an allow has a
24-hour consumption window. Expiry closes requests with the original cancellation
fence, subject to existing quotas. Repeat bounded expiry work as permitted;
never delete evidence or bypass quotas. Client cancellation retains its original
operation/intent hash; late decisions cannot resurrect that cancelled key.

For incident admission shutdown, set `COMMUNITY_TEXT_REVIEW=disabled` and unset the
source-policy variable before restarting; do not assume disabling issuance
withdraws existing decisions or already published content. Use explicit authorized
withdrawal and separately defined content/safety procedures where required.
Review evidence retention/redaction, reviewer staffing and private-terminal
handling require an operational policy before processing real sensitive content.

## Acceptance and provider boundary

The separate CI lane uses `npm run test:source-manual:production`, backed by
`scripts/source-manual-tls-sandbox.sh run`, on an owned disposable loopback
PostgreSQL 18.6 container with temporary test-only trust. Do not run that sandbox
against production. Its database tests use `NODE_ENV=production` and verified TLS,
but synthetic account/scope fixtures. Its test invokes real private-TTY CLI
subprocesses for policy initialization, display, decisions, withdrawal and listing.
The earlier source-only PostgreSQL-backed whole-file test passed 1/1 on exact
`reading-c27-production-manual-v3` under C/verified TLS with formal 0175 and no M2.
It exercised the real production-mode API/HTTP and private-TTY operator, including
rejected/stored receipts and no-side-effects checks. Synthetic identities/scopes
and a shared disposable role limit that evidence. This earlier pass is
prior-version evidence, not a current-binary production acceptance or permission
to run the current binary on exact 0175. Current production API/PTY acceptance
fixtures install the complete chain through 0181; this source requirement is not a new
acceptance result.

Separately, exact `reading-c27-deployable-cli-stage-v1` passed 6/6 reported tests
for actual source/ordinary compiled worker entries, direct restricted LOGIN,
queued-source processing, automatic serve shutdown after a completed tick and
privileged-login denial. That fixture used local review to create its genuine
source; it does not replace the production `source_manual` API/PTY test. Both
local TLS acceptances explicitly used loopback trust, not password
authentication. Docker/password CI, the original single-Program full API cloud
typecheck, production reviewer grants/secret custody and real account/device
acceptance remain required. Local full build/OpenAPI checks have passed on the
runtime-identical preceding stage. See [READING_C27_INTEGRATION.md](READING_C27_INTEGRATION.md)
for exact snapshot hashes, current results and remaining boundaries.

No WeChat moderation or model request occurs in `source_manual`. A dormant WeChat
transport assessment adapter is not registered as an issuer, does not persist
approval and is **not** an automatic production integration. Historical SDK
behavior is not current provider-contract or account-qualification acceptance.
Never substitute an adapter result, external callback or fabricated decision for
the explicit authorized human review above.

The 0181 deployment requirement above is a source contract, not evidence that
this new replay stack passed its type, unit, PostgreSQL, CLI, OpenAPI, TLS or cloud
acceptance gates. Earlier recorded results, including 0180 qualification, remain
tied to their original exact commits and schema stacks; this documentation update
neither extends nor invalidates that evidence.
