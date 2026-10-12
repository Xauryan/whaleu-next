# WhaleU Next

Greenfield WhaleU rewrite using a TypeScript/NestJS modular monolith, PostgreSQL
18, and native clients. Preserve the original product's business capabilities
while redesigning interfaces and modules. Old API compatibility and parallel old
and new clients are not goals.

## Status: incremental business implementation

The backend and native WeChat client now include login/session handling,
physical-campus selection, own profile editing, stored preferences, a partial
community flow, audited developer identity views, canonical school-code mappings
and independent verification-status summaries. Named public profiles, privacy-aware
post/trading discovery and self-only community liked history are also implemented
as bounded development slices. Exact discovery counts use bounded canonical
streaming and final mutation proofs; availability under representative load
remains an open release gate. Tested community increments include
polls, flat discussion threads, trading listings, post-based group formation,
Saved preferences, local Updates, named-content blocking, reports and local
post-jury outcomes with owner-only system notices. Local owner experience, sign-in,
fresh-source rewards and owned title/color selection are described in the
[experience contract](docs/API_EXPERIENCE.md); unproven old balances remain unknown. An [errand lifecycle](docs/API_ERRANDS.md) adds exact reviewed publication,
cross-region acceptance, private participant detail, owned history, replay-safe
commands and local accepted/completed notices. Exact-target/global historical
errand administration adds public-only search and exact-or-unavailable totals,
bounded deletion/feature restrictions, global recorded history/release, local
notices and native same-key recovery. A separately versioned [Errand image publication](docs/ERRAND_IMAGE_PUBLICATION.md)
adds public/private images with persistent participant history and exact Review.
An [E4 group-delivery contract](docs/ERRAND_GROUP_DELIVERY.md) scopes bounded
per-destination synthetic delivery and its current-authority/recovery requirements;
normal runtime stays disabled and candidate acceptance is tracked separately.
Historical administrative byte policy, live providers, delivery activation and
authoritative migration remain open. The remaining business modules and complete
end-to-end onboarding/provider integration are still being implemented. Normal
runtime text access now consumes canonical policy and exact review records;
default-disabled non-production manual text review and existing-region configuration
controls are implemented in the [local text workflow](docs/COMMUNITY_TEXT_REVIEW.md).
Their validation and real-account/device acceptance remain separate release gates.
This is **not the completed rewrite** and is **not production-ready**. Remaining
business modules, real-provider and native-device acceptance, production schema
mapping, and reconciled data migration are still required. No production rollout
or production data changes are part of these development milestones.

A bounded [specialist course-comments slice](docs/COURSE_COMMENTS.md) adds
reviewed author-undisclosed text, permanent likes and original-request recovery;
real comment/like history and production Review remain unavailable.

A bounded [specialist window-rating slice](docs/WINDOW_RATINGS.md) adds accepted
canteen/floor/window topology, mutable signed −10..10 scores and durable own-score
recovery; production source/history remain unavailable.

See the [feature-parity checklist](docs/FEATURE_PARITY.md) for the required scope.

A separate [semantic search slice](docs/design/semantic-search.md) adds full-scope
permission-first exact pgvector retrieval, Qwen embedding/reranking adapters for
the selected Tumuer gateway, explicit batch indexing, a distinct HTTP/native
mode and source-revision revalidation. It is disabled by default. Acceptance uses
synthetic model transports; live-provider quality/cost, large-corpus performance
and deployment remain unverified. Hosted inference needs no local GPU, while
PostgreSQL still needs appropriate compute and storage.

## Code statistics

