# Architecture decisions

Status: initial implementation. Business feature parity is not yet achieved. See FEATURE_PARITY.md.

## Product contract

- Reproduce the full original product's business capabilities, with new internals and native clients.
- Preserve production data through a separately rehearsed and reconciled migration to PostgreSQL 18.
- Do not reproduce unsafe behavior, accidental public helper routes or implementation defects.
- Legacy wire compatibility and simultaneous old/new production operation are out of scope.
- Do not call real external providers or production systems in automated tests.

## Runtime shape

A NestJS/TypeScript modular monolith owns authoritative business rules. PostgreSQL owns durable state and constraints. Introduce Redis only for a defined cache, coordination or job need; durable obligations must have a recoverable database record. Long-running work executes outside request handlers and has explicit timeout, retry and idempotency semantics.

Native clients are independently implemented: TypeScript/WXML/WXSS for WeChat, Swift/SwiftUI for iOS, Kotlin/Compose for Android, and ArkTS/ArkUI for HarmonyOS. Client frameworks do not select server authorization rules. Shared API contracts, test cases and design specifications provide consistency without forcing shared UI code.

## Proposed business modules

These are planned boundaries, not implemented services:

- identity: accounts, authentication, sessions, verification and profiles
- campus: institution selection, affiliation and campus relationships
- community: feeds, publishing, comments, polls and subscriptions
- messaging: conversations, anonymous identities, unread state and blocking
- moderation: reports, review decisions, sanctions and audit records
- errands: order lifecycle, claim concurrency and private contact visibility
- ratings: categories, targets, reviews and scoring
- organizations: groups, membership and activities
- notifications: delivery preferences, outbox and provider adapters
- media: upload authorization, object references and access policies
- academic: institutional integrations and campus tools
- administration: explicitly scoped management use cases

Split or combine boundaries based on demonstrated coupling, not a class-count target. A module exports a small application-facing interface. Other modules must not query its tables or import its repository implementation directly. Cross-domain workflows use explicit application services and transaction ownership; external network calls do not run while holding database row locks.

## Implementation conventions

Controllers parse/validate input and delegate. Application services orchestrate use cases and authorization. Domain rules are testable without HTTP or third-party services. Infrastructure adapters implement persistence and external integrations. Avoid abstract factories or interfaces that have no actual substitution or test purpose.

All mutations have explicit ownership/school permission checks, bounded inputs and a transaction boundary where needed. Database constraints are the final enforcement layer for uniqueness and concurrency. Retries require an idempotency policy; side-effecting requests are never blindly replayed. Provider delivery uses a durable outbox or an equivalently recoverable design.

Use versioned API contracts with semantic error codes, stable identifier serialization, pagination and documented nullability. Treat external input as unknown until runtime validation. Secrets, request bodies, raw authorization headers and credential-bearing URLs are not log payloads.

## Delivery gates

Every feature needs a mapped original business behavior, implementation, positive and negative authorization tests, concurrency/recovery tests where relevant, and a verified native-client flow. Unit test success is not proof of device behavior or migration correctness. Build/test CI runs against isolated fixtures and cannot deploy or touch production automatically.

Database migration work requires authoritative schema-only evidence, reversible mappings, restore rehearsal, reconciliation at a defined watermark and an explicit recovery plan for data written after cutover. A complete source-to-target data mapping must be reviewed before any production operation.

## Community runtime authority increment

The implemented [canonical community policy](COMMUNITY_RUNTIME_POLICY.md) composes
narrow verification, campus, authorization and safety owner facades. A leaf review
module supplies exact-content approval consumption and typed base visibility;
SafetyPolicyModule retains the real named-block wrapper. Phone-only interactions
and feed continuation do not acquire publication affiliation/selection requirements.
Normal AppModule text acceptance uses disposable canonical records with no provider
overrides; production issuers and controls remain intentionally absent.
