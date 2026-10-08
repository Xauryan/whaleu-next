# README code statistics acceptance

Verified 2026-10-08 for implementation commit `ac57699eb8df8d6a4f15719e11bdaf35f275613c`
and README-only commit `ab2171a76f77bd8fa3f0514a14089275f91b68f9`. Both commits have
verified SSH signatures on GitHub. [Machine-readable evidence](code-statistics.json)
records the scoped file hashes, test results, published snapshots and workflow pins.

## Verified scope and gates

The implementation changes six files: `scripts/code-stats.mjs`,
`scripts/code-stats.test.mjs`, `scripts/code-stats.integration.test.mjs`,
`scripts/code-stats.fixtures.mjs`, `.github/workflows/code-stats.yml` and
`package.json`. The subsequent commit changes only `README.md`.

- Offline `npm run stats:test`: 5 passed, zero failures/skips, without `CLOC_PATH`
- Required `npm run stats:test:integration`: 1 passed, zero failures/skips, using
  checksum-verified cloc 2.10
- Invoking the integration gate without `CLOC_PATH` fails with exit code 1
- Scoped lint and formatting passed; repeated builds of unchanged branch
  snapshots produced byte-identical SVG output
- Root `npm run check` includes the offline gate. The publishing workflow runs
  both gates before building or uploading its artifact

The real-cloc fixture covers immutable committed content despite working-tree,
staged and untracked changes; exclusions; symlink rejection; native WXML/WXSS;
identical files counted separately; hostile branch names; actual default marking;
independent branch counts; empty trees; and removal of deleted origin branches.
A committed branch containing eligible empty and binary files verifies cloc's
literal `{}` response becomes zero files, lines and languages. Malformed reports,
incorrect totals, invalid source SHAs, checksum mismatches, an existing output
directory and a mismatched publisher SHA remain errors.

## Hosted verification

Implementation commit `ac57699eb8df8d6a4f15719e11bdaf35f275613c` passed
[foundation run 37796511212](https://github.com/Xauryan/whaleu-next/actions/runs/37796511212)
([job 113377234022](https://github.com/Xauryan/whaleu-next/actions/runs/37796511212/job/113377234022)):
5 statistics, 641 API, 903 native and 1,116 PostgreSQL tests, 2,665 passed with zero
failures/skips. Lint, typecheck, OpenAPI drift, builds, emitted native smokes and
formatting passed.

[Initial Pages run 37796511133](https://github.com/Xauryan/whaleu-next/actions/runs/37796511133)
and [README Pages run 37799209010](https://github.com/Xauryan/whaleu-next/actions/runs/37799209010)
both succeeded, each with 5 offline tests and 1 required real-cloc integration test.
These publishing-gate counts are separate from the foundation total above.

The README-only commit's
[foundation run 37799209037](https://github.com/Xauryan/whaleu-next/actions/runs/37799209037)
([job 113386601941](https://github.com/Xauryan/whaleu-next/actions/runs/37799209037/job/113386601941))
also succeeded in 12 minutes 44 seconds. Its logs independently confirm 5
statistics, 641 API, 903 native and 1,116 PostgreSQL tests, 2,665 passed with zero
failures/skips. Lint, typecheck, OpenAPI drift, builds, emitted native smokes and
formatting passed. The latest Pages run passed all 6 publishing tests with zero
failures/skips, and the live SVG returned HTTP 200 with the README commit's source
SHA and unchanged counts.

## Published image

The [live statistics SVG](https://xauryan.github.io/whaleu-next/code-stats.svg)
returned HTTP 200 with `image/svg+xml`; XML safety and visual checks passed.
The image was also verified in the live GitHub README.

The verified README publication contains these independent snapshots:

- `main`, the actual default branch, at `f1a8579e15c5a94ca56fd067aee3b36d63994e9c`:
  0 code lines, 0 files and 0 languages
- `rewrite/backend-foundation` at `ab2171a76f77bd8fa3f0514a14089275f91b68f9`:
  202,192 code lines, 909 files and 7 languages

After the README-only commit, SVG bytes changed only for the rewrite branch's
source SHA metadata, from `ac57699eb8df8d6a4f15719e11bdaf35f275613c` to
`ab2171a76f77bd8fa3f0514a14089275f91b68f9`. Counts were unchanged. Shared code across
branches is never combined into a repository-wide total. Identical files within
an individual branch count separately; branches at the same commit may reuse the
calculation while retaining their own displayed sections.

## Counting and publication boundary

[cloc 2.10](https://github.com/AlDanial/cloc/releases/tag/v2.10) is downloaded from
the official release and checked against SHA-256
`bf59272455172108072a0a106379f7509fd4349bdcfd85203bac038ccd286d83` before use.
All workflow actions are pinned to full commit SHAs, recorded in the evidence JSON.

Counts use nonblank, non-comment lines in committed regular files read as
immutable Git blobs from every fetched origin branch tip. Source, tests, scripts,
migrations and configuration are selected under `apps`, `packages`, `scripts`,
`tests`, `test`, `migrations`, `config` and `.github`, plus eligible root files.
The allowlist and exclusions are defined in `scripts/code-stats.mjs`. File and
language totals include only files recognized by cloc.

Dependencies, build/coverage output, documentation including JSON reports,
generated directories/files, OpenAPI schemas, lockfiles, Markdown, source maps
and minified files are excluded. Symlinks, submodules, local edits, staged changes
and untracked files are not counted. Tags and fork branches are outside scope.
WXML and WXSS are recognized natively; empty snapshots display zero explicitly.

Publication is restricted to `main` and `rewrite/backend-foundation` in
`Xauryan/whaleu-next`, with matching `github-pages` environment branch policies.
The build job has only `contents: read`; the deployment job has only `pages: write`
and `id-token: write`. Checkout does not persist credentials. Other branches are
read as Git data, and their files are never executed.

Pushes to a publishing branch or manual runs on either publishing branch refresh
all branch snapshots. Other branches' changes and deletions appear on the next
allowed run, rather than after every branch push. Fetching prunes deleted branches.
The workflow must exist on a publishing branch for its push trigger; manual
dispatch also requires the workflow on the default branch. GitHub image caching
may delay visible refreshes.

Only `code-stats.svg` enters the isolated Pages artifact. Dynamic text is XML
escaped, and validation rejects executable or external SVG resources. No source
snapshots, JSON reports, credentials or generated commits are published by this
workflow. This acceptance covers the public statistics image on GitHub Pages;
application deployment and broader search acceptance remain outside its scope.
