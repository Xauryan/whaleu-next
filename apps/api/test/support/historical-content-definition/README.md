# Exact historical content-definition reader

This test-only adapter restores the c27 reader used by the existing historical
session-retention and publication-upgrade fixtures. It does not provide an empty source repository, change
current runtime behavior, install later migrations, or bypass Review validation.

## Provenance and scope

- Source commit: `c27f173d8057f349469f4f96855d31edb9cff7c5`.
- Original dependency review: `b53198d`; retained as historical evidence, not a claim that every current dependency is still byte-identical.
- `provenance.json` records the complete source commit, original Git blob and
  SHA-256 for both saved files. Tests reverse only import-path relocation and
  compare the reconstructed original bytes to both original hashes.
- `content-definition.repository.ts` is the installed predecessor reader. It
  still imports **current** `definition-validation.ts` and all other production
  dependencies. Its historical storage reads do not query the nonexistent 0175
  source relation.
- The saved `definition-validation.ts` is a pure-test differential oracle only.
  Neither the guarded reader nor Nest configuration imports it.
- The only public read entries are `current` and `newRelatedRoot`; both are
  explicitly guarded before and after their actual read in the same caller-owned
  managed transaction. `resolve` is private. The prototype test detects added
  methods rather than implicitly granting them access.
- The override uses the real `ContentDefinitionRepository` Nest token and is
  selected only by the closed caller list **132** (session retention), **137**
  (related-sync upgrade), **144** (pre0148 rating-card upgrade), and **174**
  (follow/social deletion before text-source installation). Each instance
  validates its own exact complete prefix, never any other allowed prefix. The
  global historical registry adds only the explicit 174 boundary; the avatar-only
  132 boundary is unchanged.
  Existing post-upgrade restarts do not install this reader.

## Guards

Configuration requires test mode, loopback `whaleu_test`, disabled SSL without
connection-string SSL overrides, and one exact registered caller prefix. Every read
requires a managed transaction. Its shared transaction advisory lock uses the
actual `MIGRATION_LOCK` key; the real migration runner's exclusive session lock
conflicts with it. A retained migration-ledger SHARE lock and full ordered
name/checksum comparison reject missing, extra, changed or upgraded history.

The catalog check rejects all newly named 0175 object families: source relations
and indexes, `text_source_` functions and dynamically created triggers, added
columns and constraints, the source table's composite types, and the renamed
`profile_moderation_definition_pre_text_source` function. No query errors are
caught and turned into a permit. Existing replaced functions are not classified
as newly introduced objects; ordinary application validation stays in place.

## Recursive dependency review

`import-provenance.tsv` preserves the original b531 local import-closure review,
with c27/b531 Git blobs, b531 SHA-256, and runtime versus type-only reachability.
It is not rewritten when a later dependency successor is reviewed. There are 115 dependencies: 30 runtime-reachable and 85 type-only.
The reader snapshot removes only the direct source-read import from this
closure; that module remains reachable through current validation. External
packages are unchanged by the snapshot.

At that original b531 review, 102 dependencies were byte-identical to c27. The
13 changed/new dependencies in that review were:

| Dependency                                              | Reachability and legacy effect                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `community/content-review/definition-validation.ts`     | Runtime. New branches require a v6 envelope or an explicit source fact. With no source fact, v1–v5 retain their original reconstruction, scope, author, component, image and canonical-envelope checks. V6 without source fails closed. Pure tests compare valid and corrupted v1–v5 results against the original c27 oracle. |
| `community/content-review/contracts.ts`                 | Runtime. Adds a discriminated v6 variant and v6-only refinement. V1–v5 schema branches, common refinements, canonicalization and digest domains remain unchanged. Differential tests also prove approval/body equality is still required.                                                                                     |
| `community/contracts.ts`                                | Runtime import through policy helpers. Adds optional source fields and source-conditional input refinements. The reader does not parse new publication inputs; legacy enums/components remain unchanged.                                                                                                                      |
| `community/text-source/contracts.ts`                    | New runtime module. Defines source-specific contracts; no historical source is synthesized.                                                                                                                                                                                                                                   |
| `community/text-source/protocol.ts`                     | New runtime module. Defines source schemas and helpers. Source matching is called only by v6 or explicit-source branches; no legacy fallback exists.                                                                                                                                                                          |
| `community/text-source/repository.ts`                   | New runtime module through current validation. `reconstructTextSource` runs only with an actual source fact. The saved reader never calls `readTextSources`; the ordinary current reader still does, and is explicitly tested to reject missing source storage.                                                               |
| `community/text-source/source.ts`                       | New runtime module behind the source protocol. Its source preparation does not execute on v1–v5 reconstruction.                                                                                                                                                                                                               |
| `config/config.ts`                                      | Runtime through existing services. Adds disabled-by-default reading options and explicit source-manual validation. The historical fixture enables neither feature; its validated test/loopback settings are checked independently.                                                                                            |
| `community/community.repository.ts`                     | Type-only. Stored post version union adds 6; the historical reader still uses actual stored version and current validation.                                                                                                                                                                                                   |
| `community/content-review/approval-metadata.ts`         | Type-only within this reader's import closure. The existing real approval owner is not replaced.                                                                                                                                                                                                                              |
| `community/content-review/approval-validation.ts`       | Type-only within this reader's import closure. Existing real approval validation is not replaced.                                                                                                                                                                                                                             |
| `community/content-review/count-snapshot.repository.ts` | Type-only (`SnapshotReadBudget` through the source repository). No count reader is overridden or invoked by this adapter.                                                                                                                                                                                                     |
| `media/asset-repository.ts`                             | Type-only within this reader's closure. No Media owner is replaced.                                                                                                                                                                                                                                                           |

