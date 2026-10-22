# Home policy publication activation

This is the native TypeScript/PostgreSQL port of the fixed legacy policy at
`WhaleUCampus/WhaleU@4494e36b9451e3a92874ccf85f574a36e28e3d48`.
It is not a visibility permission or a replacement for content Review.

## Deployment boundaries

Install the normal complete checksum/prefix-verified migration chain through
`0182_real_deletion_request_authority.sql`, including Home 0177/0178 and the
closed 0180 epoch foundation, before running this application version. The Home
0177/0178 feature boundaries are not the current application's migration cutoff.
Neither Home migration seeds an admission or an activation. An installation with
no activation head continues the existing publication lane. A configured but expired or invalid activation fails closed;
it never silently falls back to a lane that bypasses the policy.

The full 0182 chain is required even when formatting and preparations are
disabled. `REAL_ACCOUNT_DELETION_ENTRY=disabled` remains the default; explicit
`prepare_only` implements only non-destructive prepare/status, not acceptance,
cancellation, epoch advancement or erasure. It does not activate Home publication.
See [application readiness](../../../docs/APPLICATION_READINESS.md) and
[real deletion preparations](../../../docs/REAL_DELETION_PREPARATIONS.md).

The implemented production reviewer is `source_manual`, with explicit plain or
Markdown source. Set the existing `COMMUNITY_TEXT_REVIEW` configuration and its
source policy, space, region and operator settings through the application's
normal configuration mechanism. The operator must equal the actual CLI process
identity `manual:<hostname>:<username>`. A fabricated generic explicit reviewer,
missing source policy, or simultaneous ordinary-policy configuration is rejected.
Database credentials are supplied through the existing secure configuration,
not arguments or evidence references. Use normal verified TLS in production.
No role grants or trust-store changes are performed by these commands.

## Explicit operator sequence

After building the API, the actual compiled entrypoints are:

- `dist/community/text-review/cli.js`: existing genuine source policy initialization and manual Review commands.
- `dist/community/home-feed-policy/operator.js`: 0177 mapping admission.
- `dist/community/home-feed-policy/activation-operator.js`: 0178 runtime activation.

Run entrypoints from `apps/api` with Node. Each accepts one strict JSON command
argument. `{"command":"preflight"}` is read-only. Do not infer readiness from
schema installation or the presence of a policy alone.

For mapping admission, `prepare` requires an explicit definition, evidence
reference, and bounded validity. The definition specifies verified legacy
category mappings, concrete source/destination spaces and regions, author modes,
and distribution surfaces. Unknown mappings and unsupported institutional audit
exemptions are rejected. `apply` requires the same fields and the exact returned
preparation ID, revision and digest. Follow the exported strict command schema
in `admission-contract.ts`; do not manufacture mappings from UUID order.

For runtime activation, prepare with:

    {"command":"prepare","evidenceRef":"<auditable change reference>","validForHours":24}

Then apply with the returned preparation ID, current revision and preview digest:

    {"command":"apply","preparationId":"<returned UUID>","expectedRevision":0,"previewDigest":"<returned SHA-256>"}

The numeric revision above is illustrative, not a reusable default. Preparations
expire after five minutes. Apply binds the same database actor, operator,
configuration, current mapping, catalog and Review policy. Validity is capped by
the earliest dependency deadline. The atomic activation and head advance consume
the preparation; replay and stale revisions fail. Run preflight again to inspect
`publicationReady`; do not equate `catalogReady` or `canPrepare` with activation.

## Content and distribution

V7 retains the exact original post intent and source while binding the effective
category/destination. V8 binds the actual V7 parent without borrowing its author
identity or actor-origin scope. Review, access, safety, original and effective
publication permissions, receipt and final transaction proofs remain required.
Requests without an explicit source cannot use the source-manual activation:
they fail without publication writes, rather than obtaining fabricated approval.

Short/reference-only content has author-only Home distribution and a server
water category. It is not automatically private content. Direct detail, profile,
search, saved content and references keep their own existing visibility owners.
Following behavior is an explicit new admission choice, not inferred legacy
parity. Hot excludes current water content for all viewers. Official push and
related synchronization suppress restricted content. Historical restrictions
remain bound to the immutable admission used at publication, even after the
current activation expires.

Water is not a new public write target. The initial 0178 slice does not yet
provide category-management move-out; see `HOME_WATER_CATEGORY_MOVE_SUCCESSOR.md`.
Unsupported group/pull-delivery providers are not invented by this port.

## Verification status

The 0177 metadata lane has separate real PostgreSQL and verified-TLS CLI evidence.
The complete 0178 publisher/activation/distribution slice is still a candidate
until its real PostgreSQL, production-configuration CLI, count/visibility and
full integration gates finish. Static tests or this document are not deployment
or production acceptance. Cloud container lifecycle and physical-device checks
remain separate from a local PostgreSQL run.

The current 0182 deployment requirement is a source contract, not evidence that
this new replay stack passed its type, unit, PostgreSQL, CLI, OpenAPI or deployment
gates. Earlier Home and 0180 results remain tied to their original exact inputs;
this documentation update neither extends nor invalidates that evidence.

Current0182 boundary: full deployment includes the request substrate and local
accept/cancel HTTP coordination, but production admission remains explicitly
unavailable. Neither configuration nor a completed migration establishes owner
erasure, reader retirement, lost-secret recovery or completed-at guard writing.
Earlier validation results retain their original exact-source scope; this
documentation does not inherit them as new-stack passes.
