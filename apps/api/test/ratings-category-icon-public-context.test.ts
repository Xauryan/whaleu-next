import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { RatingScopedContextService } from '../src/ratings/scoped/context.service.js';
import { ratingScopedContextSchema } from '../src/ratings/scoped/contracts.js';
import { ratingScopedDigest } from '../src/ratings/scoped/protocol-registry.js';
import { categoryIconDigest } from '../src/ratings/category-management/icon-extension.js';
import { ratingCategoryIconPublicContextSchema } from '../src/ratings/category-management/icon-public-contracts.js';

const id = (n: number) =>
  `96000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = 'a'.repeat(64),
  request = {
    purpose: 'read' as const,
    mode: 'public' as const,
    selector: { kind: 'global' as const },
  };
function fixture() {
  const now = new Date('2026-10-10T00:00:00.000Z'),
    until = new Date(now.getTime() + 600000);
  const sourceDigest = ratingScopedDigest('vector', []);
  const sql: string[] = [];
  const state = { current: true, registered: true, mediaSnapshot: digest };
  const rows: {
    id: string;
    account_id: string;
    session_id: string;
    token_digest: string;
    context: Record<string, unknown>;
    authority: Record<string, unknown>;
    protocol_tuples: unknown;
    issued_at: Date;
    valid_until: Date;
  }[] = [];
  const protocol = { scopeKey: 'global', versionId: id(4), generation: id(5) };
  const head = {
    scopeKey: 'global',
    catalogId: id(6),
    headRevision: id(7),
    releaseId: id(8),
  };
  const session = {
    accountId: id(1),
    sessionId: id(2),
    expiresAt: until.getTime(),
    refreshExpiresAt: until.getTime(),
  };
  const tx = {
    query: async (query: string, values: unknown[] = []) => {
      sql.push(query);
      if (query.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (query.includes("SELECT 'source' kind"))
        return {
          rows: [
            { kind: 'protocol', singleton: true, version: 1, epoch: '1' },
            { kind: 'source', singleton: true, version: 1, epoch: '1' },
          ],
        };
      if (query.includes("s.source_kind='scope_capabilities'"))
        return { rows: [{ ...protocol, valid: true, valid_until: until }] };
      if (query.includes('whaleu_ratings.scoped_catalog_current'))
        return {
          rows: [
            {
              id: head.catalogId,
              scope_key: 'global',
              campus_id: null,
              region_id: null,
              head_revision: head.headRevision,
              release_id: head.releaseId,
              source_digest: sourceDigest,
              valid: true,
              valid_until: until,
            },
          ],
        };
      if (query.includes("'extensions',"))
        return {
          rows: [{ state: { epoch: '1', heads: [head], extensions: [] } }],
        };
      if (query.includes('SELECT c.id,c.protocol_version_id,c.source_digest'))
        return {
          rows: state.registered
            ? [
                {
                  id: id(9),
                  protocol_version_id: protocol.versionId,
                  source_digest: digest,
                  valid_until: until,
                  current: state.current,
                },
              ]
            : [],
        };
      if (query.includes('category_icon_snapshot('))
        return { rows: [{ snapshot: state.mediaSnapshot }] };
      if (query.includes('SELECT scope_key "scopeKey"'))
        return { rows: [head] };
      if (query.includes('SELECT h.logical_scope_key "scopeKey"'))
        return { rows: [protocol] };
      if (query === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now }] };
      if (query.includes('INSERT INTO whaleu_ratings.scoped_contexts')) {
        const row = {
          id: values[0] as string,
          account_id: values[1] as string,
          session_id: values[2] as string,
          token_digest: values[3] as string,
          context: JSON.parse(values[4] as string) as Record<string, unknown>,
          authority: JSON.parse(values[5] as string) as Record<string, unknown>,
          protocol_tuples: JSON.parse(values[6] as string) as unknown,
          issued_at: values[7] as Date,
          valid_until: values[8] as Date,
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (query.startsWith('SELECT * FROM whaleu_ratings.scoped_contexts'))
        return {
          rows: rows.filter(
            (row) => row.id === values[0] && row.token_digest === values[1],
          ),
        };
      if (query.includes('c.record_digest digest'))
        return {
          rows: rows.map((row) => ({
            id: row.id,
            account_id: row.account_id,
            session_id: row.session_id,
            token_digest: row.token_digest,
            valid: true,
            digest: (row.context['protocolVersion'] === 5
              ? categoryIconDigest
              : ratingScopedDigest)('context-record', {
              context: row.context,
              authority: row.authority,
              protocolTuples: row.protocol_tuples,
            }),
          })),
        };
      if (
        query.startsWith('LOCK TABLE') ||
        query.startsWith('SELECT set_config') ||
        query === 'SET CONSTRAINTS ALL IMMEDIATE' ||
        query.startsWith('SELECT singleton,version,epoch') ||
        query.startsWith('SELECT epoch FROM whaleu_ratings.category_icon_epoch')
      )
        return { rows: [] };
      throw new Error(`Unexpected query: ${query}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const campus = {
    scopeKeys: ['global'],
    mappings: [],
    fingerprint: digest,
    inventoryFingerprint: digest,
    topologySnapshotId: null,
    origin: null,
    identity: null,
    authorization: [],
    validUntil: until.getTime(),
  };
  const owner = Object.create(
    RatingScopedContextService.prototype,
  ) as RatingScopedContextService;
  Object.assign(owner, {
    access: {
      authenticate: async () => session,
      resolveAccount: async () => ({ fingerprint: digest }),
      recheck: async () => undefined,
    },
    verification: {
      phone: async () => ({ status: 'verified', fingerprint: digest }),
    },
    campus: { resolveNavigation: async () => campus },
    sources: {
      readExactSourceVector: async () => ({
        rows: [],
        vector: [],
        validUntil: until.getTime(),
        budget: { snapshot: () => ({ bytes: 0 }) },
      }),
    },
    review: { navigation: async () => digest },
  });
  return { owner, tx, sql, rows, state, session, head, protocol };
}

