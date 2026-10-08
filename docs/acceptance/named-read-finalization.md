# Named emitted-read finalization acceptance

Final integrated local verification completed on 2026-10-08 UTC against base
`8f22600dc1e75b76fded79dbe1dd4da6b5c72b10` plus the emitted-read, discussion-v3,
native navigation and finite 2,000 ms per-count budget changes. This records a
local acceptance result, not a hosted CI result or production-readiness claim.

## Frozen source and gates

The source/test/asset/config fingerprint was captured before the gates and
recomputed unchanged afterward:

`cf9b84027f6bb8b345559e9f4ac15bc9d80ed736afa53bf4b4561ef40da60fe8`

It covers 563 files. The exact hashing scope/algorithm, log hashes, test-file hash,
commands and final-tree count measurements are recorded in
[named-read-finalization.json](named-read-finalization.json). Documentation is
excluded so evidence and checkpoint history can be written after the verified run.

- `npm run check`: lint, both typechecks, **308 API unit tests**, **702 native unit
  tests**, API/native builds and compiled native smoke all passed
- `npm run format:check`: all matched files passed
- `npm run test:integration`: **583/583**, zero failures/skips, **330.011 seconds**
- Total: **1,593 passing tests**, without weakening required count assertions
- In-run cleanup: PostgreSQL **18.6**, launch-only `max_connections=100`, **zero
  remaining WhaleU schemas**, followed by confirmed database shutdown
- `git diff --check` passed, with no source edits during the final gates

The disposable loopback PostgreSQL runner and prerequisites are the same as the
[exact-count acceptance](exact-discovery-counts.md). No providers, background
business jobs, production database, or production migration were activated.

## Verified coverage

The final aggregate includes the 53-case named-read real-AppModule acceptance
suite: all 21 newly enrolled owner entry points, including the dormant internal
comments read; valid direct SQL block insertion/reactivation after scalar allow;
existing directionality; named nested output under anonymous/self parents; guest
bypass; contacts/private identities; current availability metadata; earlier allow
retained after later denial; mandatory deadline/capacity independence; raw-writer
fence behavior; block/unblock and historical receipt/recovery exclusions.

Identity coverage distinguishes mixed available/unavailable returned batches,
which retain their disclosure proof, from an entirely abandoned candidate payload,
which may commit only denied/unavailable attempt metadata. Final unsafe disclosure
rolls back its audit; earlier mandatory authority deadlines survive abandonment.

Discussion coverage includes exact sort/pin/tie behavior, v2 explicit restart,
relevant v3 cursor invalidation, fresh selected counts/previews, native-gateway
continuation after irrelevant off-page changes, cursor-only fresh Previous/Next,
deep links, cancellation/lifecycle fencing and preserved reply drafts/targets.
The deterministic lazy fixture models 1,024 roots with 1,024 possible replies each,
but renders only 10 selected roots and records 11,265 named facts. It is not a
real million-row database benchmark or end-to-end million-reply native support.

## Count repair and retained boundaries

The preceding `8f22600` hosted run failed the finite 1,500 ms mixed-4,097 count
assertion. This integrated tree includes the independently reviewed 2,000 ms
per-count repair; prior failure evidence remains in the exact-count acceptance.
On this final local tree, quiet 4,097 profile counts were known in **685–731 ms**
and mixed liked counts were known in **1,336–1,346 ms**. These are measured local
observations, not latency guarantees or evidence that hosted CI has passed.

See [named finalization scope](../NAMED_READ_FINALIZATION_GAP.md) for exact owner
semantics and exclusions. In particular, the PostView serializer still limits a
post to 1,024 visible replies, and native root navigation rereads that parent.
Worker materialization, external delivery, universal raw-writer mutation
linearizability, previously returned responses and broader scale/import/provider
release gates remain separate.
