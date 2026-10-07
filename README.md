# WhaleU Next

Greenfield WhaleU rewrite using a TypeScript/NestJS modular monolith, PostgreSQL
18, and native clients. Preserve the original product's business capabilities
while redesigning interfaces and modules. Old API compatibility and parallel old
and new clients are not goals.

## Status: first implementation milestone

This repository currently contains a runnable backend infrastructure foundation
and a native WeChat Mini Program transport/session foundation. It is **not the
completed rewrite** and is **not production-ready**. Business endpoints, complete
client screens, production schema mapping, data migration, and full end-to-end
acceptance remain to be implemented. No production deployment or data changes
are part of this milestone.

See the [feature-parity checklist](docs/FEATURE_PARITY.md) for the required scope.

## Repository

- [`apps/api`](apps/api/README.md): NestJS API, safe errors, health probes,
  validated configuration, PostgreSQL connection pool and transactions
- [`apps/api/migrations`](apps/api/migrations/README.md): forward-only SQL
  migration runner with checksums, transactional bookkeeping, and database locking
- [`apps/wechat`](apps/wechat/README.md): native WeChat client foundation
- [`compose.yaml`](compose.yaml): isolated local PostgreSQL 18.6
- [CI workflow](.github/workflows/ci.yml): standard public Linux runner, local
  disposable PostgreSQL, read-only permissions, no secrets or paid AI calls

## Development

Prerequisites: Node 24.19.0, npm 11.9.0, and Docker Compose for the local database.

```sh
npm ci --ignore-scripts
cp .env.example .env
npm run db:up
npm run db:status
npm run db:migrate
npm run dev
```

The API binds to `127.0.0.1:3000`. PostgreSQL is isolated on `127.0.0.1:55432` with
development-only credentials. Existing application databases are never contacted
by these defaults. No application tables are fabricated by this foundation.

```sh
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
```

Liveness tests the API process. Readiness additionally requires a reachable
PostgreSQL 18.6 or newer 18.x server. A failed readiness check returns HTTP 503.

## Verification

```sh
npm run check
npm run format:check
```

`check` runs lint, strict type checks, unit/HTTP tests, and builds across both
workspaces. Real PostgreSQL integration tests are a separate required CI step:

```sh
TEST_DATABASE_URL=postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/whaleu_test npm run test:integration
```

Use a **new disposable local database named `whaleu_test`**. The integration suite
creates and removes its own fixture schema and migration metadata; it refuses an
existing migration schema or a non-loopback connection. See the API README for
the test coverage and production-readiness limits.

Dependencies are exact-pinned and lockfile-backed. TypeScript 6.0.3 is deliberately
the latest compatible stable release for the current ESLint toolchain, rather
than forcing the unsupported TypeScript 7 peer dependency.

## Publication boundary

This is a fresh repository. It includes no old Git history, production datasets,
private audit material, or credentials. Do not commit `.env`, real client app
credentials, production backups, or secrets. No software license has been chosen
yet; public visibility alone does not grant an open-source license.
