/** Federated-only disposable fixtures. Existing explicit search coverage is kept
 * unchanged. Synthetic approvals use the same guarded canonical fixture owners. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import type { PostView } from '../../src/community/contracts.js';
import type { SearchHarness, SearchWorld } from './search-fixtures.js';

export type SearchSelector = 'all' | 'regional' | 'global';
export interface AggregatePosition {
  v: 2;
  kind: string;
  matcherId: string;
  membershipFingerprint: string;
  after: { at: string; id: string };
  visible: { at: string; id: string } | null;
}
export const ids = (body: { items: PostView[] }) =>
  body.items.map((item) => item.id);
export const instant = (index: number) =>
  new Date(Date.UTC(2026, 9, 1) - index * 1000).toISOString();
export const trading = {
  subtype: 'shuma' as const,
  price: '12.5',
  urgency: 'normal' as const,
  location: 'Synthetic location',
  contacts: { wechat: 'private-federated-contact', qq: '', phone: '' },
};
export function pageShape(
  body: { items: PostView[]; nextCursor: string | null; continuation: string },
  limit = 10,
) {
  assert.deepEqual(Object.keys(body).sort(), [
    'continuation',
    'items',
    'nextCursor',
  ]);
  assert.ok(body.items.length <= limit);
  assert.equal(new Set(ids(body)).size, body.items.length);
  if (
    ['end', 'login_required', 'phone_verification_required'].includes(
      body.continuation,
    )
  )
    assert.equal(body.nextCursor, null);
  else
    assert.match(
      body.nextCursor ?? '',
      /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,
    );
  if (body.continuation === 'more') assert.equal(body.items.length, limit);
  if (body.continuation === 'scan_pending')
    assert.ok(body.items.length < limit);
}
export function search(
  h: SearchHarness,
  query: Record<string, unknown> = {},
  viewer: { accessToken: string } | null = null,
) {
  const call = request(h.http)
    .get('/v1/community/search')
    .query({ scope: 'all', q: 'needle', ...query });
  return viewer
    ? call.set('Authorization', `Bearer ${viewer.accessToken}`)
    : call;
}
export async function freshWorld(h: SearchHarness) {
  await h.mutate((tx) =>
    tx.query(
      'UPDATE whaleu_community.spaces SET is_active=false WHERE is_active',
    ),
  );
  const w = await h.world();
  return {
    ...w,
    aggregate: (
      query: Record<string, unknown> = {},
      viewer: { accessToken: string } | null = w.reader,
    ) => search(h, query, viewer),
  };
}
export async function position(
  h: SearchHarness,
  cursor: string,
): Promise<AggregatePosition> {
  assert.match(cursor, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  const row = (
    await h.pool.query<{ position: AggregatePosition }>(
      'SELECT position FROM whaleu_community.discovery_cursors WHERE cursor=$1',
      [cursor],
    )
  ).rows[0];
  assert.ok(row);
  assert.deepEqual(Object.keys(row.position).sort(), [
    'after',
    'kind',
    'matcherId',
    'membershipFingerprint',
    'v',
    'visible',
  ]);
  assert.equal(row.position.v, 2);
  assert.equal(row.position.kind, 'search');
  assert.equal(
    row.position.matcherId,
    `unicode-lower-substring-v1:${process.versions['unicode']}`,
  );
  assert.match(row.position.membershipFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(
    Buffer.byteLength(JSON.stringify(row.position)) < 512,
    'Fixed-size metadata, never retained catalog or body',
  );
  for (const coordinate of [row.position.after, row.position.visible])
    if (coordinate) {
      assert.deepEqual(Object.keys(coordinate).sort(), ['at', 'id']);
      assert.match(coordinate.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    }
  return row.position;
}
export async function addSpace(
  h: SearchHarness,
  kind: 'regional' | 'global' = 'global',
  active = true,
) {
  const spaceId = randomUUID(),
    regionId = kind === 'regional' ? randomUUID() : null;
  await h.mutate(async (tx) => {
    if (regionId)
      await tx.query(
        'INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,$2,true)',
        [regionId, 'Synthetic unmapped region'],
      );
    await tx.query(
      'INSERT INTO whaleu_community.spaces(id,kind,operating_region_id,name,is_active) VALUES($1,$2,$3,$4,$5)',
      [spaceId, kind, regionId, 'Synthetic extra community', active],
    );
  });
  return { spaceId, regionId };
}
export async function addCatalog(h: SearchHarness, count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({
    space: randomUUID(),
    region: i % 2 ? null : randomUUID(),
  }));
  await h.mutate(async (tx) => {
    await tx.query(
      "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) SELECT x.region,'Synthetic catalog region',true FROM jsonb_to_recordset($1::jsonb) AS x(region uuid) WHERE x.region IS NOT NULL",
      [JSON.stringify(rows)],
    );
    await tx.query(
      "INSERT INTO whaleu_community.spaces(id,kind,operating_region_id,name,is_active) SELECT x.space,CASE WHEN x.region IS NULL THEN 'global' ELSE 'regional' END,x.region,'Synthetic catalog community',true FROM jsonb_to_recordset($1::jsonb) AS x(space uuid,region uuid)",
      [JSON.stringify(rows)],
    );
  });
  return rows;
}
export async function waitForLock(pool: Pool, pid: number, label: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await pool.query<{ waiting: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') AS waiting",
      [pid],
    );
    if (value.rows[0]!.waiting) return;
    await sleep(5);
  }
  assert.fail(`No actual PostgreSQL lock wait: ${label}`);
}
export async function backendPid(tx: PoolClient) {
  return (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
    .rows[0]!.pid;
}
export const scopeIds = (w: SearchWorld) => [
  w.scope.home.spaceId,
  w.scope.related.spaceId,
  w.scope.foreign.spaceId,
  w.scope.global.spaceId,
];
