# API foundation

This is an incrementally implemented NestJS modular monolith, not a completed
WhaleU rewrite. Identity, campus/profile, community, safety and local processing
slices are tracked in the [feature-parity checklist](../../docs/FEATURE_PARITY.md).
The owner-only [experience contract](../../docs/API_EXPERIENCE.md) covers fresh
reward enrollment, sign-in, history and owned appearance. Production/provider
acceptance and reconciled historical migration remain outstanding.

## Local development

From the repository root, using Node 24.19.0 and npm 11.9.0:

```sh
npm ci --ignore-scripts
cp .env.example .env
npm run db:up
npm run db:status
npm run db:migrate
npm run dev
```

Docker Compose starts an isolated PostgreSQL 18.6 instance on loopback port 55432.
Its fixed sample credentials are for local development only. The named Docker
volume is separate from any old deployment. `npm run db:stop` stops the instance
without deleting its data.

- `GET /health/live`: process liveness; no database dependency
- `GET /health/ready`: returns 200 only when PostgreSQL answers and its server
  version is 18.6 or a later 18.x patch; otherwise returns 503

Future business APIs will use explicit `/v1` routes and validated domain DTOs.
The new project does not reproduce old route aliases or old response formats.

## Safety and runtime contract

- Configuration is validated before boot; invalid values and credentials are not
  printed. Database URL query parameters are rejected to prevent TLS overrides
- Remote database connections require verified TLS. Production cannot disable TLS
- The bind host defaults to loopback. No proxy is trusted and no CORS origins are
  enabled by default; deployment-specific settings need a separate review
- JSON/form bodies are capped at 64 KiB; server headers and request timeouts are
  bounded. Parser errors use safe 400/413/415 responses
- Every response receives a generated `x-request-id`. Client-supplied request IDs
  are not trusted. Health and error responses are marked `no-store`
- Error bodies use `{ "error": { "code", "message", "requestId" } }`. Unknown
  exceptions never return raw messages, stack traces, SQL, or submitted values
- Fixed business conditions remain distinct: `PHONE_VERIFICATION_REQUIRED` (403)
  and `CONTENT_REVIEW_REJECTED` (422). `ACCESS_TOKEN_EXPIRED` (401) is distinct from
  `AUTHENTICATION_REQUIRED` and `SESSION_REVOKED`. These code definitions do not
  implement the corresponding business features
- Structured request logs omit URLs, query strings, bodies, IPs, and headers.
  Known credential fields are redacted. Application logs must use allowlisted
  fields; arbitrary free-text payloads are not safe to log
- PostgreSQL queries must use parameter values. The transaction helper leases
  one client, commits or rolls back, and destroys a connection if rollback fails
- Transactions are not automatically retried. A lost connection during commit
  can leave an uncertain outcome; future business operations need idempotency
- SIGINT/SIGTERM start shutdown and close the pool. Migrations never run on boot

The reusable `SchemaValidationPipe` validates Zod schemas. Use strict object DTOs
and derive the acting user from a verified authenticated principal, never from
request-body user IDs. Authorization, rate limiting for business endpoints,
audit events and production observability remain future work. Identity-only
rate limiting and session rotation/revocation are implemented. Do not expose this foundation as a production WhaleU service.

## Tests and checks

```sh
npm run check
npm run format:check
```

Unit/HTTP tests use the Node test runner, with actual in-process NestJS HTTP
requests and mocked database readiness. Database migration integration tests run
against real PostgreSQL 18.6 in GitHub Actions. To run them locally, provision a
new disposable PostgreSQL database named `whaleu_test` and set:

```sh
TEST_DATABASE_URL=postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/whaleu_test npm run test:integration
```

The suite refuses remote hosts, a different database name, or an existing
`whaleu_meta` or identity schema. Integration files run serially and create/remove
only their own fixture schemas and migration metadata. Identity tests cover real
transaction, locking, expiry and revocation behavior with a synthetic provider. It does not silently skip when configuration is missing.
Never point it at production or an existing business database.

CI uses a standard public Ubuntu runner, a disposable PostgreSQL service,
read-only repository permission, and no secrets or AI service calls. Exact package
versions and the npm lockfile are checked in. TypeScript 6.0.3 is the newest stable
version compatible with the pinned TypeScript ESLint peer range (`<6.1.0`);
TypeScript 7 is intentionally not forced into an unsupported toolchain.

Internal credential-state cleanup is dry-run by default:

```sh
npm run auth:maintain -w @whaleu/api
```

