# School business identifiers and reviewed migration

## Public contract and retained relationships

`Campus.institutionId` is a five-digit **string**, for example `"10001"` for
北京大学 and `"10006"` for 北京航空航天大学. It is the canonical institution
business identifier, not a display label. Never parse it as an integer.
An unresolved institution returns `null`; its campus still appears in the
directory and may still be selected. There is no UUID fallback.

`whaleu_campus.institutions.id` remains the private UUID surrogate. Existing
campus-to-institution foreign keys are preserved. Physical campus IDs, operating
region IDs, user IDs, profile selections and verified campus relationships stay
in their separate UUID namespaces. A school code does not establish identity,
student verification or a permission grant. APIs selecting a physical campus
continue accepting `campusId`, never a school code in its place.

Migration `0006_school_identifiers.sql` adds empty registries. It neither seeds a
catalog nor guesses or rewrites any existing record:

- `school_identifiers`: one reviewed five/ten-digit pair per private institution,
  with unique string codes, explicit review and source references
- `school_identifier_sources`: source title, publisher, exact HTTPS URL,
  publication date (nullable), retrieval time and optional content SHA-256
- `school_identifier_aliases`: historical or other-scheme values identified by
  the exact tuple `(scheme, scope, value)`, explicit target, validity dates,
  source and review
- `school_legacy_crosswalks`: exact `(source_system, legacy_record_id)` to reviewed
  target institution mapping, with its own source and review

All registry data is private operational data except the public five-digit ID.
The migration tool inserts reviewed additions only. It refuses to overwrite an
existing code, crosswalk, alias or source. Corrections require separate audited
review and a forward-change plan; they must not repoint old business IDs silently.

## Code schemes and reviewed evidence

Reviewed examples (sources checked 2026-10-07):

