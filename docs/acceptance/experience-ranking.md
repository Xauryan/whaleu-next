# Bounded experience ranking acceptance

Local verification completed on 2026-10-08 against base
`f331a79eada5fc14b07e0f76aa6102c69563d20f` plus this backend-only increment.
Hosted CI for the resulting commit is reported separately.

## Frozen gates

All 635 source/test/config/asset files remained unchanged across the final gates.
Fingerprint: `286e5c5b82536a6958f2d7061c5efb087639573d9b061853acbafedacd6d0e12`.
The [machine-readable evidence](experience-ranking.json) contains the full manifest,
hashing convention and verification-log hashes. Documentation is excluded so
acceptance evidence can be written afterward.

- `npm run check`: lint, strict types, 415 API and 770 native tests, builds and
  emitted native smokes passed
- `npm run format:check`: passed
- `npm run test:integration`: 664 tests passed in 371.394 seconds
- Total: 1,849 passed, zero failures/skips
- PostgreSQL 18.6, launch-only maximum 100 connections, zero application schemas
  remaining and server stopped after the runner completed

## Capability and privacy

The endpoint selects bounded known participants, including known zero, without
inventing historical balances or a complete global population. It captures one
ordered bigint source window and the corresponding level/appearance; it does not
refill mutable keyset pages or expose exact scores, internal identifiers, ordinal
ranks or per-person provenance. Missing profiles remain absent without creation.
Selection explicitly distinguishes a reached limit, captured-source exhaustion and
work/time truncation. No native leaderboard page is claimed.

Real HTTP/PostgreSQL tests cover guest and strict supplied authentication,
revoked/expired/blocked sessions, unknown accounts, missing profiles, bigint ties,
balance settlement after source capture, existing display semantics, blocked and
inactive prefixes, more than 50 results, exactly 256 candidates and the sentinel
case beyond 256. Before/after full table-content snapshots for relevant experience,
profile, community, identity, safety and notification tables show no read writes.

Privacy races cover raw bilateral block insertion/reactivation, accepted proof
preservation after rejected-candidate rollback, released rejected-account locks,
retained accepted-account locks and account status changes before acquisition.
An actual deferred constraint trigger waits on an external holder inside
`SET CONSTRAINTS`; a subsequent incoming block rejects the complete response.
Session expiry across a late wait likewise cannot downgrade to guest output.

Migration 0023 adds only the ordered experience-state index; older migrations are
unchanged. Focused local EXPLAIN at 3,013 synthetic known candidates used that
index to retrieve 257 rows in approximately 0.71 ms. This is bounded development
evidence, not a production-scale or cold-cache benchmark. The focused ranking
suite passed 21 tests; independent ranking/display unit review passed 50 tests.

## Remaining gates

Complete historical population/baseline import, public received-interaction policy,
limited/special-title activation, production processing and provider/device
acceptance remain incomplete. No production writes, campaign activation, real
account grants or historical import occurred.

## Hosted verification

Commit `9e6a049ba626b32638fd59bf202b0d16a0599f35` was pushed with a valid
Verified SSH signature. [GitHub CI run 37726303920](https://github.com/Xauryan/whaleu-next/actions/runs/37726303920)
completed successfully: 415 API, 770 native and 664 real PostgreSQL tests, totaling
1,849 with zero failures/skips. Hosted PostgreSQL test duration was 509.047 seconds.
Lint/types/build/emitted smokes and formatting passed for that exact commit.
