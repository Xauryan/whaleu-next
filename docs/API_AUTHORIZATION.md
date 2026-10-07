# Authorization and private identity views

This is a new-target implementation milestone, **not a production-ready privilege
or student-verification system**. Migration `0005_authorization_identity_privacy.sql`
creates empty grant and audit tables. No existing user, first login, deployment
account or environment flag is assigned a role. Only synthetic test accounts
receive fixture grants in a disposable local PostgreSQL database.

## Role hierarchy and authority boundaries

Effective hierarchy: `developer > super_admin > school_admin > member`.
`member` is implicit and has no grant row.

| Role         | Management authority                         | Private author identity         |
| ------------ | -------------------------------------------- | ------------------------------- |
| member       | None                                         | Denied                          |
| school_admin | One explicitly granted operating-region UUID | Denied                          |
| super_admin  | Global management                            | Denied                          |
| developer    | Global management                            | Allowed through the audited API |

A school-administrator grant is permanently bound to its operating region. Its
scope cannot be edited in place. Revoke it and obtain a separately approved grant
for a different region. One unrevoked grant per account/role is enforced; even an
expired grant must be revoked before replacement. Grant facts, expiry and approval
provenance are immutable, and revoked grants cannot be restored or deleted.

Institution codes (five-digit strings such as `10001` and `10006`), physical-campus
UUIDs, selected browsing campus, verified identity region and operating-region
administrative scope are different concepts. No selection, nickname, student
number or institution match can grant a role. The grant FK points only to
`whaleu_campus.operating_regions.id`. An inactive region does not confer active
school-administrator capabilities.

`AuthorizationService.requireRegionManagement` is a reusable server-side guard,
not an implemented administration UI or completed management business workflow.
Community publishing still needs its independent authoritative verification,
moderation and visibility policy adapters. Administrative rank does not synthesize
student/phone verification, approved content or media ownership.

## Current endpoints

Every endpoint authenticates an active, unexpired session against the server.
Responses are `Cache-Control: no-store` and vary by `Authorization`.

### GET /v1/me/authorization

Bearer authorization is required. Example response shape:

```json
{
  "role": "developer",
  "management": { "global": true, "operatingRegionIds": [] },
  "identityView": { "allowed": true, "maxBatchSize": 20 }
}
```

This is advisory UI state, not a capability token. Every privileged identity
request checks the live grants again. No roles are accepted in a token, header,
request body, profile preferences or client-side flag.

### POST /v1/identity-privacy/content-identities

For automatic, bounded visible-page enrichment by the developer frontend:

```json
{
  "targets": [
    { "kind": "post", "id": "11111111-1111-4111-8111-111111111111" },
    { "kind": "comment", "id": "22222222-2222-4222-8222-222222222222" }
  ]
}
```

The array must contain 1–20 distinct `(kind,id)` pairs. Unknown fields, owner IDs,
role overrides, region overrides and duplicate IDs are rejected. The service
resolves the owner through the internal `CommunityContentIdentityService`, never
through an account ID supplied by the frontend. A valid developer grant permits
global identity viewing but does not bypass ordinary content visibility: hidden,
deleted, blocked, unavailable-scope and missing content return the same unavailable
item. A comment also requires its parent post to remain readable.

```json
{
  "items": [
    {
      "target": {
        "kind": "post",
        "id": "11111111-1111-4111-8111-111111111111"
      },
      "status": "available",
      "authorMode": "anonymous",
      "identity": {
        "accountId": "33333333-3333-4333-8333-333333333333",
        "nickname": "SyntheticWhale",
        "avatar": null,
        "studentNumber": "00004721",
        "studentNumberStatus": "verified"
      }
    },
    {
      "target": {
        "kind": "comment",
        "id": "22222222-2222-4222-8222-222222222222"
      },
      "status": "unavailable"
    }
  ]
}
```

These values are fictional contract examples. `accountId` is the new application's
private account UUID, not an imported legacy UID or student number. Nickname is
the current stored account profile nickname and can be null. It is not a legal
name. `avatar` is currently always null because authoritative account-avatar/media
integration is not implemented; an anonymous persona avatar is never substituted.
No legal name, phone number, identity-card value, authentication identifier or
provider credential is included.

Named authors use the same separate endpoint for their student number. Normal
post/comment responses, including those requested by a developer, retain the
ordinary privacy-safe DTO and do not gain private identity properties.

## Authoritative student identity gate

`STUDENT_IDENTITY_SOURCE` is a transaction-bound interface. Its normal runtime
implementation is now the narrow local canonical verification facade described in
[verification V1](API_VERIFICATION.md). Empty or unreconciled real accounts remain
`unavailable`, with a null student number. No real provider or production import
has been activated.