- 北京大学: five-digit `10001` from the university's [2026 graduate admissions
  notice](https://admission.pku.edu.cn/docs/20251011105645009634.pdf), first page;
  ten-digit `4111010001` from the [Beijing Municipal Education Commission
  directory](https://jw.beijing.gov.cn/jyzy/jyzc/ptgdyx/202110/t20211011_2510314.html)
- 北京航空航天大学: five-digit `10006` from the university's [graduate admissions
  contact page](https://yzb.buaa.edu.cn/lxwm/lxwm.htm); ten-digit `4111010006` from
  the [Beijing Municipal Education Commission directory](https://jw.beijing.gov.cn/jyzy/jyzc/ptgdyx/202110/t20211011_2510336.html)

The [2025 education statistics training material, page 14](https://www.emic.edu.cn/jyxxsj/202411/W020250818419240061304.pdf)
explains that higher-education institutions use a six-digit sequence consisting
of `0` followed by the original five-digit school code, after the category and
province fields. The registry accepts reviewed ordinary/adult higher-education
pairs with category `41`/`42`, a zero in position five and matching final five
digits. The [official 2020 adult institution list](https://www.hanbin.gov.cn/UploadFiles/file/20200727/20200727153650_7084.pdf)
provides examples of category `42`. It is historical evidence, not a current
catalog seed.

This consistency check **does not establish that a school exists or authorize a
mapping**. Both codes and the target institution require evidence and review.
Province-specific admissions codes, admissions sites, research institutes and
campus-specific admissions identifiers are different schemes. They are never
promoted to the canonical school ID by length, suffix, name similarity or a
blanket replacement. Each alias must include its issuing authority,
jurisdiction, program and year/catalog version in `scope`. Reuse across years
must use distinct scopes. The migrator does not perform unscoped alias lookup.

These examples are not a comprehensive national catalog. The 2026 nationwide
workbook has not been ingested or verified by this implementation. No national
coverage, current institution count or complete production mapping is claimed.

## Reviewed manifest

The strict, versioned JSON contract is in
`apps/api/src/campus/school-identifiers/contracts.ts`. All arrays are explicit:

```json
{
  "version": 1,
  "sources": [],
  "mappings": [],
  "aliases": [],
  "legacyCrosswalks": [],
  "legacyRecords": []
}
```

Each `sources` record requires `id`, `title`, `publisher`, `url`, `publishedOn`
(date or null), `retrievedAt` (offset-qualified timestamp), `contentSha256`
(64 lowercase hex characters or null). Preserve an evidence snapshot and
checksum where available; null does not claim a downloaded or hashed document.

Each mapping requires the existing private `institutionId` UUID, `schoolCode`,
`moeCode`, `fiveDigitSourceId`, `moeSourceId`, `reviewedBy`, `reviewedAt` and
`reviewNote`. Both source IDs must exist either in the manifest or the registry.
The codes are strings with exactly five and ten digits. All target UUIDs must
already exist; the migrator cannot create or merge schools. No name is accepted
as a mapping key. A reviewer must verify that the explicit UUID is the intended
institution, not merely that its current name resembles a source name.

Each alias requires `scheme`, `scope`, `value`, `institutionId`, nullable
`validFrom`/`validTo`, `sourceId` and the same three review fields. Allowed schemes
are `moe-five-historical`, `moe-ten-historical`, `provincial-admissions`,
`institution-admissions`, `research-institute`, and `other`. Every alias target
must have a reviewed canonical mapping. Records without one remain unresolved
in their source inventory until reviewed; do not fabricate a target.

Each legacy crosswalk requires `sourceSystem`, `legacyRecordId`, `institutionId`,
`sourceId` and the same review fields. `sourceSystem` must identify the source
system, snapshot/version and table. IDs remain exact text, retaining leading
zeros. Surrounding whitespace is rejected instead of silently trimmed. An
optional legacy inventory is supplied explicitly as `legacyRecords`, each with
only `sourceSystem` and `legacyRecordId`. Unmatched inventory records appear in
`unresolvedLegacyRecords`; they are never modified or deleted in the source.

Every unmapped target institution is reported in `unresolvedInstitutionIds`,
even if omitted from the supplied manifest. Unresolved records may be reviewed
and resolved in a later run without changing existing physical campus IDs.
A successful partial apply is not evidence of complete inventory coverage.

## Operator workflow

Use a separately prepared and reviewed local manifest, never a guessed mapping.
The production source MySQL schema and data mapping remain a separate prerequisite
for a production importer. This tool handles the new PostgreSQL identifier
registry, not the full legacy database import or a production cutover.

From the repository root:

```sh
# Default: read-only repeatable-read transaction; no registry writes.
npm run schools:migrate -w @whaleu/api -- --file=/absolute/path/reviewed-manifest.json

# Same dry run with explicit mode.
npm run schools:migrate -w @whaleu/api -- dry-run --file=/absolute/path/reviewed-manifest.json

# Only after separately authorized review in the intended target environment:
npm run schools:migrate -w @whaleu/api -- apply --file=/absolute/path/reviewed-manifest.json
```

The tool requires the existing schema through migration 0006. It never runs SQL
schema migrations automatically. Production `apply` additionally requires
`--allow-production`; this technical flag does not replace operator authorization,
a backup/restore rehearsal or a reviewed cutover plan. This implementation was
only exercised against synthetic fixtures in a disposable loopback PostgreSQL.

Dry-run reports additions, conflicts and unresolved records. A conflict sets
`ready: false`, exits unsuccessfully in the CLI and prevents **all** writes.
Apply serializes registry writers and rechecks the current data in one atomic
transaction. Repeating an identical manifest is a no-op. Database uniqueness,
format, consistency and foreign-key constraints provide independent checks.
For a serialization error or an uncertain commit outcome, rerun dry-run and
reconcile before retrying; do not blindly overwrite or relabel records.

Before production use, reconcile source/target counts, every relationship,
unresolved records and duplicate institutions against a reviewed source snapshot.
Retain the original source and manifest plus the dry-run/apply reports privately.
Do not commit production records, private reviewers' information or database
credentials to this repository.
