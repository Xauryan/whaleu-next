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

The separate [community-hot contract](openapi/community-hot.json) covers unified
hot discovery. It retains strict optional-auth/query/error metadata without adding
scores, private certificate fields or a documentation route.

The [announcements artifact](openapi/announcements.json) covers public content
reads and authenticated own popup acknowledgement. Public and owner authentication
metadata remain distinct; export does not register live content issuers or jobs.

## Content search extension

The [community-search artifact](openapi/community-search.json) covers the upgraded
existing v1 post/comment/reply search endpoint. It is generated offline from the
actual controller and owner query fields/strict response schemas. Since OpenAPI
exports query parameters individually, the disjoint space/scope selector and
cross-field restrictions remain explicit runtime union rules and operation prose.
The schema shows lightweight hits, original-text segments, exact-time navigation,
effective types and safe errors; it exposes no PostView or private cursor data.

## Activities

`docs/openapi/activities.json` is generated from the required-auth activity
controllers and strict Zod schemas. It covers current member context, list/detail,
opaque first-page replay and continuation, and owner visit receipts. The offline
metadata build and drift checks are part of the existing root commands. See
[Activities](API_ACTIVITIES.md) for selection, replay and deferred parity boundaries.

## Ratings R1

[ratings.json](openapi/ratings.json) covers all twelve current authenticated ratings operations, with separate strict score, text, list, summary and minimal receipt schemas. The offline export uses the actual controller and Zod contracts and does not start PostgreSQL, an issuer, provider or runtime task. Unknown source coverage never appears as a known zero. See [Ratings API](API_RATINGS.md).

## Scoped category management M3C

The ratings OpenAPI source now registers the eight category-management v2
operations and the strict shared request-receipt union. The original 66 v1 and
39 M3B scoped operations remain distinct; M3C adds eight routes. The offline
export graph stubs the new service and must not execute a database, source issuer
or Review provider. The generated ratings artifact and exact schema tests must
be regenerated and checked during M3C acceptance; source registration alone is
not an executed drift check. See the
[M3C API](API_RATINGS_CATEGORY_SCOPED.md) and
[validation status](acceptance/ratings-m3c.md).