test('public5 issues original scoped shape with exact Category authority and no unrelated media capabilities', async () => {
  const f = fixture(),
    context = await f.owner.createCategoryIcon('session', request, f.tx);
  assert.equal(context.protocolVersion, 5);
  assert.equal(context.mediaSnapshot, digest);
  assert.deepEqual(context.capabilities, ['read', 'category_icon']);
  assert.equal(context.actorId, f.session.accountId);
  assert.equal(
    context.sessionGeneration,
    ratingScopedDigest('session', {
      ...{
        accountId: f.session.accountId,
        sessionId: f.session.sessionId,
        expiresAt: f.session.expiresAt,
      },
      tokenDigest: createHash('sha256').update('session').digest('hex'),
    }),
  );
  assert.deepEqual(context.heads, [
    {
      scopeKey: 'global',
      catalogRevision: f.head.catalogId,
      headRevision: f.head.headRevision,
    },
  ]);
  assert.equal(
    f.rows[0]!.authority['contextAuthority'],
    'ratings-category-icon-context-v1',
  );
  assert.deepEqual(f.rows[0]!.authority['categoryIconCapabilities'], [
    {
      id: id(9),
      protocolVersionId: f.protocol.versionId,
      sourceDigest: digest,
      current: true,
      validUntil: '2026-10-10T00:10:00.000Z',
    },
  ]);
  assert.equal(
    f.sql.some(
      (sql) =>
        sql.includes('target_cover_') || sql.includes('discussion_media_'),
    ),
    false,
  );
  const { mediaSnapshot, ...body } = context;
  assert.equal(mediaSnapshot, digest);
  assert.equal(
    ratingScopedContextSchema.safeParse({ ...body, protocolVersion: 2 })
      .success,
    true,
  );
  assert.equal(ratingScopedContextSchema.safeParse(context).success, false);
  await checkTransactionDeadlines(f.tx);
});

test('public5 refuses absent or held exact Category capability instead of issuing a legacy context', async () => {
  for (const patch of [{ registered: false }, { current: false }]) {
    const f = fixture();
    Object.assign(f.state, patch);
    await assert.rejects(f.owner.createCategoryIcon('session', request, f.tx), {
      code: 'RATING_SCOPE_UNAVAILABLE',
    });
    assert.equal(f.rows.length, 0);
  }
});

test('legacy context issuance preserves its exact fields and never reads Category registration tables', async () => {
  const f = fixture(),
    context = await f.owner.create('session', request, f.tx);
  assert.equal(context.protocolVersion, 2);
  assert.deepEqual(context.capabilities, ['read']);
  assert.equal('mediaSnapshot' in context, false);
  assert.equal('contextAuthority' in f.rows[0]!.authority, false);
  assert.equal(
    f.sql.some(
      (sql) => sql.includes('category_icon_') || sql.includes('to_regclass'),
    ),
    false,
  );
  await checkTransactionDeadlines(f.tx);
});

test('protocol5 resolves only its own context and rechecks the media snapshot', async () => {
  const f = fixture(),
    context = await f.owner.createCategoryIcon('session', request, f.tx);
  const query = { contextId: context.id, contextToken: context.token };
  const scope = await f.owner.resolve('session', query, f.tx, {
    purpose: 'read',
    protocolVersion: 5,
  });
  assert.equal(scope.context.protocolVersion, 5);
  assert.equal(scope.targetCoverCapable, false);
  await assert.rejects(f.owner.resolve('session', query, f.tx), {
    code: 'RATING_SCOPE_UNAVAILABLE',
  });
  f.state.mediaSnapshot = 'b'.repeat(64);
  await assert.rejects(
    f.owner.resolve('session', query, f.tx, { protocolVersion: 5 }),
    { code: 'RATING_SCOPED_CONTEXT_CHANGED' },
  );
});

test('public5 wire validation rejects missing snapshot, capability and legacy relabeling', async () => {
  const f = fixture(),
    context = await f.owner.createCategoryIcon('session', request, f.tx);
  for (const value of [
    { ...context, mediaSnapshot: undefined },
    { ...context, capabilities: ['read', 'target_cover'] },
    { ...context, protocolVersion: 3 },
    { ...context, discussionMedia: {} },
  ])
    assert.equal(
      ratingCategoryIconPublicContextSchema.safeParse(value).success,
      false,
    );
});