The integration test retains all four genuine HTTP moderation commands,
authorization, immutable audit checks, retention failure, real migration runner,
current runtime restart and post-upgrade recovery. Added assertions prove the
historical DI instance, absence of future source objects, actual legacy reads,
current reader failure on absent source storage, rejection after upgrade, and
restoration of the current source-aware reader after restart.

The two publication-upgrade tests keep their genuine commands, original request
keys, hashes, approved envelopes, receipts and post-upgrade replay assertions.
Their path remains `PublicationService.bind` to the existing publication gate
and then its injected definition reader. Only their exact **137** and **144**
historical phases additionally install the complete, hash-pinned c27 publication
producer described in `../historical-publication/README.md`, because the current
producer requires Home objects which those schemas intentionally do not contain.
Its only source changes are declared import mappings, including one checked
discussion-target adapter that runs current authorization before rejecting
nonlegacy categories and post-c27 envelope versions. Current Review, Safety,
Media, authorization and publication-journal dependencies remain in use. No approval
owner or count reader is replaced. The historical transaction wrapper retains
exact-prefix and recognized partial-Home fences through the real pre-COMMIT
proof phase without rewriting results or receipts. The **132** fixture does not install this producer or transaction wrapper. The
original 137/144 producer entrypoint still rejects **174**; only the separately
reviewed exact174 follow/social publication opt-in uses the same pinned producer.
Both upgrade tests retain historical DI/source-schema absence and current DI
assertions after restart; the unbounded current restart restores the current
publication producer and unwrapped database owner as well.

The newly authored 0174 fixture uses the same guarded reader through the actual
Nest repository token, asserts its identity before and after application init,
and checks future source-object absence. Its existing genuine like/save POST
lineage tests remain on the exact 0174 ledger and explicitly opt into the separate
publication adapter, as does the content-empty synthetic cooling refusal test.
All default follow/social callers retain the current producer. The adapter proves
positive deletion lifecycle ownership and retains current Identity authentication
and account locking; no deletion owner, new-peer creation contract, Review,
Safety, Media or publication journal is replaced. The c27 reader, producer and
differential-oracle snapshot bytes are unchanged.

## Absent historical reading enrollment

The first real 0144 publication rerun exposed a second independent boundary:
current `PublicationRepository.execute` calls `ReadingFormattingRuntime.enrollCreated`
after storing a new created receipt. The current enrollment owner reads
`community_text_sources` before optional formatter readiness. Merely disabling
formatting cannot make it compatible with an intentionally absent source table.

`publication-provenance.json` records c27's original publication repository Git
blob, full SHA-256 and exact execute tail. That predecessor returned after final
actor validation and had no reading owner or enrollment call. It is evidence,
not a replacement publication implementation.

The test-only `HistoricalReadingFormattingRuntime` extends the real current
formatter and overrides **only** `enrollCreated`. All other methods retain the
same current prototype functions. The same explicit four-prefix configuration
installs this method-level adapter, without selecting by missing-table errors.
Before and after enrollment it requires the managed transaction, exact complete
caller prefix, migration fences, and absence of all 0175 and 0176 source/reading
object families. It then requires the actual canonical node to have been created
in that same transaction, an exact source-free v1–v5 approval binding whose
current parser/digest/body/author agree, and the exact account/request/operation/
resource created receipt. Missing or mismatched evidence throws; no exception is
turned into a permit. The adapter writes no data and creates no reading work.

The genuine current publication code returns an already recorded receipt before
reaching enrollment. Therefore replay remains unchanged and does not need an
exception to the same-transaction creation condition. Pure tests pin this call
ordering, exercise all admitted prefixes and node kinds, reject corrupt/source-
bearing or partially upgraded inputs, prove all other formatter methods remain
current, and prove ordinary current enrollment still throws on missing storage.
Both publication-upgrade tests assert the current formatter constructor is
restored after restart; the 0144 test also probes its real missing-table failure
before upgrade without altering the historical command or replay assertions.

## Preparation-only 0181 dependency successor

`preparation-runtime-successor.json` separately pins the current reader's finite
runtime closure at base tree `62546a2f94ca41033b30d3beb87cfe9a95538586` and the
0181 candidate: the saved reader plus 38 runtime-reachable local dependencies.
The complete import-edge graph is unchanged by this increment. Every source is
pinned, and all but the following three sources remain byte-identical to that
base. This does not retroactively replace the original 115-entry TSV, c27
snapshot identities, original differential oracle, or previous review history.

- `config/config.ts`: only the disabled/prepare_only field with disabled default
  is added. The exact successor helper removes that unique anchored span,
  reconstructs the entire accepted 7c5 source SHA-256 and Git blob, then replays
  it exactly. Historical enrollment, source/manual-review and registration-guard
  parsing/defaults remain independently exercised with negative controls.
- `http/application-error.ts`: only three static preparation errors are added.
  The exact helper restores the complete b8e predecessor SHA-256 and Git blob;
  runtime tests cover all 308 old conditions, both specialized subclasses and
  the three new sanitized transport envelopes. No old condition is relabeled.
- `observability/logger.ts`: only four top-level/nested recovery/replacement
  secret redaction paths are added. A complete-source restoration test and real
  logger output tests verify the narrow addition and retained access-token
  redaction; no new runtime import or deletion work is introduced.

`historical-preparation-dependencies.test.ts` authenticates this separate record,
all current closure bytes, the original unchanged TSV and package-lock, and both
exact restorers. Neither the reader nor its runtime closure imports a real
account-deletion module. These are source and database-free semantic checks,
not fresh PostgreSQL compatibility, full-application acceptance, or permission
to enable preparation mode. The historical-owner integration suites and current
application gates must run on the final composed 0181 source separately.
