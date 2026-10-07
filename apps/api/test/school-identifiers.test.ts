import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  schoolCodeSchema,
  schoolIdentifierManifestSchema,
  schoolIdentifierSchema,
} from '../src/campus/school-identifiers/contracts.js';
import {
  assertSchoolMigrationPermission,
  parseSchoolMigrationCommand,
} from '../src/campus/school-identifiers/options.js';
import { planSchoolIdentifiers } from '../src/campus/school-identifiers/planner.js';
import {
  emptyIdentifierSnapshot,
  syntheticInstitutions,
  syntheticSchoolManifest,
} from './support/school-fixtures.js';

test('canonical school identifiers stay strings, preserve leading zeros and validate reviewed MOE five/ten consistency', () => {
  const mapping = syntheticSchoolManifest().mappings[0]!;
  assert.equal(schoolCodeSchema.safeParse('10001\n').success, false);
  for (const [schoolCode, moeCode] of [
    ['10001', '4111010001'],
    ['10006', '4111010006'],
    ['00001', '4199000001'],
    ['51171', '4212051171'],
  ]) {
    const result = schoolIdentifierSchema.parse({
      ...mapping,
      schoolCode,
      moeCode,
    });
    assert.equal(result.schoolCode, schoolCode);
    assert.equal(typeof result.schoolCode, 'string');
  }
  for (const schoolCode of [
    10001,
    '1001',
    '100001',
    syntheticInstitutions[0],
    ' 10001',
    '10001\n',
  ]) {
    assert.equal(
      schoolIdentifierSchema.safeParse({ ...mapping, schoolCode }).success,
      false,
    );
  }
  for (const moeCode of [
    '4111010006',
    '1111000001',
    '4199100001',
    '00001',
    '4199000001\n',
  ]) {
    assert.equal(
      schoolIdentifierSchema.safeParse({ ...mapping, moeCode }).success,
      false,
    );
  }
});

test('reviewed plans preserve unresolved institution and legacy records without matching names or deriving codes', () => {
  const result = planSchoolIdentifiers(
    syntheticSchoolManifest(),
    emptyIdentifierSnapshot(),
  );
  assert.equal(result.ready, true);
  assert.deepEqual(
    result.unresolvedInstitutionIds,
    syntheticInstitutions.slice(1),
  );
  assert.deepEqual(result.unresolvedLegacyRecords, [
    {
      sourceSystem: 'synthetic-whaleu-v1/schools',
      legacyRecordId: 'unresolved-name-match',
    },
  ]);
  assert.equal(result.additions.legacyCrosswalks[0]?.legacyRecordId, '0007');
  const whitespace = syntheticSchoolManifest();
  whitespace.legacyCrosswalks[0]!.legacyRecordId = ' 0007';
  assert.equal(
    schoolIdentifierManifestSchema.safeParse(whitespace).success,
    false,
  );
  const manifest = syntheticSchoolManifest();
  manifest.mappings = [];
  manifest.aliases = [];
  manifest.legacyCrosswalks = [];
  const unmapped = planSchoolIdentifiers(manifest, emptyIdentifierSnapshot());
  assert.deepEqual(unmapped.unresolvedInstitutionIds, syntheticInstitutions);
  assert.equal(unmapped.unresolvedLegacyRecords.length, 2);
});

test('review evidence and exact source provenance are required, with no anonymous or unresolved source mappings', () => {
  const manifest = syntheticSchoolManifest();
  assert.equal(
    schoolIdentifierManifestSchema.safeParse({
      ...manifest,
      mappings: [{ ...manifest.mappings[0], reviewedBy: '' }],
    }).success,
    false,
  );
  assert.equal(
    schoolIdentifierManifestSchema.safeParse({
      ...manifest,
      sources: [{ ...manifest.sources[0], url: 'http://synthetic.invalid' }],
    }).success,
    false,
  );
  manifest.sources = [];
  assert.ok(
    planSchoolIdentifiers(manifest, emptyIdentifierSnapshot()).issues.some(
      ({ code }) => code === 'missing_source',
    ),
  );
  manifest.mappings[0]!.institutionId = '44444444-4444-4444-8444-444444444444';
  assert.ok(
    planSchoolIdentifiers(manifest, emptyIdentifierSnapshot()).issues.some(
      ({ code }) => code === 'unknown_institution',
    ),
  );
});

