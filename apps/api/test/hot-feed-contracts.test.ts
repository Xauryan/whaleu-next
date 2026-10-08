import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config/config.js';
import { manualProcessingConfig } from '../src/config/manual-processing.js';
import { hotQuerySchema, HOT_RANGES } from '../src/community/hot/contracts.js';
import {
  hotAnchorFollows,
  hotPositionSchema,
  hotCursorScope,
} from '../src/community/hot/cursor.js';
import {
  currentHotScoreCertificate,
  hotScoreCertificateHash,
} from '../src/community/hot-score/certificate.js';
import { hotSnapshot, hotCertificate } from './support/hot-certificate.js';
const spaceId = randomUUID();
const env = {
  DATABASE_URL: 'postgresql://test@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
};
test('hot strict explicit-space query, six publication ranges and caps', () => {
  assert.deepEqual(hotQuerySchema.parse({ spaceId }), {
    spaceId,
    range: 'day',
    limit: 10,
  });
  assert.deepEqual(
    Object.values(HOT_RANGES).map((x) => [x.days, x.cap]),
    [
      [1, 50],
      [7, 200],
      [30, 1000],
      [180, 1000],
      [365, 1000],
      [null, 1000],
    ],
  );
  for (const extra of [
    { spaceId: spaceId.toUpperCase() },
    { limit: '11' },
    { limit: '01' },
    { limit: 1 },
    { scope: 'all' },
    { category: 'discussion' },
    { choose: 1 },
    { range: 'all' },
    { score: '0.0000' },
    { accountId: randomUUID() },
    { cursor: 'a'.repeat(43) },
  ])
    assert.equal(
      hotQuerySchema.safeParse({ spaceId, ...extra }).success,
      false,
    );
  assert.equal(
    hotQuerySchema.safeParse({
      spaceId,
      cursor: randomBytes(32).toString('base64url'),
    }).success,
    true,
  );
});
test('hot exact decimal ordering and strict private position never use lexicographic score order', () => {
  const a = { score: '10.0000', id: randomUUID() },
    b = { score: '9.9999', id: randomUUID() };
  assert.equal(hotAnchorFollows(a, b), false);
  assert.equal(hotAnchorFollows(b, a), true);
  assert.equal(
    hotAnchorFollows(
      { score: '9007199254740992.0001', id: a.id },
      { score: '9007199254740992.0002', id: a.id },
    ),
    true,
  );
  assert.equal(
    hotAnchorFollows(
      { score: '0.0000', id: '00000000-0000-4000-8000-000000000001' },
      { score: '0.0000', id: '00000000-0000-4000-8000-000000000002' },
    ),
    true,
  );
  assert.equal(
    hotPositionSchema.safeParse({
      v: 1,
      kind: 'hot',
      after: a,
      visible: null,
      emitted: 0,
    }).success,
    true,
  );
  for (const extra of [
    { emitted: 1 },
    { emitted: 1001 },
    { score: '1.0000' },
    { kind: 'search' },
  ])
    assert.equal(
      hotPositionSchema.safeParse({
        v: 1,
        kind: 'hot',
        after: a,
        visible: null,
        emitted: 0,
        ...extra,
      }).success,
      false,
    );
  const session = {
    accountId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: 9e12,
    refreshExpiresAt: 9e12,
  };
  const query = hotQuerySchema.parse({ spaceId }),
    scope = hotCursorScope(query, session);
  for (const other of [
    { ...query, range: 'week' as const },
    { ...query, spaceId: randomUUID() },
    { ...query, limit: 9 },
  ])
    assert.notEqual(hotCursorScope(other, session), scope);
  assert.notEqual(
    hotCursorScope(query, { ...session, sessionId: randomUUID() }),
    scope,
  );
  assert.notEqual(hotCursorScope(query, null), scope);
});
test('hot certificates require exact full current independent proofs; time age alone does not expire them', () => {
  const snapshot = hotSnapshot(),
    certificate = hotCertificate(snapshot);
  const later = structuredClone(snapshot);
  later.snapshotAt = '2030-01-01T00:00:00Z';
  assert.equal(currentHotScoreCertificate(certificate, later), true);
  for (const component of [
    'subscription',
    'like',
    'comment',
    'view',
  ] as const) {
    const other = structuredClone(snapshot);
    other.baselines[component] = null;
    assert.equal(currentHotScoreCertificate(certificate, other), false);
  }
  for (const mutation of [
    (s: typeof snapshot) => {
      s.states.view!.count = '1';
    },
    (s: typeof snapshot) => {
      s.states.like!.capturedHead = '1';
    },
    (s: typeof snapshot) => {
      s.states.comment!.invalidReceipt = true;
    },
    (s: typeof snapshot) => {
      s.baselines.like!.sourceRequestId = randomUUID();
    },
  ]) {
    const other = structuredClone(snapshot);
    mutation(other);
    assert.equal(currentHotScoreCertificate(certificate, other), false);
  }
  for (const patch of [
    { formula_fingerprint: '0'.repeat(64) },
    { numeric_profile_version: 2 },
    { score: '0.0001' },
    { clock_matches: false },
    { source_request_id: randomUUID() },
    { certificate_hash: '0'.repeat(64) },
  ])
    assert.equal(
      currentHotScoreCertificate({ ...certificate, ...patch }, snapshot),
      false,
    );
  const reordered = JSON.parse(
    JSON.stringify(snapshot, Object.keys(snapshot).reverse()),
  ) as typeof snapshot;
  assert.throws(() => hotScoreCertificateHash(reordered, '0.0000'));
  assert.equal(
    currentHotScoreCertificate(
      hotCertificate(snapshot, '99999999999999999999.9999'),
      snapshot,
    ),
    true,
  );
});
test('hot automatic is explicit/coherent and every selected CLI disables it', () => {
  assert.equal(loadConfig(env).HOT_FEED_PROCESSING, 'disabled');
  assert.throws(
    () => loadConfig({ ...env, HOT_FEED_PROCESSING: 'automatic' }),
    /requires automatic/,
  );
  const config = loadConfig({
    ...env,
    HOT_FEED_PROCESSING: 'automatic',
    SUBSCRIPTION_COMPONENT_PROCESSING: 'automatic',
    LIKE_COMPONENT_PROCESSING: 'automatic',
    COMMENT_COMPONENT_PROCESSING: 'automatic',
  });
  for (const owner of [
    'updates',
    'jury',
    'experience',
    'subscriptions',
    'likes',
    'comments',
    'hotScore',
  ] as const)
    assert.equal(
      manualProcessingConfig(config, owner).HOT_FEED_PROCESSING,
      'disabled',
    );
  const manual = manualProcessingConfig(config, 'hotFeed');
  assert.equal(manual.HOT_FEED_PROCESSING, 'manual_only');
  assert.equal(manual.SUBSCRIPTION_COMPONENT_PROCESSING, 'manual_only');
  assert.equal(manual.VIEW_REPORTING_RETENTION_PROCESSING, 'disabled');
});
test('read uses elapsed publication hours, current state proof and no processing/catch-up import', async () => {
  const [service, repository] = await Promise.all(
    ['service', 'repository'].map((name) =>
      readFile(
        new URL(`../src/community/hot/${name}.ts`, import.meta.url),
        'utf8',
      ),
    ),
  );
  assert.match(repository!, /make_interval\(hours=>\$4::integer\*24\)/);
  assert.doesNotMatch(repository!, /make_interval\(days/);
  assert.match(service!, /currentHotScoreCertificate/);
  assert.doesNotMatch(
    service!,
    /\.refresh\(|\.processNext\(|\.processSelected\(|\.enroll\(/,
  );
});
