import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { canonicalJson } from '../src/community/content-review/canonical-json.js';
import {
  HOME_POLICY_SOURCE,
  admissionDefinitionDigest,
} from '../src/community/home-feed-policy/admission-contract.js';
import type { HomeAdmissionDefinition } from '../src/community/home-feed-policy/admission-contract.js';
import {
  HOME_PUBLICATION_CATALOG_BODY_SHA256,
  configureHomePublication,
  homeActivationCommandSchema,
} from '../src/community/home-feed-policy/activation.js';
const space = '11111111-1111-4111-8111-111111111111',
  region = '22222222-2222-4222-8222-222222222222',
  policy = '33333333-3333-4333-8333-333333333333',
  admission = '44444444-4444-4444-8444-444444444444';
const operator = 'manual:test:reviewer',
  catalog = 'e'.repeat(64);
const config = loadConfig({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://example.invalid/test',
  COMMUNITY_TEXT_REVIEW: 'source_manual',
  COMMUNITY_TEXT_REVIEW_SPACE_ID: space,
  COMMUNITY_TEXT_REVIEW_REGION_ID: region,
  COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: policy,
  COMMUNITY_TEXT_REVIEW_OPERATOR: operator,
});
const definition: HomeAdmissionDefinition = {
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
const migration = readFileSync(
  new URL('../migrations/0178_home_publication_protocol.sql', import.meta.url),
  'utf8',
);
const body = migration.match(
  /CREATE FUNCTION whaleu_community\.home_publication_catalog\(\) RETURNS text\s+LANGUAGE sql STABLE[^]*?AS \$catalog\$([^]*?)\$catalog\$/,
)?.[1];
function harness() {
  const queries: string[] = [];
  let drift = false,
    available = true,
    sourceCurrent = true;
  const preparations = new Map<string, Record<string, unknown>>();
  let head: Record<string, unknown> | null = null;
  const tx = {
    query: async (sql: string, p: unknown[] = []) => {
      queries.push(sql);
      if (
        sql.includes(
          "to_regprocedure('whaleu_community.home_publication_protocol()') IS NOT NULL",
        )
      )
        return { rows: [{ present: true }] };
      if (sql.includes('home_publication_protocol() protocol'))
        return {
          rows: [
            {
              safe: true,
              body: drift ? 'changed' : body,
              catalog,
              protocol: {
                version: 1,
                migration: '0178_home_publication_protocol.sql',
                envelopeVersions: [7, 8],
                catalogRevision: 1,
                catalog,
                publicationReady: true,
              },
            },
          ],
        };
      if (sql.startsWith('SELECT a.id,a.revision'))
        return {
          rows: [
            {
              id: admission,
              revision: 1,
              definition,
              digest: admissionDefinitionDigest(definition),
              valid_until: new Date('2099-01-01T00:00:00.000Z'),
            },
          ],
        };
      if (
        sql.startsWith(
          'SELECT valid_until FROM whaleu_community.content_approval_policies',
        )
      )
        return { rows: sourceCurrent ? [{ valid_until: null }] : [] };
      if (sql.startsWith('SELECT h.revision,h.activation_id'))
        return { rows: head ? [head] : [] };
      if (sql === 'SELECT current_user AS actor')
        return { rows: [{ actor: 'test_operator_role' }] };
      if (
        sql.startsWith(
          'SELECT whaleu_community.home_activation_payload_current',
        )
      )
        return { rows: [{ available }] };
      if (sql.startsWith('WITH instant AS')) {
        const issued_at = new Date(),
          expires_at = new Date(issued_at.getTime() + 300000),
          valid_until = new Date(
            Math.min(
              issued_at.getTime() + Number(p[2]) * 3600000,
              Date.parse(p[3] as string),
            ),
          );
        const payload = {
          ...JSON.parse(p[1] as string),
          preparationId: p[0],
          issuedAt: issued_at.toISOString(),
          expiresAt: expires_at.toISOString(),
          validUntil: valid_until.toISOString(),
        };
        const row = {
          id: p[0],
          payload,
          issued_at,
          expires_at,
          valid_until,
          digest: createHash('sha256')
            .update(
              'whaleu-home-publication-preview:v1\n' + canonicalJson(payload),
            )
            .digest('hex'),
        };
        preparations.set(p[0] as string, row);
        return { rows: [row] };
      }
      if (
        sql.startsWith(
          'SELECT p.* FROM whaleu_community.home_publication_preparations',
        )
      )
        return {
          rows: preparations.has(p[0] as string)
            ? [preparations.get(p[0] as string)]
            : [],
        };
      if (
        sql.startsWith(
          'INSERT INTO whaleu_community.home_publication_activations',
        )
      ) {
        const prepared = preparations.get(p[1] as string)!;
        head = {
          revision: p[2],
          activation_id: p[0],
          payload: prepared['payload'],
          valid_until: prepared['valid_until'],
          current: true,
        };
        preparations.delete(p[1] as string);
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return {
    tx,
    queries,
    setDrift: () => {
      drift = true;
    },
    setUnavailable: () => {
      available = false;
    },
    setPolicyMissing: () => {
      sourceCurrent = false;
    },
  };
}
test('activation pins exact formal catalog collector body', () => {
  assert.ok(body);
  assert.equal(
    createHash('sha256').update(body).digest('hex'),
    HOME_PUBLICATION_CATALOG_BODY_SHA256,
  );
});
test('unsupported reviewer configuration is rejected without publication grant', async () => {
  assert.equal(
    homeActivationCommandSchema.safeParse({
      command: 'prepare',
      validForHours: 169,
      evidenceRef: 'basis',
    }).success,
    false,
  );
  const h = harness();
  await assert.rejects(() =>
    configureHomePublication(
      { command: 'prepare', validForHours: 1, evidenceRef: 'basis' },
      { ...config, COMMUNITY_TEXT_REVIEW: 'disabled' },
      operator,
      h.tx,
    ),
  );
  assert.equal(h.queries.length, 0);
  await assert.rejects(() =>
    configureHomePublication(
      { command: 'prepare', validForHours: 1, evidenceRef: 'basis' },
      config,
      'manual:wrong:reviewer',
      h.tx,
    ),
  );
});
test('installed schema is not activation; preflight reads only and rejects catalog/policy drift', async () => {
  const h = harness();
  const before = (await configureHomePublication(
    { command: 'preflight' },
    config,
    operator,
    h.tx,
  )) as {
    catalogReady: boolean;
    canPrepare: boolean;
    publicationReady: boolean;
  };
  assert.equal(before.catalogReady, true);
  assert.equal(before.canPrepare, true);
  assert.equal(before.publicationReady, false);
  assert.equal(
    h.queries.some((q) => /INSERT|UPDATE |DELETE/.test(q)),
    false,
  );
  h.setDrift();
  const changed = (await configureHomePublication(
    { command: 'preflight' },
    config,
    operator,
    h.tx,
  )) as { canPrepare: boolean; blockers: string[] };
  assert.equal(changed.canPrepare, false);
  assert.ok(changed.blockers.includes('home_publication_catalog_drift'));
  const missing = harness();
  missing.setPolicyMissing();
  await assert.rejects(() =>
    configureHomePublication(
      { command: 'prepare', validForHours: 1, evidenceRef: 'basis' },
      config,
      operator,
      missing.tx,
    ),
  );
});
test('real command boundaries bind nonce/current config and only apply advances activation', async () => {
  const h = harness();
  const prepared = (await configureHomePublication(
    {
      command: 'prepare',
      validForHours: 1,
      evidenceRef: 'synthetic acceptance',
    },
    config,
    operator,
    h.tx,
  )) as {
    preparationId: string;
    currentRevision: number;
    previewDigest: string;
    publicationReady: boolean;
  };
  assert.equal(prepared.publicationReady, false);
  const command = {
    command: 'apply' as const,
    preparationId: prepared.preparationId,
    expectedRevision: prepared.currentRevision,
    previewDigest: prepared.previewDigest,
  };
  await assert.rejects(() =>
    configureHomePublication(
      { ...command, previewDigest: '0'.repeat(64) },
      config,
      operator,
      h.tx,
    ),
  );
  const applied = (await configureHomePublication(
    command,
    config,
    operator,
    h.tx,
  )) as {
    applied: boolean;
    publicationReady: boolean;
    explicitReviewPolicyId: null;
  };
  assert.equal(applied.applied, true);
  assert.equal(applied.publicationReady, true);
  assert.equal(applied.explicitReviewPolicyId, null);
  await assert.rejects(() =>
    configureHomePublication(command, config, operator, h.tx),
  );
  const blocked = harness();
  const p = (await configureHomePublication(
    {
      command: 'prepare',
      validForHours: 1,
      evidenceRef: 'synthetic acceptance',
    },
    config,
    operator,
    blocked.tx,
  )) as typeof prepared;
  blocked.setUnavailable();
  await assert.rejects(() =>
    configureHomePublication(
      {
        command: 'apply',
        preparationId: p.preparationId,
        expectedRevision: p.currentRevision,
        previewDigest: p.previewDigest,
      },
      config,
      operator,
      blocked.tx,
    ),
  );
});
