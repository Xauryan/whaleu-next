import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { CommunityExperienceSourceFacade } from '../src/community/experience-source/facade.js';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import type {
  AccountState,
  ExperienceRepository,
  WorkRow,
} from '../src/experience/repository.js';
import type { ExperienceSettlementService } from '../src/experience/settlement.js';
import type {
  ExperienceSourceUnit,
  RoutedExperienceSourceUnit,
} from '../src/experience/source-contracts.js';
import { ExperienceSourceModule } from '../src/experience/source-module.js';
import { ExperienceSourceRouter } from '../src/experience/source-router.js';
import { ExperienceWorker } from '../src/experience/worker.js';
import { RatingExperienceSourceFacade } from '../src/ratings/experience-source/facade.js';

const unit: ExperienceSourceUnit = {
  unitId: randomUUID(),
  groupId: randomUUID(),
  beneficiaryId: randomUUID(),
  action: 'received_comment',
  occurredAt: '2026-10-08 23:59:59.123456+00',
  sourceKind: 'rating_event',
  sourceId: randomUUID(),
};
const reference = {
  unitId: unit.unitId,
  groupId: unit.groupId,
  beneficiaryId: unit.beneficiaryId,
  action: unit.action,
  enrollmentOrder: '9007199254740993',
  sourceDomain: 'ratings' as const,
  sourceVersion: 1,
};
const routed: RoutedExperienceSourceUnit = {
  ...unit,
  sourceDomain: reference.sourceDomain,
  enrollmentOrder: reference.enrollmentOrder,
};

function routerFixture(
  registry: object | null = reference,
  source: ExperienceSourceUnit | null = unit,
) {
  const calls: string[] = [];
  const queries: { sql: string; args: unknown[] | undefined }[] = [];
  const tx = {
    query: async (sql: string, args?: unknown[]) => {
      queries.push({ sql, args });
      calls.push('registry');
      return { rows: registry ? [registry] : [] };
    },
  } as unknown as PoolClient;
  const facade = (domain: string) => ({
    loadUnit: async (id: string, client: PoolClient) => {
      assert.equal(id, unit.unitId);
      assert.equal(client, tx);
      calls.push(`${domain}:load`);
      return source;
    },
    acknowledge: async (id: string, settlement: string, client: PoolClient) => {
      assert.equal(id, unit.unitId);
      assert.equal(settlement, 'settlement');
      assert.equal(client, tx);
      calls.push(`${domain}:ack`);
    },
  });
  const router = new ExperienceSourceRouter(
    facade('community') as CommunityExperienceSourceFacade,
    facade('ratings') as RatingExperienceSourceFacade,
  );
  return { router, tx, calls, queries };
}

test('typed rating source preserves exact event identity, microseconds and enrollment precision', async () => {
  const f = routerFixture();
  assert.deepEqual(await f.router.loadUnit(unit.unitId, f.tx), routed);
  assert.deepEqual(f.calls, ['registry', 'ratings:load']);
  assert.deepEqual(f.queries[0]!.args, [unit.unitId]);
  assert.match(f.queries[0]!.sql, /g\.source_version=1/);
  assert.match(
    f.queries[0]!.sql,
    /source_domain='community' AND g\.source_version=1/,
  );
  assert.match(
    f.queries[0]!.sql,
    /source_domain='ratings' AND g\.source_version IN \(1,2\)/,
  );
  assert.match(f.queries[0]!.sql, /u\.rating_unit_id=u\.unit_id/);
  assert.match(f.queries[0]!.sql, /g\.community_group_id IS NULL/);
  assert.doesNotMatch(f.queries[0]!.sql, /FOR (UPDATE|SHARE)/);
});

for (const action of ['like_save', 'received_like_save'] as const)
  test(`ratings v2 ${action} follows the exact registered immutable source`, async () => {
    const source = { ...unit, action };
    const f = routerFixture({ ...reference, action, sourceVersion: 2 }, source);
    assert.deepEqual(await f.router.loadUnit(unit.unitId, f.tx), {
      ...source,
      sourceDomain: 'ratings',
      enrollmentOrder: reference.enrollmentOrder,
    });
    assert.deepEqual(f.calls, ['registry', 'ratings:load']);
  });

