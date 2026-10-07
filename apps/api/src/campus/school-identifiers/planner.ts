import { isDeepStrictEqual } from 'node:util';
import { schoolIdentifierManifestSchema } from './contracts.js';
import type {
  IdentifierSnapshot,
  SchoolIdentifierManifest,
  LegacyRecord,
} from './contracts.js';

export interface MappingIssue {
  readonly code:
    | 'duplicate_input'
    | 'existing_record_conflict'
    | 'unknown_institution'
    | 'missing_source'
    | 'school_code_conflict'
    | 'moe_code_conflict'
    | 'unresolved_target';
  readonly key: string;
}
export interface SchoolIdentifierPlan {
  readonly ready: boolean;
  readonly additions: Omit<
    SchoolIdentifierManifest,
    'version' | 'legacyRecords'
  >;
  readonly issues: readonly MappingIssue[];
  readonly unresolvedInstitutionIds: readonly string[];
  readonly unresolvedLegacyRecords: readonly LegacyRecord[];
}
export const aliasKey = (value: {
  scheme: string;
  scope: string;
  value: string;
}) => JSON.stringify([value.scheme, value.scope, value.value]);
export const legacyKey = (value: LegacyRecord) =>
  JSON.stringify([value.sourceSystem, value.legacyRecordId]);

// Never considers a display name, guesses from a numeric suffix, or edits source rows.
export function planSchoolIdentifiers(
  input: unknown,
  snapshot: IdentifierSnapshot,
): SchoolIdentifierPlan {
  const manifest = schoolIdentifierManifestSchema.parse(input);
  const issues: MappingIssue[] = [];
  function additions<T>(
    incoming: readonly T[],
    existing: readonly T[],
    keyOf: (record: T) => string,
  ): T[] {
    const known = new Map(existing.map((record) => [keyOf(record), record]));
    const seen = new Set<string>();
    const result: T[] = [];
    for (const record of incoming) {
      const key = keyOf(record);
      if (seen.has(key)) issues.push({ code: 'duplicate_input', key });
      seen.add(key);
      const prior = known.get(key);
      if (prior && !isDeepStrictEqual(prior, record))
        issues.push({ code: 'existing_record_conflict', key });
      if (!prior) result.push(record);
    }
    return result;
  }
  const sources = additions(
    manifest.sources,
    snapshot.sources,
    (record) => record.id,
  );
  const mappings = additions(
    manifest.mappings,
    snapshot.mappings,
    (record) => record.institutionId,
  );
  const aliases = additions(manifest.aliases, snapshot.aliases, aliasKey);
  const legacyCrosswalks = additions(
    manifest.legacyCrosswalks,
    snapshot.legacyCrosswalks,
    legacyKey,
  );
  additions(manifest.legacyRecords, [], legacyKey);
  const institutionIds = new Set(snapshot.institutionIds);
  const sourceIds = new Set(
    [...snapshot.sources, ...sources].map((record) => record.id),
  );
  const resolvedIds = new Set(
    [...snapshot.mappings, ...mappings].map((record) => record.institutionId),
  );
  function source(id: string) {
    if (!sourceIds.has(id)) issues.push({ code: 'missing_source', key: id });
  }
  const five = new Map<string, string>();
  const ten = new Map<string, string>();
  for (const mapping of [...snapshot.mappings, ...mappings]) {
    if (!institutionIds.has(mapping.institutionId))
      issues.push({ code: 'unknown_institution', key: mapping.institutionId });
    for (const [index, code, kind] of [
      [five, mapping.schoolCode, 'school_code_conflict'],
      [ten, mapping.moeCode, 'moe_code_conflict'],
    ] as const) {
      const prior = index.get(code);
      if (prior && prior !== mapping.institutionId)
        issues.push({ code: kind, key: code });
      index.set(code, mapping.institutionId);
    }
    source(mapping.fiveDigitSourceId);
    source(mapping.moeSourceId);
  }
  for (const record of [...aliases, ...legacyCrosswalks]) {
    if (!resolvedIds.has(record.institutionId))
      issues.push({ code: 'unresolved_target', key: record.institutionId });
    source(record.sourceId);
  }
  const mappedLegacy = new Set(
    [...snapshot.legacyCrosswalks, ...legacyCrosswalks].map(legacyKey),
  );
  return {
    ready: issues.length === 0,
    additions: { sources, mappings, aliases, legacyCrosswalks },
    issues,
    unresolvedInstitutionIds: snapshot.institutionIds
      .filter((id) => !resolvedIds.has(id))
      .sort(),
    unresolvedLegacyRecords: manifest.legacyRecords.filter(
      (record) => !mappedLegacy.has(legacyKey(record)),
    ),
  };
}
