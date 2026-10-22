import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/community/content-review/canonical-json.js';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import {
  HOME_POLICY_SOURCE,
  homeAdmissionDefinitionSchema,
  admissionDefinitionDigest,
  homeAdmissionCommandSchema,
} from '../src/community/home-feed-policy/admission-contract.js';
import type {
  HomeAdmissionDefinition,
  HomeAdmission,
} from '../src/community/home-feed-policy/admission-contract.js';
import {
  resolveHomeMapping,
  homePolicyPreflight,
  configureHomeAdmission,
} from '../src/community/home-feed-policy/admission.js';
const space = '11111111-1111-4111-8111-111111111111';
const region = '22222222-2222-4222-8222-222222222222';
const policy = '33333333-3333-4333-8333-333333333333';
function definition(): HomeAdmissionDefinition {
  return {
    version: 1,
    sourceCommit: HOME_POLICY_SOURCE,
    categoryMappings: [
      { nativeCategory: 'discussion', sourceKind: 'regional', legacyChoose: 2 },
      { nativeCategory: 'water', sourceKind: 'regional', legacyChoose: 9 },
    ],
    scopeMappings: [
      {
        sourceSpaceId: space,
        sourceKind: 'regional',
        sourceRegionId: region,
        targetWaterSpaceId: space,
        targetRegionId: region,
      },
    ],
    authorModes: ['named', 'anonymous'],
    exemptions: { audit: 'none', attachments: 'normalized_server_facts' },
    surfaces: { home: true, hot: 'exclude_water', following: 'excluded' },
    markdownReferences: false,
  };
}
function admission(): HomeAdmission {
  const d = definition();
  return {
    definition: d,
    ref: {
      id: policy,
      revision: 1,
      digest: admissionDefinitionDigest(d),
      sourceCommit: HOME_POLICY_SOURCE,
      validUntil: '2099-01-01T00:00:00.000Z',
    },
  };
}
function client(
  query: (sql: string, params: unknown[]) => unknown[],
): PoolClient {
  const prepared = new Map<string, Record<string, unknown>>();
  return {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('WITH instant AS')) {
        query(sql, params);
        const issued_at = new Date(),
          expires_at = new Date(issued_at.getTime() + 300000),
          valid_until = new Date(
            issued_at.getTime() + Number(params[3]) * 3600000,
          );
        const payload = {
          ...JSON.parse(params[2] as string),
          preparationId: params[0],
          issuedAt: issued_at.toISOString(),
          expiresAt: expires_at.toISOString(),
          validUntil: valid_until.toISOString(),
        };
        const row = {
          id: params[0],
          definition: JSON.parse(params[1] as string),
          payload,
          digest: createHash('sha256')
            .update('whaleu-home-preview:v1\n' + canonicalJson(payload))
            .digest('hex'),
          issued_at,
          expires_at,
          valid_until,
        };
        prepared.set(params[0] as string, row);
        return { rows: [row] };
      }
      if (
        sql.startsWith(
          'SELECT p.* FROM whaleu_community.home_policy_preparations',
        )
      )
        return {
          rows: prepared.has(params[0] as string)
            ? [prepared.get(params[0] as string)]
            : [],
        };
      const rows = query(sql, params);
      if (sql.startsWith('INSERT INTO whaleu_community.home_policy_admissions'))
        prepared.delete(params[9] as string);
      return { rows };
    },
  } as unknown as PoolClient;
}
test('explicit fixed-source mappings reject unknown, guessed, duplicate, and Markdown admission', () => {
  assert.equal(
    homeAdmissionDefinitionSchema.safeParse(definition()).success,
    true,
  );
  for (const change of [
    { sourceCommit: '0'.repeat(40) },
    { markdownReferences: true },
    {
      categoryMappings: [
        { nativeCategory: 'water', sourceKind: 'regional', legacyChoose: 100 },
      ],
    },
    {
      categoryMappings: [
        { nativeCategory: 'feedback', sourceKind: 'global', legacyChoose: 100 },
      ],
    },
    {
      categoryMappings: [
        ...definition().categoryMappings,
        ...definition().categoryMappings,
      ],
    },
    {
      exemptions: {
        audit: 'trusted_server_fact',
        attachments: 'normalized_server_facts',
      },
    },
    { surfaces: { home: true, hot: 'author_only', following: 'all_authors' } },
  ])
    assert.equal(
      homeAdmissionDefinitionSchema.safeParse({ ...definition(), ...change })
        .success,
      false,
    );
  assert.equal(
    homeAdmissionCommandSchema.safeParse({
      command: 'apply',
      definition: definition(),
      evidenceRef: 'source proof',
      validForHours: 169,
      expectedRevision: 0,
      previewDigest: 'a'.repeat(64),
      preparationId: policy,
    }).success,
    false,
  );
});
test('canonical definition digest is property-order independent and mapping is not category guessing', () => {
  const d = definition();
  assert.equal(
    admissionDefinitionDigest(d),
    admissionDefinitionDigest({
      ...d,
      surfaces: { following: 'excluded', hot: 'exclude_water', home: true },
    }),
  );
  const input = {
    category: 'discussion',
    spaceId: space,
    spaceKind: 'regional' as const,
    regionId: region,
    authorMode: 'anonymous' as const,
    authorOriginRegionId: null,
  };
  assert.equal(resolveHomeMapping(admission(), input).legacyChoose, 2);
  assert.throws(() =>
    resolveHomeMapping(admission(), { ...input, category: 'feedback' }),
  );
  assert.throws(() =>
    resolveHomeMapping(admission(), { ...input, regionId: policy }),
  );
  assert.throws(() =>
    resolveHomeMapping(
      { ...admission(), ref: { ...admission().ref, digest: 'f'.repeat(64) } },
      input,
    ),
  );
});
test('city mapping requires exact publication-time region; it cannot use a default school', () => {
  const d = definition();
  d.categoryMappings.push({
    nativeCategory: 'discussion',
    sourceKind: 'global',
    legacyChoose: 100,
  });
  d.scopeMappings.push({
    sourceSpaceId: policy,
    sourceKind: 'global',
    sourceRegionId: null,
    targetWaterSpaceId: space,
    targetRegionId: region,
  });
  const a = {
    ...admission(),
    definition: d,
    ref: { ...admission().ref, digest: admissionDefinitionDigest(d) },
  };
  const input = {
    category: 'discussion',
    spaceId: policy,
    spaceKind: 'global' as const,
    regionId: null,
    authorMode: 'named' as const,
    authorOriginRegionId: null,
  };
  assert.throws(() => resolveHomeMapping(a, input));
  assert.equal(
    resolveHomeMapping(a, { ...input, authorOriginRegionId: region })
      .legacyChoose,
    100,
  );
  assert.throws(() =>
    resolveHomeMapping(a, { ...input, authorOriginRegionId: space }),
  );
});
test('missing catalog is explicitly not publication readiness', async () => {
  const result = await homePolicyPreflight(client(() => [{ present: false }]));
  assert.equal(result.catalogReady, false);
  assert.equal(result.publicationReady, false);
  assert.ok(result.blockers.includes('v7_publication_not_integrated'));
});
test('production source_manual preparation writes no admission and never asserts runtime readiness', async () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://example.invalid/test',
    COMMUNITY_TEXT_REVIEW: 'source_manual',
    COMMUNITY_TEXT_REVIEW_SPACE_ID: space,
    COMMUNITY_TEXT_REVIEW_REGION_ID: region,
    COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: policy,
    COMMUNITY_TEXT_REVIEW_OPERATOR: 'manual:host:reviewer',
  });
  const queries: string[] = [];
  const tx = client((sql) => {
    queries.push(sql);
    if (sql.includes('to_regprocedure')) return [{ present: true }];
    if (sql.includes('home_policy_protocol() protocol'))
      return [
        {
          valid: true,
          protocol: {
            version: 1,
            sourceCommit: HOME_POLICY_SOURCE,
            migration: '0177_home_policy_admission.sql',
            publicationReady: false,
          },
        },
      ];
    if (sql.includes('SELECT s.id,s.kind'))
      return [
        { id: space, kind: 'regional', region_id: region, region_active: true },
      ];
    if (sql.includes('SELECT id FROM whaleu_campus.operating_regions'))
      return [{ id: region }];
    if (sql === 'SELECT current_user AS actor')
      return [{ actor: 'review_role' }];
    return [];
  });
  const command = {
    command: 'prepare' as const,
    definition: definition(),
    evidenceRef: 'fixed source acceptance',
    validForHours: 24,
  };
  const result = (await configureHomeAdmission(
    command,
    config,
    'manual:host:reviewer',
    tx,
  )) as { publicationReady: boolean; previewDigest: string };
  assert.equal(result.publicationReady, false);
  assert.match(result.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    queries.some(
      (q) =>
        q.startsWith('INSERT INTO whaleu_community.home_policy_admissions') ||
        /UPDATE SET|DELETE/.test(q),
    ),
    false,
  );
  await assert.rejects(() =>
    configureHomeAdmission(
      command,
      config,
      'manual:wrong:reviewer',
      client(() => {
        throw new Error('must not query');
      }),
    ),
  );
  await assert.rejects(
    () =>
      configureHomeAdmission(
        {
          ...command,
          command: 'apply',
          expectedRevision: 0,
          previewDigest: 'f'.repeat(64),
          preparationId: policy,
        },
        config,
        'manual:host:reviewer',
        tx,
      ),
    /Stale, expired, consumed or mismatched/,
  );
});
test('matching preview applies one immutable revision and advances the head atomically', async () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://example.invalid/test',
    COMMUNITY_TEXT_REVIEW: 'source_manual',
    COMMUNITY_TEXT_REVIEW_SPACE_ID: space,
    COMMUNITY_TEXT_REVIEW_REGION_ID: region,
    COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: policy,
    COMMUNITY_TEXT_REVIEW_OPERATOR: 'manual:host:reviewer',
  });
  const writes: { sql: string; params: unknown[] }[] = [];
  const tx = client((sql, params) => {
    if (sql.includes('to_regprocedure')) return [{ present: true }];
    if (sql.includes('home_policy_protocol() protocol'))
      return [
        {
          valid: true,
          protocol: {
            version: 1,
            sourceCommit: HOME_POLICY_SOURCE,
            migration: '0177_home_policy_admission.sql',
            publicationReady: false,
          },
        },
      ];
    if (sql.includes('SELECT s.id,s.kind'))
      return [
        { id: space, kind: 'regional', region_id: region, region_active: true },
      ];
    if (sql.includes('SELECT id FROM whaleu_campus.operating_regions'))
      return [{ id: region }];
    if (sql === 'SELECT current_user AS actor')
      return [{ actor: 'review_role' }];
    if (sql.startsWith('INSERT')) {
      writes.push({ sql, params });
      return sql.includes('RETURNING')
        ? [{ valid_until: new Date('2099-01-01T00:00:00.000Z') }]
        : [];
    }
    return [];
  });
  const command = {
    command: 'prepare' as const,
    definition: definition(),
    evidenceRef: 'fixed source acceptance',
    validForHours: 24,
  };
  const preview = (await configureHomeAdmission(
    command,
    config,
    'manual:host:reviewer',
    tx,
  )) as { previewDigest: string; preparationId: string };
  const result = (await configureHomeAdmission(
    {
      ...command,
      command: 'apply',
      expectedRevision: 0,
      previewDigest: preview.previewDigest,
      preparationId: preview.preparationId,
    },
    config,
    'manual:host:reviewer',
    tx,
  )) as {
    applied: boolean;
    publicationReady: boolean;
    admission: { revision: number };
  };
  assert.equal(result.applied, true);
  assert.equal(result.publicationReady, false);
  assert.equal(result.admission.revision, 1);
  assert.equal(writes.length, 2);
  assert.equal(writes[0]!.params[1], 1);
  assert.equal(writes[0]!.params[2], null);
  assert.match(writes[0]!.sql, /current_user/);
  assert.match(writes[1]!.sql, /home_policy_head/);
});
test('prospective diagnostics follow first mapped apply and mapped-to-none replacement, not old head', async () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://example.invalid/test',
    COMMUNITY_TEXT_REVIEW: 'source_manual',
    COMMUNITY_TEXT_REVIEW_SPACE_ID: space,
    COMMUNITY_TEXT_REVIEW_REGION_ID: region,
    COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: policy,
    COMMUNITY_TEXT_REVIEW_OPERATOR: 'manual:host:reviewer',
  });
  let current: HomeAdmissionDefinition | null = null,
    revision = 0,
    currentId: string | null = null;
  const tx = client((sql, params) => {
    if (sql.includes('to_regprocedure')) return [{ present: true }];
    if (sql.includes('home_policy_protocol() protocol'))
      return [
        {
          valid: true,
          protocol: {
            version: 1,
            sourceCommit: HOME_POLICY_SOURCE,
            migration: '0177_home_policy_admission.sql',
            publicationReady: false,
          },
        },
      ];
    if (sql.includes('SELECT a.id,a.revision'))
      return current
        ? [
            {
              id: currentId,
              revision,
              definition: current,
              digest: admissionDefinitionDigest(current),
              valid_until: new Date('2099-01-01T00:00:00.000Z'),
            },
          ]
        : [];
    if (sql.startsWith('SELECT revision,admission_id'))
      return current ? [{ revision, admission_id: currentId }] : [];
    if (sql.includes('SELECT s.id,s.kind'))
      return [
        { id: space, kind: 'regional', region_id: region, region_active: true },
      ];
    if (sql.includes('SELECT id FROM whaleu_campus.operating_regions'))
      return [{ id: region }];
    if (sql === 'SELECT current_user AS actor')
      return [{ actor: 'review_role' }];
    if (sql.startsWith('INSERT INTO whaleu_community.home_policy_admissions')) {
      current = JSON.parse(params[4] as string) as HomeAdmissionDefinition;
      currentId = params[0] as string;
      revision = params[1] as number;
      return [{ valid_until: new Date('2099-01-01T00:00:00.000Z') }];
    }
    return [];
  });
  const mapped: HomeAdmissionDefinition = {
    ...definition(),
    exemptions: {
      audit: 'institution5_owner',
      attachments: 'normalized_server_facts',
      owner: 'verification_assertion_institution',
      legacyInstitution: 5,
      institutionId: policy,
      regionId: region,
      evidenceRef: 'mapped source evidence',
    },
  };
  for (const d of [mapped, definition(), mapped, definition()]) {
    const command = {
      command: 'prepare' as const,
      definition: d,
      evidenceRef: 'declared mapping',
      validForHours: 24,
    };
    const p = (await configureHomeAdmission(
      command,
      config,
      'manual:host:reviewer',
      tx,
    )) as {
      preparationId: string;
      currentRevision: number;
      previewDigest: string;
      blockers: string[];
    };
    const a = (await configureHomeAdmission(
      {
        ...command,
        command: 'apply',
        expectedRevision: p.currentRevision,
        previewDigest: p.previewDigest,
        preparationId: p.preparationId,
      },
      config,
      'manual:host:reviewer',
      tx,
    )) as { blockers: string[]; publicationReady: boolean };
    for (const blockers of [p.blockers, a.blockers])
      assert.equal(
        blockers.includes('institution5_authority_adapter_unavailable'),
        d.exemptions.audit === 'institution5_owner',
      );
    assert.equal(a.publicationReady, false);
  }
});
test('evidence is canonical without transformation and uses Unicode scalar lengths', () => {
  const mapped: HomeAdmissionDefinition = {
    ...definition(),
    exemptions: {
      audit: 'institution5_owner',
      attachments: 'normalized_server_facts',
      owner: 'verification_assertion_institution',
      legacyInstitution: 5,
      institutionId: policy,
      regionId: region,
      evidenceRef: '🦋'.repeat(500),
    },
  };
  assert.equal(homeAdmissionDefinitionSchema.safeParse(mapped).success, true);
  for (const evidenceRef of [
    '\t',
    ' padded',
    'padded ',
    'a\tb',
    '\u00a0',
    '🦋'.repeat(501),
    '\ud800',
  ])
    assert.equal(
      homeAdmissionDefinitionSchema.safeParse({
        ...mapped,
        exemptions: { ...mapped.exemptions, evidenceRef },
      }).success,
      false,
    );
});
