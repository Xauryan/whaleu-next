import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { PublicationService } from '../src/community/publication.service.js';
import { publishPostSchema } from '../src/community/contracts.js';
import {
  canonicalEnvelope,
  approvalDigest,
} from '../src/community/content-review/contracts.js';
import type { EffectiveContentEnvelope } from '../src/community/content-review/contracts.js';
import {
  HOME_POLICY_SOURCE,
  homeAdmissionDefinitionSchema,
  admissionDefinitionDigest,
} from '../src/community/home-feed-policy/admission-contract.js';
import { verified } from './support/community-fixtures.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const space = {
  id: id(2),
  kind: 'regional' as const,
  name: 'Synthetic',
  isActive: true,
  operatingRegionId: id(3),
};
const definition = homeAdmissionDefinitionSchema.parse({
  version: 1,
  sourceCommit: HOME_POLICY_SOURCE,
  categoryMappings: [
    { nativeCategory: 'discussion', sourceKind: 'regional', legacyChoose: 2 },
    { nativeCategory: 'water', sourceKind: 'regional', legacyChoose: 9 },
  ],
  scopeMappings: [
    {
      sourceSpaceId: id(2),
      sourceKind: 'regional',
      sourceRegionId: id(3),
      targetWaterSpaceId: id(2),
      targetRegionId: id(3),
    },
  ],
  authorModes: ['named', 'anonymous'],
  exemptions: { audit: 'none', attachments: 'normalized_server_facts' },
  surfaces: { home: true, hot: 'exclude_water', following: 'excluded' },
  markdownReferences: false,
});
const ref = {
  id: id(4),
  revision: 1,
  digest: admissionDefinitionDigest(definition),
  sourceCommit: HOME_POLICY_SOURCE,
  validUntil: '2099-01-01T00:00:00.000Z',
};
function harness(active = true, rejectReview = false) {
  const writes: { sql: string; values: unknown[] }[] = [];
  let reviewed: EffectiveContentEnvelope | undefined;
  let original: unknown;
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      if (
        sql ===
        'SELECT whaleu_community.home_publication_current() AS activation'
      )
        return {
          rows: [
            {
              activation: active
                ? {
                    activationId: id(5),
                    admission: ref,
                    validUntil: ref.validUntil,
                  }
                : null,
            },
          ],
        };
      if (sql.startsWith('SELECT a.id,a.revision,a.definition'))
        return {
          rows: [
            {
              id: ref.id,
              revision: ref.revision,
              definition,
              digest: ref.digest,
              valid_until: new Date(ref.validUntil),
            },
          ],
        };
      if (
        sql.includes('pg_advisory_xact_lock') ||
        sql.includes('whaleu:safety')
      )
        return { rows: [] };
      if (sql.startsWith('INSERT INTO whaleu_community.')) {
        writes.push({ sql, values });
        return { rows: [{ published_at: new Date('2026-10-22T00:00:00Z') }] };
      }
      throw Error(`Unexpected query ${sql}`);
    },
  } as unknown as PoolClient;
  type Args = ConstructorParameters<typeof PublicationService>;
  const service = new PublicationService(
    {
      space: async () => space,
      attach: async () => {},
      event: async () => {},
      persona: async () => {},
    } as unknown as Args[0],
    { authority: async () => verified(id(3)) } as unknown as Args[1],
    {
      execute: async (
        _t: string,
        requestId: string,
        operation: string,
        intent: unknown,
        create: (actor: string, tx: PoolClient) => Promise<unknown>,
      ) => {
        original = intent;
        return {
          requestId,
          operation,
          outcome: 'created',
          ...((await create(id(1), tx)) as object),
        };
      },
    } as unknown as Args[2],
    {} as Args[3],
    {} as Args[4],
    {} as Args[5],
    { prepare: async () => {} } as unknown as Args[6],
    {
      check: async (input) => {
        reviewed = canonicalEnvelope(input.envelope);
        return {
          kind: 'allow',
          value: {
            decisionId: id(7),
            digest: approvalDigest(reviewed),
            version: reviewed.version,
            envelope: reviewed,
          },
        };
      },
      bind: async () => {},
    } as Args[7],
    {} as Args[8],
    {
      requireEnvelope: async () => {
        if (rejectReview) throw Error('review unavailable');
      },
      requireRequest: async () => {},
      requireBinding: async () => {},
    } as unknown as Args[9],
  );
  return {
    service,
    writes,
    reviewed: () => reviewed,
    original: () => original,
  };
}
function body(text = 'abc') {
  return publishPostSchema.parse({
    clientRequestId: id(8),
    spaceId: space.id,
    category: 'discussion',
    text,
    imageAssetIds: [],
    authorMode: 'named',
    commentsPolicy: 'open',
    textSource: { version: 1, format: 'plain', readingFormatting: 'auto' },
  });
}
test('actual publication stages V7 Home evidence before source/binding and preserves requested intent', async () => {
  const h = harness();
  await h.service.post('synthetic', body());
  assert.equal(h.reviewed()?.version, 7);
  assert.equal(h.reviewed()?.category, 'water');
  assert.equal((h.original() as { category: string }).category, 'discussion');
  const post = h.writes.find((w) =>
    w.sql.startsWith('INSERT INTO whaleu_community.posts'),
  )!;
  assert.equal(post.values[3], 'water');
  assert.equal(post.values[7], 7);
  const home = h.writes.findIndex((w) =>
    w.sql.includes('home_post_dispositions'),
  );
  const source = h.writes.findIndex((w) =>
    w.sql.includes('community_text_sources'),
  );
  assert.ok(home >= 0 && source > home);
  assert.equal(
    JSON.parse(String(h.writes[home]!.values[3])).requestedIntent.category,
    'discussion',
  );
});
test('no activation preserves original source V6 lane and no Home evidence', async () => {
  const h = harness(false);
  await h.service.post('synthetic', body('ordinary long source'));
  assert.equal(h.reviewed()?.version, 6);
  assert.equal(h.reviewed()?.category, 'discussion');
  assert.equal(
    h.writes.some((w) => w.sql.includes('home_post_dispositions')),
    false,
  );
});
test('Home Review rejection happens before any publication writes', async () => {
  const h = harness(true, true);
  await assert.rejects(
    () => h.service.post('synthetic', body()),
    /review unavailable/,
  );
  assert.equal(h.writes.length, 0);
});