The adapter reads only the resolved account's provenance-qualified assertions and
holds its current-head lock through the disclosure transaction. Explicit
unverified/revoked/expired records expose no number, even if historical text
exists. Unknown provenance, missing coverage and conflicting records remain
unavailable. Verified student numbers remain strings, preserving leading zeroes;
malformed adapter values fail closed. Locked validity bounds are checked against
one final database clock after audit/constraint waits, with no row rereads after
that clock. Elapsed authority rolls back the batch and its provisional disclosure
audit before any identity is returned.

Legacy verification status alone is insufficient evidence of a student number:
manual image approval can verify school affiliation without a number; legacy SSO
uses `student_id`; institutional login uses `xuehao`, but email verification also
writes an email address into `xuehao`. A future migration must preserve and verify
the source method/provenance before treating either field as a student number.
An email address in an overloaded legacy field must never be relabeled as a
student number, and an image-only approval must keep the number absent.

Never derive a student number from an account UUID, imported UID, nickname,
selected campus or user-entered post field. Do not populate a verification source
with demonstration accounts or infer verification from missing data. Do not call
remote providers inside the identity transaction. The source-verification
application flow and production/import reconciliation are still unimplemented.
Fixture source overrides live only in tests.

## Audit and revocation behavior

Each authenticated batch attempt records metadata for each target: batch/request
UUID, actor/session, grant ID where applicable, content kind/ID, outcome and names
of disclosed fields. The audit omits the target account ID, nickname, student
number, post text, URL and credential values. Actor/request metadata is itself
restricted operational data and must not be exposed to ordinary clients.

The access operation locks the current session/account/token, role grants,
content, scope and source identity rows. It rechecks session and grant expiry
before recording successful disclosure. Concurrent revocation is serialized by
these locks; a revocation that wins before the authoritative read denies access.
A previously completed response cannot be recalled from a device, so the frontend
must keep private overlays short-lived and clear them on authorization failure.

The complete batch is returned only after the audit transaction commits. Audit
INSERT failure, missing inserted rows or COMMIT failure returns no identities.
There is no partial success response before commit. Role denials and source
unavailability are thrown after their attempt metadata is committed. Audit rows
are append-only at the schema level.

Relevant safe errors:

- `AUTHORIZATION_REQUIRED` (403): required current role is absent
- `AUTHORIZATION_UNAVAILABLE` (503): authority cannot be established
- `IDENTITY_VIEW_UNAVAILABLE` (503): trusted identity/content source unavailable
- `IDENTITY_AUDIT_UNAVAILABLE` (503): required audit insert did not succeed
- Existing session errors retain their 401/403 semantics
- Unexpected transaction/commit failures use the existing safe generic 500 response

## Frontend integration requirements

Query server capabilities and automatically enrich only currently displayed
posts/comments in batches of at most 20. This endpoint needs no user-provided
reason or extra manual reveal click. Store results in a separate transient private
overlay, never by mutating public DTOs. Do not persist identities in drafts,
storage, shared caches, telemetry, console logs, export/share payloads or ordinary
profile data.

Discard stale responses after navigation, target changes or session/account
changes. Clear existing overlays synchronously on logout and any permission/read
failure. Recheck server capabilities with each refresh. A short display lifetime
and subsequent capability refresh reduce stale displays after revocation; only
the server's fresh request-time decision authorizes retrieval.

## Remaining production gates

1. Obtain explicit owner approval identifying the exact initial developer account.
   This implementation supplies no public/self-service role-assignment or
   unauthenticated bootstrap route. Do not treat deployment access as approval.
2. Implement the reviewed administrative grant/approval control plane, separate
   DB runtime/migration privileges and authorized grant issuance/revocation audits.
   Existing table triggers are integrity defenses, not protection from a database
   owner capable of changing schema or grants.
3. Connect and verify the real student-identity source and any actual avatar/media
   source. Reconcile current accounts with authoritative legacy identity records
   before any production disclosure.
4. Complete the independent community verification, visibility, moderation and
   media adapters. Default runtime gates remain unavailable where data is absent.
5. Define restricted audit access, retention, operational alerts and abuse/rate
   controls before launch. No production data, real grants, provider calls,
   credentials, publishing or deployment was performed for this module.

## Verification

- `npm run typecheck -w @whaleu/api`
- `npm test -w @whaleu/api` includes authorization and private-identity unit tests
- Disposable PostgreSQL 18.6 integration suite:
  `TEST_DATABASE_URL=... npm run test:integration`

The integration fixture verifies empty grants after first login, role hierarchy,
fixed region scope, current expiry/revocation, strict batches, private overlays,
unchanged anonymous public projection, hidden/deleted/blocked content, unavailable
and unverified numbers, metadata-only audits, immutable grant/audit constraints,
lock races, and failure of audit INSERT and deferred transaction COMMIT. Its
synthetic role grants never run in the normal application or a production database.
