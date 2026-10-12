# Modular continuous integration

The required check remains **`verify`** in **Verify foundation**. Every push,
pull request and manual run executes the complete suite. There are no changed-path
filters, optional-success branches, or production activation steps.

## Job graph

```text
plan (inventory + CI guards) ───────────────────────┐
native-checks (types + tests + build + artifact) ───┴─> main-integration (10 jobs)
foundation (lint + formatting + statistics + search evaluation + DB guards)
api-checks (types + OpenAPI + tests + build)
semantic-integration (isolated optional pgvector)
                    all six job categories ─────────> verify
```

The five starting jobs are independent. Main PostgreSQL needs only the validated
inventory and successful native build; it no longer waits for API or repository
checks. The final gate uses `always()` and requires every upstream result to be
`success`. A failed, skipped or cancelled dependency cannot produce a green gate.
The separate public code-statistics workflow is unchanged.

All original `npm run check` operations, both scripted workspaces, formatting,
database admission guards and old shard-runner guards remain covered. The
workflow guard rejects changes to the root check/workspace inventory until CI
coverage is updated deliberately. The local `npm run check` command is unchanged.

## Integration ownership

`scripts/ci-integration-modules.json` is the explicit ownership and subshard map.
Each filename belongs to exactly one subshard. Multi-owner and cross-domain tests
are retained, not dropped or run only when a guessed source path changes.

| Module                                      | Main responsibility                                                                            | Jobs | 333-file candidate |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---: | -----------------: |
| Community and media                         | Community components, publication, discovery and media owner contracts                         |    1 |                 53 |
| Ratings discussions and scoped catalogs     | Scoped ratings, discussion media, replies and random reads                                     |    1 |                 36 |
| Ratings targets and effects                 | Target management/deletion, likes, subscriptions and effects                                   |    1 |                 51 |
| Ratings category catalog                    | Categories, category icons, management and cross-owner media proofs                            |    2 |                 32 |
| Shared cross-owner contracts                | Database, authorization, Safety, search/discovery, experience, notifications and school policy |    1 |                 58 |
| Identity profiles and messaging             | Identity, verification, profiles, messaging and private images                                 |    1 |                 32 |
| Campus services                             | Activities, announcements, errands, organizations, majors, courses, windows and dishes         |    2 |                 59 |
| Media binary lifecycle and process recovery | Binary ingress, upload/read, processing, deadlines and process recovery                        |    1 |                 12 |

This CI-only candidate uses the same 333 test files as source commit
`12169c03fd89f9017fd9aee6a82f8ae337dbbfb5`; only twelve complete files move from
`community-media` to `media-runtime`. The executable inventory, rather than this
snapshot table, is authoritative as features are added. Existing assignments do
not change when an unrelated test is added. Category subshards retain their
previous explicit assignments based on observed durations.

The generated matrix has ten standard `ubuntu-24.04` jobs, bounded by
`max-parallel: 8`, with `fail-fast: false`. Each has its own fresh PostgreSQL 18.6
container and still uses `--test-concurrency=1` within that database. The command
and job timeouts remain 7,200 seconds and 150 minutes. Optional pgvector retains
its independent pinned image, namespace probe, admission and cleanup.

### Media runtime split: same-corpus hosted experiment

The original first eight matrix entries stay in place, Campus 2/2 stays ninth,
and the new `media-runtime-1` is appended tenth. The inventory guard pins all ten
IDs in order. It also pins the twelve moved files and the eight `media-*` files
retained by Community; full-glob exact-once admission remains independent.

The new group owns the binary lifecycle and process-recovery tests: foundation,
pipeline, multipart ingress, v2 upload/recovery/deadlines, native upload/read/process,
and batch/discussion process recovery. Its owners are `media` and `community`.
The existing `community-media` ID and both owners remain, with publication,
ancestor proofs, owner deletion/cleanup, discovery and publication-cancellation
budgets. Category reclassification, owner-post visibility and the nickname native
roundtrip also stay there. Media tests belonging to other business owners do not
move. This is an execution boundary, not a change to production ownership.

