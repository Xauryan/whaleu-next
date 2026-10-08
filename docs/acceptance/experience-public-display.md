# Public experience display and bounded dispatcher acceptance

Local aggregate verification completed on 2026-10-08 against base
`8f4eee24bff7fb35608b9bb56e50685fad8800d6` plus this increment. Hosted CI for
its resulting commit is reported separately.

## Frozen gates

All 625 source/test/config/asset files remained unchanged across the final gates.
Fingerprint: `50b348fe33b7c058d3b8e0a73d86e56d474e04aa9a173fa044c59759e01eee57`.
The [machine-readable evidence](experience-public-display.json) records the full
manifest, hash convention and verification-log hashes. Documentation is excluded
so acceptance evidence can be written after testing.

- `npm run check`: lint, strict types, 408 API and 770 native tests, builds and
  emitted native smokes passed
- `npm run format:check`: passed
- `npm run test:integration`: 643 tests passed in 363.883 seconds
- Total: 1,821 passed; zero failures or skips
- PostgreSQL 18.6, launch-only maximum 100 connections, zero remaining application
  schemas, and runner shutdown after completion

## Public display

A DB-only leaf projection reads selected title/color and independently known level
in one nonlocking statement inside the caller transaction. Named community authors,
reply targets, formation participants and available public profiles use the same
strict shape. Missing appearance and unknown experience remain independently
unavailable. Owned undated titles and retained colors do not establish a level.
No balance, grant date, private owner identifier or provenance escapes the DTO.
Anonymous and unavailable variants never acquire a display block.

The native shared template covers 17 named sites across eight pages. Strict
contract tests and 72 compiled conditional smoke cases distinguish unavailable,
known-none, color zero, retained high color and independent title/level states.
These are emitted-code/template checks, not physical-device rendering evidence.

Real PostgreSQL/HTTP/native tests verify committed appearance changes, no hidden
writes or history scans, anonymous/guest/inactive behavior, and final privacy
races with actual selected title/color values. Existing mandatory relationship
proofs still protect named disclosure. Cosmetics are ordinary committed statement
snapshots, not authority or a new final-freshness guarantee. Safety block snapshots
remain plain author labels.

## Dispatcher

A cycle now shares one total attempt budget across refreshed owner frontiers,
finishing each selected round before advancing a hot owner again. Already-attempted
units are excluded from rediscovery but remain predecessor blockers. Failure
isolation, durable retry, no overlapping cycles and stop/restart generations remain.
Real PostgreSQL tests cover a 20-unit hot backlog, causal cap/deletion/refund order,
backoff, retry-write failure and competing manual/automatic processing.

This improves bounded backlog progress; it does not claim global starvation-free
fairness or a production throughput SLA. Default processing remains manual and
local automatic processing remains explicit opt-in. The separate
[history capacity benchmark](experience-history-capacity.md) measured the preceding
commit and must not be represented as a benchmark of this new dispatcher.

## Remaining gates

Historical population/baseline reconciliation, received-interaction semantics,
ranking, limited/special title workflows, real providers/devices and production
processing remain incomplete. No production writes, campaign activation, real
account grant or historical data import was performed.

## Hosted verification

Commit `f331a79eada5fc14b07e0f76aa6102c69563d20f` was pushed with a valid
Verified SSH signature. [GitHub CI run 37724565359](https://github.com/Xauryan/whaleu-next/actions/runs/37724565359)
completed successfully: 408 API, 770 native and 643 real PostgreSQL tests, totaling
1,821 with zero failures/skips. Hosted PostgreSQL test duration was 440.730 seconds.
Lint/types/build/emitted smokes and formatting also passed for that exact commit.