test('multiple institution targets cannot claim the same canonical code and duplicate input is rejected', () => {
  const manifest = syntheticSchoolManifest();
  manifest.mappings.push({
    ...manifest.mappings[0]!,
    institutionId: syntheticInstitutions[1],
  });
  const result = planSchoolIdentifiers(manifest, emptyIdentifierSnapshot());
  assert.equal(result.ready, false);
  assert.ok(result.issues.some(({ code }) => code === 'school_code_conflict'));
  assert.ok(result.issues.some(({ code }) => code === 'moe_code_conflict'));
  manifest.sources.push(manifest.sources[0]!);
  assert.ok(
    planSchoolIdentifiers(manifest, emptyIdentifierSnapshot()).issues.some(
      ({ code }) => code === 'duplicate_input',
    ),
  );
});

test('existing reviewed identifiers, source provenance, aliases and legacy crosswalks are immutable in the migration tool', () => {
  const manifest = syntheticSchoolManifest();
  const snapshot = { ...emptyIdentifierSnapshot(), ...manifest };
  const same = planSchoolIdentifiers(manifest, snapshot);
  assert.equal(same.ready, true);
  assert.deepEqual(same.additions, {
    sources: [],
    mappings: [],
    aliases: [],
    legacyCrosswalks: [],
  });
  for (const change of [
    {
      mappings: [
        {
          ...manifest.mappings[0]!,
          schoolCode: '00002',
          moeCode: '4199000002',
        },
      ],
    },
    {
      sources: [
        { ...manifest.sources[0]!, url: 'https://synthetic.invalid/changed' },
      ],
    },
    {
      aliases: [
        { ...manifest.aliases[0]!, institutionId: syntheticInstitutions[1] },
      ],
    },
    {
      legacyCrosswalks: [
        {
          ...manifest.legacyCrosswalks[0]!,
          institutionId: syntheticInstitutions[1],
        },
      ],
    },
  ]) {
    const result = planSchoolIdentifiers({ ...manifest, ...change }, snapshot);
    assert.equal(result.ready, false);
    assert.ok(
      result.issues.some(({ code }) => code === 'existing_record_conflict'),
    );
  }
});

test('historical codes are scheme and version scoped; admissions or research codes never become canonical by inference', () => {
  const manifest = syntheticSchoolManifest();
  manifest.mappings.push({
    ...manifest.mappings[0]!,
    institutionId: syntheticInstitutions[1],
    schoolCode: '00002',
    moeCode: '4199000002',
  });
  manifest.aliases.push({
    ...manifest.aliases[0]!,
    scope: 'synthetic-province/undergraduate/2026',
    institutionId: syntheticInstitutions[1],
  });
  manifest.aliases.push({
    ...manifest.aliases[0]!,
    scheme: 'research-institute',
    institutionId: syntheticInstitutions[1],
  });
  assert.equal(
    planSchoolIdentifiers(manifest, emptyIdentifierSnapshot()).ready,
    true,
  );
  manifest.aliases.push({
    ...manifest.aliases[0]!,
    institutionId: syntheticInstitutions[1],
  });
  assert.ok(
    planSchoolIdentifiers(manifest, emptyIdentifierSnapshot()).issues.some(
      ({ code }) => code === 'duplicate_input',
    ),
  );
  const unresolved = syntheticSchoolManifest();
  unresolved.mappings = [];
  const result = planSchoolIdentifiers(unresolved, emptyIdentifierSnapshot());
  assert.equal(result.ready, false);
  assert.ok(result.issues.some(({ code }) => code === 'unresolved_target'));
  assert.equal(result.additions.mappings.length, 0);
});

test('migration command is dry-run by default and requires explicit production apply opt-in', () => {
  assert.deepEqual(parseSchoolMigrationCommand(['--file=reviewed.json']), {
    mode: 'dry-run',
    file: 'reviewed.json',
    allowProduction: false,
  });
  for (const args of [
    [],
    ['apply'],
    ['--file=a', '--file=b'],
    ['--apply', '--file=a'],
    ['--file=a', '--allow-production', '--allow-production'],
  ])
    assert.throws(() => parseSchoolMigrationCommand(args));
  const command = parseSchoolMigrationCommand([
    'apply',
    '--file=reviewed.json',
  ]);
  assert.throws(() => assertSchoolMigrationPermission(command, 'production'));
  assert.doesNotThrow(() => assertSchoolMigrationPermission(command, 'test'));
  assert.doesNotThrow(() =>
    assertSchoolMigrationPermission(
      parseSchoolMigrationCommand(['--file=x']),
      'production',
    ),
  );
  assert.doesNotThrow(() =>
    assertSchoolMigrationPermission(
      parseSchoolMigrationCommand(['apply', '--file=x', '--allow-production']),
      'production',
    ),
  );
});