for (const [sourceDomain, sourceVersion] of [
  ['community', 2],
  ['community', 0],
  ['ratings', 0],
  ['ratings', 3],
] as const)
  test(`unsupported ${sourceDomain} v${sourceVersion} fails before any domain probe`, async () => {
    const f = routerFixture({ ...reference, sourceDomain, sourceVersion });
    assert.equal(await f.router.loadUnit(unit.unitId, f.tx), null);
    assert.deepEqual(f.calls, ['registry']);
  });

for (const kind of ['community_outbox', 'saved_obligation'] as const)
  test(`community ${kind} keeps its original source and acknowledgement path`, async () => {
    const f = routerFixture(
      { ...reference, sourceDomain: 'community' },
      { ...unit, sourceKind: kind },
    );
    const source = await f.router.loadUnit(unit.unitId, f.tx);
    assert.ok(source);
    assert.equal(source.sourceKind, kind);
    assert.equal(source.sourceId, unit.sourceId);
    await f.router.acknowledge(source, 'settlement', f.tx);
    assert.deepEqual(f.calls, ['registry', 'community:load', 'community:ack']);
  });

test('rating acknowledgement uses the already resolved domain without rereading the registry', async () => {
  const f = routerFixture();
  await f.router.acknowledge(routed, 'settlement', f.tx);
  assert.deepEqual(f.calls, ['ratings:ack']);
  assert.equal(f.queries.length, 0);
});

for (const registry of [
  null,
  { ...reference, unitId: randomUUID() },
  { ...reference, sourceDomain: 'unknown' },
])
  test(`missing or invalid bridge never probes another source: ${JSON.stringify(registry?.sourceDomain ?? null)}`, async () => {
    const f = routerFixture(registry);
    assert.equal(await f.router.loadUnit(unit.unitId, f.tx), null);
    assert.deepEqual(f.calls, ['registry']);
  });

test('missing rating source never falls back to a colliding community UUID', async () => {
  const f = routerFixture(reference, null);
  assert.equal(await f.router.loadUnit(unit.unitId, f.tx), null);
  assert.deepEqual(f.calls, ['registry', 'ratings:load']);
});

for (const [field, value] of [
  ['unitId', randomUUID()],
  ['groupId', randomUUID()],
  ['beneficiaryId', randomUUID()],
  ['action', 'comment'],
  ['sourceKind', 'saved_obligation'],
] as const)
  test(`rating source ${field} mismatch fails closed`, async () => {
    const f = routerFixture(reference, { ...unit, [field]: value });
    assert.equal(await f.router.loadUnit(unit.unitId, f.tx), null);
    assert.deepEqual(f.calls, ['registry', 'ratings:load']);
  });

test('community bridge cannot consume a rating source', async () => {
  const f = routerFixture({ ...reference, sourceDomain: 'community' });
  assert.equal(await f.router.loadUnit(unit.unitId, f.tx), null);
  assert.deepEqual(f.calls, ['registry', 'community:load']);
});

test('acknowledgement rejects mismatched source kinds without dispatching', async () => {
  const f = routerFixture();
  await assert.rejects(
    f.router.acknowledge(
      { ...routed, sourceKind: 'saved_obligation' },
      'settlement',
      f.tx,
    ),
    /domain does not match/,
  );
  await assert.rejects(
    f.router.acknowledge(
      { ...routed, sourceDomain: 'community' },
      'settlement',
      f.tx,
    ),
    /domain does not match/,
  );
  assert.deepEqual(f.calls, []);
});

test('source module resolves without importing either mutable business module', async () => {
  const module = await Test.createTestingModule({
    imports: [ExperienceSourceModule],
  }).compile();
  try {
    assert.ok(module.get(ExperienceSourceRouter));
    assert.ok(module.get(RatingExperienceSourceFacade));
  } finally {
    await module.close();
  }
});