The [333-file baseline run 38289705690](https://github.com/Xauryan/whaleu-next/actions/runs/38289705690)
on `12169c0` passed all **3,140 main PostgreSQL test verdicts** and took
**27m47s** overall. Community/media's 65-file job took **26m07s** and determined
the PostgreSQL phase. The candidate preserves every application and test-corpus
byte, all 333 filenames, and the full-inventory SHA-256:
`a668ea6307c3e2b252f1c7e6cf6ce0e81ebfd484b7e1a22311bd174787c5a073`
(sorted `test/integration/<name>` paths, newline-joined without a trailing newline).

A **counterfactual model, not a measured candidate speedup**, assigns each
complete file its baseline top-level duration, allocates the original 153.755s
Node residual by file count, and adds the original 46.190s job overhead to each
split job. Other jobs retain their observed durations. This gives approximately
**20m33s** for the remaining 53-file Community job and **6m20s** for the new
12-file runtime job, including duplicated job setup rather than discarding it.
With eight available slots and the preserved matrix order, Campus 2/2 starts at
680s and Media runtime starts at 888s, each 3s after a prior job frees its slot.
The modeled PostgreSQL phase is **21m08s**, and retaining the measured workflow
startup/final-gate time gives **22m48s** overall, about **4m59s** below the baseline.
Modeled aggregate runner time increases by about 46s for the extra job.

Repeating the entire Node residual in both split jobs and using the largest
observed job overhead for the new job instead gives **24m53s** overall. Adding
another 60s to each split job and changing each queued dispatch delay from 3s to
30s gives **26m20s**. These are transparent sensitivity scenarios, not confidence
intervals or bounds on external queueing or runner slowdown. The earlier
327-file `6da8f84` run was modeled separately; its results are not mixed into the
333-file prediction. Matrix order does not guarantee actual start order, and ten
jobs do not run simultaneously under `max-parallel: 8`.

The ten-job candidate has **no hosted measurement yet**. Its exact-commit run
must retain the same corpus and verify all ten consumers, the one native build,
immutable producer artifact/provenance, 21 inventory logs (plan plus two per
consumer), actual start/end times and peak concurrency, every database cleanup,
terminal test counts with no failures/skips/cancellations, and the required gate.
Compare its measured workflow and aggregate runner time against the same-corpus
baseline; runner or queue differences limit causal claims. Do not weaken test
budgets or raise concurrency to manufacture a benefit. Reconsider the split if
same-corpus hosted evidence does not show a material benefit or introduces flakes.

### Historical Campus split and scheduling limits (317/318 files)

The earlier nine-job Campus layout put the other seven PostgreSQL shards first.
Campus operations (activities, announcements, errands, organizations and Major)
was entry eight; courses and dining (canteens, courses, dishes and windows) was
entry nine. At source `fca344bb116ddda9a4bb2950a948125b63de6982`, the 317-file
snapshot had **36 and 18 Campus files**. Both retained the `campus-services`
module and its owners, with explicit filenames rather than runtime wildcard
bucketing or timing-based reshuffling. Those two positions and semantic
assignments remain unchanged in the current ten-job layout. The guard still
checks new Window image coverage and exact-once equality with the full glob.
New Major files belong in the first Campus shard; new course/dining files in the
second. The 333-file candidate has **41 and 18 Campus files**.

The next baseline, `51437e41187ceb5ab1817153b2870ada38679f37`, adds
`major-discussion-delete.test.ts` explicitly to Campus 1/2: **318 total files,
55 Campus files, split 37/18**. Its added runtime is not included in the
317-file timing model below. Splitting leaves this baseline’s corpus digest
unchanged; guards compare against the complete glob rather than freezing
inventory at either snapshot.

Evidence: [317-file run 38232825662](https://github.com/Xauryan/whaleu-next/actions/runs/38232825662)
at that exact source commit took **24m59s**. Campus passed 417/417 and took
**22m07s**; the run failed an unrelated Community/media source-inventory assertion.
It is timing evidence, not a green full-suite baseline. The 93 Campus top-level
cases uniquely map to all 54 files. Their bodies total 1,168.136s; the Node total
is 1,292.334s, leaving 124.198s unassigned process/setup overhead. Job overhead
outside Node is 34.666s. Nested cases are not added again.

Using those measured bodies, allocating the Node residual by file count and
adding one setup/cleanup overhead to each split job gives **17m37s** for Campus
operations and **5m04s** for courses/dining. Assuming the first eight matrix
entries start together, the ninth starts after the fastest other job (13m42s)
and completes around 18m46s. Unchanged Community/media at 19m57s then bounds the
PostgreSQL phase. This models roughly **2m10s saved (9% of total wall time)**,
with roughly 35s extra aggregate runner time for one additional job. It does not
predict a halving of CI time or require raising `max-parallel: 8`.

These are **estimates, not measured split-run improvements**. The failed
Community/media job included diagnostics, scheduler order is not a guaranteed
start order, available slots can vary, and setup overhead is not necessarily
uniform. New tests (including later Major/soft-delete work) need fresh timing.
That historical nine-job candidate required a full successful exact-commit
hosted run to verify its nine consumers, actual start order, cleanup,
total/aggregate runner time and final gate.
Keep native build/smoke once, the same immutable artifact/provenance checks,
serial files and isolated fresh databases; no cache or workflow safety boundary
changes accompany this split.

### Adding or moving tests

1. Add the test filename to exactly one appropriate module/subshard. For a
   cross-owner contract, retain the relevant owners and choose one execution
   location. Do not duplicate the file across modules.
2. Run `node --test scripts/run-integration-module.test.mjs` and
   `node scripts/run-integration-module.mjs --verify`.
3. Review the full manifest and corpus digest. New unassigned files, stale
   entries, duplicates, empty shards and invalid names all fail admission.
4. For a new workspace or changed root check, update the workflow and its
   coverage guard together. Do not remove a check to make the guard pass.

Useful commands:

```sh
node scripts/run-integration-module.mjs --matrix
node scripts/run-integration-module.mjs --module ratings-catalog --shard 1/2 --list
node scripts/run-integration-module.mjs --module ratings-catalog --shard 1/2
```

The last command needs the same disposable-database admission and built native
output as the existing integration suite. A module's complete selected manifest
and global SHA-256 corpus digest are logged before database creation and again
immediately before execution. The generated matrix and selected manifests have
one source of truth. The old filename-hash runner remains available for existing
local workflows and as an independent inventory comparison.

## Cache and artifact boundaries

- `.github/actions/setup-ci` centralizes Node **24.19.0**, npm **11.9.0**, the root
  lockfile, `--ignore-scripts`, and the npm download cache. Every job still runs
  `npm ci`; a cache miss cannot omit installation or tests.
- `setup-node` caches npm's package downloads, not `node_modules`. Its cache key
  uses the lockfile hash and runner platform/architecture. npm package content is
  reusable across Node versions; executable/native build output is not taken
  from that cache. No home-directory archive, `.npmrc`, credentials or database
  state is cached. Existing branch/PR cache isolation is left intact.
- The native build runs once, including all emitted smoke checks. Only its
  output directory and a provenance manifest are staged. An immutable artifact
  ID from that successful job is passed to consumers; no cross-run or
  cross-repository download token is configured.
- Consumers verify the exact checkout SHA and tree, workflow run, producer
  attempt, Node version, OS/architecture, lockfile digest, complete native file
  inventory and every file's size/hash. Hidden files, symlinks and unexpected
  file types are rejected. Tracked source edits are rejected. Failed verification
  stops before database startup; there is no fallback to a stale build cache.
- A failed-job-only retry may reuse the original successful producer's ID and
  attempt within the same exact-SHA run. A full rerun produces a new artifact.
  Retention is one day; if the artifact has expired, rerun all jobs to rebuild it.
  This does not reuse artifacts from another commit, run or PR.
- Actions are pinned to full commit SHAs. CI has read-only repository permissions
  and checkout does not persist credentials. The native artifact is not a deploy
  artifact and is never consumed by a privileged production workflow.

## Why this shape

Measured reference: [W1 CI run 38191472938](https://github.com/Xauryan/whaleu-next/actions/runs/38191472938),
which completed in **43m32s**. Its foundation took **5m44s**, and its four opaque
hash shards took **37m35s, 29m36s, 35m36s and 24m22s**. Each cached npm install took
only **4–5 seconds**, while each repeated native build took **11–12 seconds**.
The dominant costs were PostgreSQL work, uneven assignment and the full-foundation
barrier. Caching installed dependencies would add risk for little gain.

A scheduling model assigned the observed top-level test durations to their source
files: 6,793 seconds of test bodies, excluding about 641 seconds of process/setup
inside the old test steps. It then added a conservative 45 seconds of job setup
per new module job. The original eight-job layout yielded these lower-bound estimates:

| Concurrent main jobs | Modeled PostgreSQL wall time | Modeled aggregate runner time |
| -------------------: | ---------------------------: | ----------------------------: |
|                    4 |                       30m38s |                       119m13s |
|                    6 |                       27m46s |                       119m13s |
|                    8 |                       19m21s |                       119m13s |

These are **projections, not measured speedups**. They omit queueing, the new
native-check dependency duration, unallocated per-file overhead and six newer
Dish/private-image tests absent from the W1 reference. Source growth and runner
variance can change the bottleneck. That initial projection does not establish a measured speedup for the current
ten-job candidate; use the exact-version evidence and limits above. Raising parallelism from four to eight does not multiply test
work, though eight job setups cost more than the previous four.

The repository is public and uses standard runners. GitHub documents free standard
runner usage for public repositories and a default Free-plan concurrency ceiling
of 20 jobs. This run stays below that account-level ceiling even with the
independent checks and statistics workflow; other account workflows may still
consume capacity and cause queueing. No paid larger runner or billing setting is
selected. Artifact retention is deliberately short.

## GitHub references

- [Parallel jobs and dependencies](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs)
- [Matrix strategies, fail-fast and max-parallel](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/control-jobs-with-strategies)
- [Reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [Dependency cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- [setup-node cache behavior](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md)
- [Workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)
- [Pinned upload action](https://github.com/actions/upload-artifact/tree/ea165f8d65b6e75b540449e92b4886f43607fa02)
- [Pinned download action and its inputs](https://github.com/actions/download-artifact/blob/d3f86a106a0bac45b974a628896c90dbdf5c8093/action.yml)
- [Public-repository billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Concurrency and artifact limits](https://docs.github.com/en/actions/reference/limits)

GitHub supports both reusable workflows and composite actions. This repository
uses one module matrix and a local composite setup action: enough reuse for one
CI entry point while keeping job results and the required gate straightforward.
