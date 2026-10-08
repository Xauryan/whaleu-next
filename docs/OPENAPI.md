# Static OpenAPI contracts

The first slice documents only the existing view epoch/report POST operations in
[view-reporting.json](openapi/view-reporting.json), using official
@nestjs/swagger 12.0.2 and the actual controller/owner Zod schemas. It is not a
complete application contract. No Swagger UI, documentation route or provider is
registered in the production application.

From the repository root:

- `npm run openapi:generate` explicitly regenerates the committed artifact
- `npm run openapi:check` fails on missing or stale bytes without rewriting them
- `npm run check` includes the drift check, so hosted CI checks the same contract

Generation uses a dedicated TypeScript build with real decorator metadata in
ignored `apps/api/.openapi-build`, outside production dist. Raw tsx does not emit
required parameter metadata and is rejected rather than silently omitting request
bodies. Do not manually manufacture reflection metadata to bypass that check.

The isolated Nest graph registers only the real controller with fail-fast
service/guard substitutes, never AppModule or production bootstrap. The tooling
compiler also emits its transitive imports. It does not initialize or
listen, access the database, load provider configuration, start timers or execute
business work. Deterministic object sorting and fixed metadata make repeated
output byte-identical. Tooling dependencies are not used by a production docs
route because no such route exists.

Requests retain the existing strict runtime SchemaValidationPipe. Owner success
schemas validate constructed and replayed responses inside the existing database
transaction, before commit. Safe error types preserve the separate title-
maintenance successor envelope; ordinary errors do not gain optional private
fields. Native exact decoders and receipt matching remain authoritative at their
boundary.

OpenAPI expresses object keys, UUID patterns, kind/cardinality unions and response
bounds. Date arithmetic, current visibility, account ownership, fingerprint
matching, quota timing, final transaction proof and ambiguous expired-result
semantics remain runtime rules and prose. Exporting a schema is not proof of
these business properties or complete OpenAPI specification validation.

## Dependency and installation boundary

Swagger brings transitive UI assets despite no UI route being mounted. The pinned
UI dependency also includes Scarf's install-time telemetry package. Installation
and CI use `--ignore-scripts`; root `scarfSettings.enabled=false` additionally opts
out through its documented setting. Do not run lifecycle scripts merely to build
these static contracts. The UI assets add approximately 12 MB installed size.

The eight added packages use MIT, Apache-2.0 and Python-2.0 licenses. Exact versions
and integrity values are in the lockfile. An npm audit on the frozen
dependency graph reported zero known vulnerabilities; this is not a guarantee of
absence of defects. See [acceptance evidence](acceptance/view-openapi.md).

## Directory extension

The separate [organization-directory artifact](openapi/organization-directory.json)
now covers the member directory context/category/list/detail read slice. Both
artifacts are generated from actual controller and owner schemas, with deterministic
key sorting followed by the installed Prettier formatter. Neither artifact is
excluded from formatting. Offline export still creates no database, timer or
public documentation route.
