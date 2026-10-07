import type {
  IdentifierSnapshot,
  SchoolIdentifierManifest,
} from '../../src/campus/school-identifiers/contracts.js';

export const syntheticInstitutions = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const;
export const syntheticReview = {
  reviewedBy: 'synthetic-test-reviewer',
  reviewedAt: '2026-10-01T00:00:00.000Z',
  reviewNote:
    'SYNTHETIC TEST ONLY. Explicit fixture mapping, not a real school catalog.',
};
export function syntheticSchoolManifest(): SchoolIdentifierManifest {
  return {
    version: 1,
    sources: [
      {
        id: 'synthetic-source',
        title: 'Synthetic school registry fixture',
        publisher: 'Local test fixture',
        url: 'https://synthetic.invalid/schools',
        publishedOn: '2026-10-01',
        retrievedAt: '2026-10-01T00:00:00.000Z',
        contentSha256: null,
      },
    ],
    mappings: [
      {
        institutionId: syntheticInstitutions[0],
        schoolCode: '00001',
        moeCode: '4199000001',
        fiveDigitSourceId: 'synthetic-source',
        moeSourceId: 'synthetic-source',
        ...syntheticReview,
      },
    ],
    aliases: [
      {
        scheme: 'provincial-admissions',
        scope: 'synthetic-province/undergraduate/2025',
        value: '1234',
        institutionId: syntheticInstitutions[0],
        validFrom: '2025-01-01',
        validTo: '2025-12-31',
        sourceId: 'synthetic-source',
        ...syntheticReview,
      },
    ],
    legacyCrosswalks: [
      {
        sourceSystem: 'synthetic-whaleu-v1/schools',
        legacyRecordId: '0007',
        institutionId: syntheticInstitutions[0],
        sourceId: 'synthetic-source',
        ...syntheticReview,
      },
    ],
    legacyRecords: [
      { sourceSystem: 'synthetic-whaleu-v1/schools', legacyRecordId: '0007' },
      {
        sourceSystem: 'synthetic-whaleu-v1/schools',
        legacyRecordId: 'unresolved-name-match',
      },
    ],
  };
}
export function emptyIdentifierSnapshot(): IdentifierSnapshot {
  return {
    institutionIds: [...syntheticInstitutions],
    sources: [],
    mappings: [],
    aliases: [],
    legacyCrosswalks: [],
  };
}