test('rating facade reads immutable captured facts only and preserves SQL source time', async () => {
  const calls: { sql: string; args: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, args: unknown[]) => {
      calls.push({ sql, args });
      return { rows: [unit] };
    },
  } as unknown as PoolClient;
  const facade = new RatingExperienceSourceFacade();
  assert.deepEqual(await facade.loadUnit(unit.unitId, tx), unit);
  const query = calls[0]!;
  assert.deepEqual(query.args, [unit.unitId]);
  assert.match(query.sql, /g\.occurred_at::text/);
  assert.match(query.sql, /u\.event_id AS "sourceId"/);
  assert.match(query.sql, /g\.event_id,g\.enrollment_order/);
  assert.match(query.sql, /g\.source_version=1 AND g\.event_kind IN/);
  assert.match(
    query.sql,
    /g\.source_version=2 AND g\.event_kind='content_liked'/,
  );
  assert.match(query.sql, /g\.like_transition_id IS NOT NULL/);
  assert.match(query.sql, /g\.subject_author_mode IN \('named','anonymous'\)/);
  assert.match(query.sql, /u\.action IN \('like_save','received_like_save'\)/);
  assert.doesNotMatch(query.sql, /content_unliked/);
  assert.doesNotMatch(
    query.sql,
    /whaleu_(identity|safety|profile|review)|whaleu_ratings\.(targets|comments|replies)|deleted_at|FOR (UPDATE|SHARE)/,
  );
});

test('rating acknowledgement requires real matching settlement and never mutates saved obligations', async () => {
  const calls: { sql: string; args: unknown[] }[] = [];
  let valid = false;
  const tx = {
    query: async (sql: string, args: unknown[]) => {
      calls.push({ sql, args });
      return { rows: valid ? [{ unit_id: unit.unitId }] : [] };
    },
  } as unknown as PoolClient;
  const facade = new RatingExperienceSourceFacade();
  await assert.rejects(
    facade.acknowledge(unit.unitId, 'settlement', tx),
    /settlement does not match/,
  );
  valid = true;
  await facade.acknowledge(unit.unitId, 'settlement', tx);
  assert.equal(calls.length, 2);
  const query = calls[1]!;
  assert.deepEqual(query.args, [unit.unitId, 'settlement']);
  assert.match(query.sql, /s\.unit_id,s\.owner_id,s\.action/);
  assert.match(
    query.sql,
    /w\.unit_id,w\.group_id,w\.beneficiary_id,w\.action,w\.enrollment_order/,
  );
  assert.match(query.sql, /su\.source_domain=sg\.source_domain/);
  assert.doesNotMatch(
    query.sql,
    /UPDATE|INSERT|DELETE|saved_obligations|FOR SHARE/,
  );
});