It is never scheduled or enabled automatically. Review the [retention and
operator-safety contract](../../docs/API_AUTH.md#internal-credential-state-maintenance)
before explicit apply; it never deletes accounts or business data.

See [migration contract](migrations/README.md) and the project feature-parity
checklist for the remaining production data-migration and business work.

## Local verification read-through

`GET /v1/me/verification` exposes only the authenticated account's independent
verification states. A local canonical ledger now backs the existing audited
developer student-number read; unmapped accounts stay unavailable. There is no
provider, application/review mutation, number-backfill or production-import flow.
See [verification V1](../../docs/API_VERIFICATION.md) for the exact contract and
preservation/reconciliation gates.

## Community polls development slice

C2A adds poll composition/read projections and immutable account-owned ballots,
including minimal durable receipt/status recovery after parent deletion or
permission loss. Creation and voting remain behind the existing unavailable
runtime safety ports; only injected synthetic test adapters enable local flows.
The independent vote gate requires phone proof and current restrictions, not a
new student/campus credential. See [community API](../../docs/API_COMMUNITY.md)
for exact DTOs, immutable storage, transaction guarantees and remaining parity.

## Community trading development slice

C2C adds named regional listings with source-grounded subtype/contact/location
rules, exact decimal text, independent urgency/resolution, explicit legacy-text
reads, filtered regional/own listings and durable owner status recovery. Chosen
contacts use a separate authenticated visible-parent endpoint and are disclosed
only while the listing is open, even for its owner. Resolution retains stored
contact values; reopening requires a fresh current-policy read. Ordinary runtime
safety gates remain unavailable; no real provider, checkout, payment, production
import or public-profile privacy bypass is added. See [C2C API](../../docs/API_COMMUNITY.md#c2c-trading-listings-development-slice).

## Community post-formation development slice

C2D adds non-trading group-formation composition, creator seating, atomic
phone-qualified joins, persona-safe public rosters and separately permissioned
chosen-contact reads. Durable owner receipts/status survive response loss and
parent deletion without returning contacts or hidden parent content. Normal
runtime safety adapters remain fail-closed; only synthetic fixtures exercise
this development slice. See [C2D API](../../docs/API_COMMUNITY.md#c2d-post-group-formation-development-slice)
for consent, immutable storage, privacy and future import boundaries.

## Community Saved development slice

C2E increment 1 adds account-owned save/unsave, current visible Saved browsing,
aggregate/own state, two independent default-enabled per-post preferences and
minimal durable recovery receipts. Re-save starts a fresh membership epoch while
preserving mute choices. Explicit active-session-only reduction routes support
own cleanup after parent access loss. Ordinary writes require dedicated phone/
action checks without a new publication or student gate. Reward/ranking work is
persisted as pending obligations; save transitions do not invent notifications
or experience grants. The separate local Updates consumer below handles
established root/reply notices. External capability remains unavailable and preferences are not
provider consent. See [C2E API](../../docs/API_COMMUNITY.md#c2e-saved-posts-and-per-post-preferences-increment-1).

## Community local Updates development slice

C2E increment 2 adds persisted community in-app notices, current persona-safe
previews or generic unavailable rows, exact account-owned unread counts and
idempotent exact-notice read state. The native Updates page uses authorized
root/reply locators rather than treating notice IDs as access grants.

Automatic processing is **off by default** (`COMMUNITY_UPDATES_PROCESSING=manual_only`).
A bounded internal command defaults to an empty dry run:

```sh
npm run updates:process -w @whaleu/api
npm run updates:process -w @whaleu/api -- dry-run --event-id=LOCAL_EVENT_UUID
npm run updates:process -w @whaleu/api -- apply --event-id=LOCAL_EVENT_UUID
```

The CLI rejects production/non-loopback targets and has no production escape
flag. There is no public process-events endpoint. An explicitly configured
`automatic` local dispatcher discovers only events from new publications made
under automatic configuration; its durable pending queue survives restart. Old
manual/imported events and terminal unavailable external work are never enrolled
by a mode change. Existing runtime authority/media adapters remain fail-closed.
No provider or device delivery, consent/quota, rewards or ranking is activated.
See [local Updates contract](../../docs/API_UPDATES.md) for configuration,
transaction/retry/visibility semantics, acceptance evidence and retained work.

## S1A named safety controls

Named post/comment/reply blocking, own unblock/list/status, and durable minimal
request recovery are implemented through local owning facades. Directional feed
filtering differs deliberately from bilateral direct post/discussion interaction
checks; anonymous targets never resolve hidden accounts. Phone eligibility is
verification-owned and independent of student number/affiliation. Existing
aggregate visibility, publication, media and role policies remain fail-closed.
Named-profile direction/actions are covered by the public-discovery increment
below. Remaining safety/private-evidence/provider and production reconciliation
work stays separate; see the feature-parity checklist for the current ledger.

See [named-blocking contract](../../docs/API_SAFETY.md) for routes, cleanup gates,
final-clock/lock order, exact receipt semantics and explicitly new bounded rates.

## Own identity-campus selection

Authenticated status/options, explicit version-bound choice and owner-only
exact-once success recovery are documented in
[API_IDENTITY_CAMPUS](../../docs/API_IDENTITY_CAMPUS.md). The new normal-AppModule
flow consumes existing canonical affiliation/phone/safety/topology inputs; it does
not issue verification, infer historical selections or change browsing campus.

## Named public profiles and own liked history

Public author pages now use existing public profile IDs, current active-account
checks, dedicated bilateral safety policy and locked profile-history preferences.
Community supplies contact-free canonical post/trading pages with separately
classified current counts. Own public-reference reads remain nonmutating; untouched
accounts return null. The self-only liked list independently projects post/root/
reply authors and retains undated known-owned memberships without invented dates.

Pages now make bounded forward progress through arbitrary-length history using
private durable opaque cursor coordinates; hidden-only batches return explicit
scan continuation. Exact current-policy counts now use bounded canonical streaming and final owner
mutation proofs independently of pages; unavailable counts remain null and do
not block authorized pages. Count availability under representative concurrent
load, public UID/media/affiliation/received-interaction
owners and full native-device/provider/migration acceptance remain explicit
release/parity gates. See
[public profiles](../../docs/API_PUBLIC_PROFILES.md) and
[own liked history](../../docs/API_LIKED_HISTORY.md).

Named author/profile cosmetics now consume a DB-only, nonlocking experience leaf
with independent title/color/level evidence. This exposes no private balances or
history and preserves anonymous and final safety boundaries. See
[experience projection](../../docs/API_EXPERIENCE.md#public-experience-projection).

## Bounded view-reporting infrastructure

The explicit HTTP entry point registers `@nestjs/schedule` for a startup view
retention sweep and a 60-second interval, including when there is no reporting
traffic. `VIEW_REPORTING_RETENTION_PROCESSING` defaults to `automatic`; `disabled`
and `manual_only` prevent automatic cleanup and keep new HTTP view-reporting
admission closed. Ordinary browsing and live receipt recovery remain available.
`AppModule.register(config)` does not mount this runner; only the HTTP entry point
passes `{ httpRuntime: true }`. Manual maintenance commands additionally disable
retention in their isolated configuration, so inherited automatic settings cannot
start hidden background work in CLI/test application contexts.

The runner prevents overlapping local sweeps, while database locks and bounded
`SKIP LOCKED` cleanup make concurrent processes safe. A failed, lagging, or stale
retention sweep closes new reporting admission. Shutdown waits for active cleanup
in the before-shutdown phase before the database pool closes. Retention removes
expired recovery metadata and cooldowns, never committed aggregate views. Exact
physical deletion during service/database downtime is not guaranteed; deployment
must separately verify backup/WAL retention.

`@nestjs/throttler` supplies the reporting request guard. Its PostgreSQL adapter
uses independently committed account/operation counters, rather than process-local
memory, so failed validation and rolled-back business work still consume attempts.
The initial limits are 20 epoch requests and 120 report requests per account per
60-second fixed window. The first over-limit attempt starts a fixed 60-second
block; rejected retries do not extend it. Responses preserve the existing safe
`RATE_LIMITED` envelope and `Retry-After: 60`. Request counters contain hashed keys
and expiry times, with bounded cleanup in the same retention sweep. They contain
no tokens, IP addresses, post IDs, or request payloads. These safeguards are
separate from transactional view batch/event capacities and do not activate
external providers or authorize a deployment.

## Static API contract export

Run `npm run openapi:generate` or `npm run openapi:check` from the root (equivalent
workspace scripts are available). Official Swagger reads the actual view-reporting
controller and native Zod schema metadata through a separate TypeScript tooling
build. The exporter does not start AppModule, PostgreSQL, jobs or HTTP routes.
Only the two view-reporting operations are covered. See [contract tooling and
installation policy](../../docs/OPENAPI.md).

### Activity member read and visit slice

[Activity API](../../docs/API_ACTIVITIES.md) and
[generated OpenAPI](../../docs/openapi/activities.json) cover authenticated
identity-home list/detail, source-backed entry selection, opaque replay/continuation
and immutable global owner visit receipts. Profile still owns activity reminder
preferences. Migration 0036 is empty canonical storage; no issuer, import,
creation/media/admin/provider, enrollment or badge functionality is implied.

## Independent ratings R1 development slice

[Ratings API](../../docs/API_RATINGS.md) describes trusted bounded catalog reads, independent scores with transactional bucket summaries, named or target-scoped-persona text roots, own deletion and minimal durable recovery. Default AppModule uses canonical owner facades and exact review sidecars. Migrations add empty storage only; accepted catalog content does not establish fresh score coverage. No real source importer, review issuer, media, notifications, experience or target-management flow is enabled.
