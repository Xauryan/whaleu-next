# Recoverable account moderation

Safety owns independent `interaction_mute` and `access_suspension` histories.
Identity account lifecycle is unchanged. Mute permits browsing and personal
self-service, including sign-in, rewards, profile/avatar/title edits, settings
and verification; its overlay denies interaction and content-management actions.
Suspension retains the active session and a restricted shell for own status,
local notices, private appeals and original-key command recovery/cancellation.
Independent eligibility and grant checks continue to apply.

Issuance is an optional version-2 compound administrator deletion of another
account's actual post, root comment or reply. There is no arbitrary account
issuance endpoint. Each kind has an independent revision lineage. Exact expiry
or release of suspension exposes any still-effective mute. A finite replacement
starts from its own admission time; permanent-to-finite changes require explicit
release first. Global super administrators can release an exact current reference.

Private appeals bind one immutable punishment reference. The authenticated owner
can submit, recover and read it while suspended. Current global super
administrators process the durable private queue, either upholding, releasing
that exact punishment, or closing an already ineffective case. The owner receives
a private local result notice. There is no proactive new-case administrator
notification and no claim that submission was read. See [private appeals](ACCOUNT_APPEALS.md).

## Enforcement and retained evidence

The explicit route inventory is `apps/api/src/safety/account-policy/routes.ts`.
Server-owned semantic classification is shared with direct service entry points.
Read entry checks are repeated within the owning transaction. Fresh mutations
check eligibility after original-key recovery; cancellations remain session-only.
Missing current schema fails closed. Historical test fixtures use an explicitly
injected, checksummed-prefix-only adapter and rebuild the normal app after upgrade.

Migration 0135 adds immutable causal histories, trigger-owned issuance/release,
private cases/results, strict notice identities, source evidence and independent
fixed-width read epochs. A guarded authoritative role epoch preserves negative
protection evidence through zero-row writes and grant ABA. Migration 0136 forwards
existing policy consumers and adds transaction-bound raw-command evidence.
Historical migrations and completed receipt bytes are not rewritten.

## Verification status

This document describes the implementation contract, not an acceptance result.
Combined type/build, PostgreSQL adversarial and emitted native journey validation
must be recorded against the exact final source before accepting the candidate.