function workerFixture(
  options: {
    source?: RoutedExperienceSourceUnit | null;
    work?: Partial<WorkRow>;
    baseline?: boolean;
    predecessor?: boolean;
    ackFailure?: boolean;
  } = {},
) {
  const events: string[] = [];
  const work: WorkRow = {
    unit_id: unit.unitId,
    group_id: unit.groupId,
    beneficiary_id: unit.beneficiaryId,
    action: unit.action,
    enrollment_order: reference.enrollmentOrder,
    state: 'pending',
    ...options.work,
  };
  const tx = {
    host: '127.0.0.1',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async (sql: string) => {
      if (sql.includes('current_database'))
        return { rows: [{ name: 'whaleu_test' }] };
      if (sql.startsWith('SELECT unit_id FROM whaleu_experience.work'))
        return { rows: [{ unit_id: unit.unitId }] };
      if (sql.includes('FROM whaleu_experience.owners')) events.push('owner');
      else if (sql.includes("SET state='completed'")) events.push('completed');
      else if (sql.includes("SET state='blocked_baseline'"))
        events.push('blockedBaseline');
      else if (sql.includes('attempts=')) events.push('retry');
      else throw new Error(`Unexpected SQL: ${sql}`);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(action: (client: PoolClient) => Promise<T>) =>
      action(tx),
  } as DatabaseService;
  const source = {
    loadUnit: async () => {
      events.push('source');
      return options.source === undefined ? routed : options.source;
    },
    acknowledge: async (input: RoutedExperienceSourceUnit) => {
      events.push('ack');
      assert.deepEqual(input, routed);
      if (options.ackFailure)
        throw new Error('Synthetic acknowledgement failure');
    },
  } as unknown as ExperienceSourceRouter;
  const records = {
    work: async () => {
      events.push('work');
      return work;
    },
    first: async () => {
      events.push('first');
      return options.predecessor ? { ...work, unit_id: randomUUID() } : work;
    },
    state: async () => {
      events.push('baseline');
      return options.baseline === false
        ? null
        : ({ balance: '0' } as AccountState);
    },
  } as unknown as ExperienceRepository;
  const settlement = {
    source: async (input: RoutedExperienceSourceUnit) => {
      events.push('settlement');
      assert.deepEqual(input, routed);
      return { settlementId: 'settlement' };
    },
  } as unknown as ExperienceSettlementService;
  const config = loadConfig({
    DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/whaleu_test',
    PG_SSL_MODE: 'disable',
    NODE_ENV: 'test',
    EXPERIENCE_PROCESSING: 'manual_only',
  });
  return {
    worker: new ExperienceWorker(config, database, source, records, settlement),
    events,
  };
}

test('worker resolves source before owner and acknowledges after settlement before completion', async () => {
  const f = workerFixture();
  const result = await f.worker.run({ mode: 'apply', unitIds: [unit.unitId] });
  assert.equal(result.settled, 1);
  assert.deepEqual(f.events, [
    'source',
    'owner',
    'work',
    'first',
    'baseline',
    'settlement',
    'ack',
    'completed',
  ]);
});

for (const [field, value] of [
  ['unit_id', randomUUID()],
  ['group_id', randomUUID()],
  ['beneficiary_id', randomUUID()],
  ['action', 'comment'],
  ['enrollment_order', '9007199254740994'],
] as const)
  test(`worker rejects ${field} work mismatch before settlement`, async () => {
    const f = workerFixture({ work: { [field]: value } });
    const result = await f.worker.run({
      mode: 'apply',
      unitIds: [unit.unitId],
    });
    assert.equal(result.sourceUnavailable, 1);
    assert.deepEqual(f.events, ['source', 'owner', 'work', 'retry']);
  });

test('unknown source remains retryable and never takes an owner lock', async () => {
  const f = workerFixture({ source: null });
  const result = await f.worker.run({ mode: 'apply', unitIds: [unit.unitId] });
  assert.equal(result.sourceUnavailable, 1);
  assert.deepEqual(f.events, ['source', 'retry']);
});

test('unknown baseline remains blocked without settlement or inferred zero', async () => {
  const f = workerFixture({ baseline: false });
  const result = await f.worker.run({ mode: 'apply', unitIds: [unit.unitId] });
  assert.equal(result.blockedBaseline, 1);
  assert.deepEqual(f.events, [
    'source',
    'owner',
    'work',
    'first',
    'baseline',
    'blockedBaseline',
  ]);
});

test('owner predecessor remains blocking across source domains', async () => {
  const f = workerFixture({ predecessor: true });
  const result = await f.worker.run({ mode: 'apply', unitIds: [unit.unitId] });
  assert.equal(result.blockedPredecessor, 1);
  assert.deepEqual(f.events, ['source', 'owner', 'work', 'first', 'retry']);
});

test('dry-run performs no settlement, acknowledgement, completion or retry writes', async () => {
  const f = workerFixture();
  const result = await f.worker.run({ unitIds: [unit.unitId] });
  assert.equal(result.pending, 1);
  assert.deepEqual(f.events, ['source', 'owner', 'work', 'first', 'baseline']);
});

test('failed acknowledgement never marks work completed', async () => {
  const f = workerFixture({ ackFailure: true });
  const result = await f.worker.run({ mode: 'apply', unitIds: [unit.unitId] });
  assert.equal(result.failed, 1);
  assert.deepEqual(f.events, [
    'source',
    'owner',
    'work',
    'first',
    'baseline',
    'settlement',
    'ack',
    'retry',
  ]);
});

test('completed work never awards or acknowledges a second time', async () => {
  const f = workerFixture({ work: { state: 'completed' } });
  const result = await f.worker.run({ mode: 'apply', unitIds: [unit.unitId] });
  assert.equal(result.completed, 1);
  assert.deepEqual(f.events, ['source', 'owner', 'work']);
});
