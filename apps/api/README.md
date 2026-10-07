# API foundation

This is the first runnable NestJS modular-monolith foundation, not a completed
WhaleU rewrite. Infrastructure and the first identity/session vertical slice are
implemented. Content, messaging, marketplace, moderation, payment and most account
business features are still pending. Full feature parity remains required.
See [identity and auth contract](../../docs/API_AUTH.md) for the exact scope.

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