![Code statistics for every repository branch](https://xauryan.github.io/whaleu-next/code-stats.svg)

Each repository branch is shown separately with its own code-line, file and
language totals, language breakdown and source commit. The actual default branch
is marked. Branches are never added together, so shared code is not double-counted
in a misleading repository-wide total. Tags and branches in forks are not included.

[GitHub Actions](.github/workflows/code-stats.yml) refreshes all branch snapshots
after pushes to `main` or `rewrite/backend-foundation`, or a manual run on either
of those branches. Other branches are read as immutable Git data; their code is
never executed. Changes or deletions on those branches appear on the next allowed
run, rather than immediately after every branch push. The workflow must exist on
a publishing branch to run there; merging this feature into `main` enables its
push trigger. Manual dispatch also requires the workflow to exist on the default
branch. GitHub's image cache may also delay visible refreshes.

[cloc 2.10](https://github.com/AlDanial/cloc/releases/tag/v2.10) counts nonblank,
non-comment code lines in committed, Git-tracked regular files. Scope: source,
tests, scripts, migrations and configuration under `apps`, `packages`, `scripts`,
`tests`, `test`, `migrations`, `config` and `.github`, plus root configuration.
WXML and WXSS are counted natively; identical files within a branch count separately.
Dependencies, build/coverage output, documentation (including JSON reports),
generated directories/files and OpenAPI schemas, lockfiles, Markdown, source maps
and minified files are excluded. The extension allowlist and exclusions live in
[`scripts/code-stats.mjs`](scripts/code-stats.mjs). File and language totals include
only files recognized by cloc. Branches without counted source show zero explicitly.

Only the aggregate SVG is published to GitHub Pages. No source snapshots, JSON
reports, credentials or generated commits are published by this workflow.

## Repository

- [`apps/api`](apps/api/README.md): NestJS API, safe errors, health probes,
  validated configuration, PostgreSQL connection pool and transactions
- [`apps/api/migrations`](apps/api/migrations/README.md): forward-only SQL
  migration runner with checksums, transactional bookkeeping, and database locking
- [`apps/wechat`](apps/wechat/README.md): native WeChat client foundation
- [`compose.yaml`](compose.yaml): isolated local PostgreSQL 18.6
- [CI workflow](.github/workflows/ci.yml): standard public Linux runner, local
  disposable PostgreSQL, read-only permissions, no secrets or paid AI calls

## Development

Prerequisites: Node 24.19.0, npm 11.9.0, and Docker Compose for the local database.

```sh
npm ci --ignore-scripts
cp .env.example .env
npm run db:up
npm run db:status
npm run db:migrate
npm run dev
```

The API binds to `127.0.0.1:3000`. PostgreSQL is isolated on `127.0.0.1:55432` with
development-only credentials. Existing application databases are never contacted
by these defaults. Migrations create the new application schema; they do not import legacy data or
seed real users, privileges, or a fabricated school directory.

```sh
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
```

Liveness tests the API process. Readiness additionally requires a reachable
PostgreSQL 18.6 or newer 18.x server. A failed readiness check returns HTTP 503.

## Verification

```sh
npm run check
npm run format:check
```

`check` runs lint, strict type checks, unit/HTTP tests, and builds across both
workspaces. Real PostgreSQL integration tests are a separate required CI step:

```sh
TEST_DATABASE_URL=postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:5432/whaleu_test npm run test:integration
```

Use a **new disposable local database named `whaleu_test`**. The integration suite
creates and removes its own fixture schema and migration metadata; it refuses an
existing migration schema or a non-loopback connection. See the API README for
the test coverage and production-readiness limits.

Dependencies are exact-pinned and lockfile-backed. TypeScript 6.0.3 is deliberately
the latest compatible stable release for the current ESLint toolchain, rather
than forcing the unsupported TypeScript 7 peer dependency.

## Publication boundary

This is a fresh repository. It includes no old Git history, production datasets,
private audit material, or credentials. Do not commit `.env`, real client app
credentials, production backups, or secrets. No software license has been chosen
yet; public visibility alone does not grant an open-source license.

Specialist course scoring C1 is a separate Ratings vertical slice: source-accepted
course discovery, three independent 0.5–5 half-step first-lifetime scores, exact
per-axis summaries and durable original-key recovery on new Next native pages.
Catalog and historical coverage remain unavailable until explicitly accepted; no
production catalog/history or provider is activated. Generic Ratings and other
specialist domains are unchanged. See [scope and verification](docs/COURSE_RATINGS.md).

## W2 window dish recommendations

Bounded exact-name visible endorsements now have reversible actor membership,
private own-state closure, versioned CAS and durable original-request recovery.
Fresh public names use a distinct Review purpose; source/history/provider
activation remains closed. This is separate from numeric window scores. See
[the W2 contract](docs/DISH_RECOMMENDATIONS.md) for identity, coverage, privacy and local-test limits.

PM3 adds bounded private single-image Messaging through shared Media15, exact image Review and authenticated participant bytes. [Contract and remaining gates](docs/PRIVATE_MESSAGE_IMAGES.md).
