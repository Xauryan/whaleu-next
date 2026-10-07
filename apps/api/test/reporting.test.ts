import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import {
  reportRequestSchema,
  juryVoteSchema,
} from '../src/safety/reporting/contracts.js';
import { juryOutcome } from '../src/safety/reporting/settlement.js';
import {
  JuryDispatcher,
  JuryWorker,
  parseJuryCommand,
  assertLocalJuryWorker,
} from '../src/safety/reporting/worker.js';
import { AuthorizationReportWeightSource } from '../src/authorization/report-weight.source.js';
import type { AuthorizationService } from '../src/authorization/authorization.service.js';
import {
  startTransactionDeadlines,
  checkpointTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
});
test('strict report/vote command shapes use independent durable UUIDs without owner/reason/weight overrides', () => {
  const target = { kind: 'post', id: randomUUID() },
    report = { clientRequestId: randomUUID(), target },
    vote = {
      clientRequestId: randomUUID(),
      postId: target.id,
      juryId: randomUUID(),
      vote: 'remove',
    };
  assert.ok(reportRequestSchema.safeParse(report).success);
  assert.ok(juryVoteSchema.safeParse(vote).success);
  for (const extra of [
    { weight: 5 },
    { reason: 'why' },
    { ownerAccountId: randomUUID() },
    { campusId: randomUUID() },
  ])
    assert.equal(
      reportRequestSchema.safeParse({ ...report, ...extra }).success,
      false,
    );
  assert.equal(
    juryVoteSchema.safeParse({ ...vote, vote: 'delete' }).success,
    false,
  );
  assert.equal(
    juryVoteSchema.safeParse({ ...vote, jurorId: randomUUID() }).success,
    false,
  );
});
test('deterministic jury threshold: six-side closes, strict deadline majority, ties and zero keep', () => {
  assert.equal(juryOutcome(5, 5, false), null);
  assert.equal(juryOutcome(6, 5, false), 'kept');
  assert.equal(juryOutcome(5, 6, false), 'removed');
  assert.equal(juryOutcome(0, 0, true), 'kept');
  assert.equal(juryOutcome(4, 4, true), 'kept');
  assert.equal(juryOutcome(2, 3, true), 'removed');
  assert.equal(juryOutcome(3, 2, true), 'kept');
});
test('weight uses real selected authority only and keeps regional/global unknown separate from ordinary members', () => {
  const source = new AuthorizationReportWeightSource(
      {} as AuthorizationService,
    ),
    tx = {} as PoolClient,
    region = randomUUID();
  startTransactionDeadlines(tx);
  try {
    assert.deepEqual(
      source.resolve([], { kind: 'global', operatingRegionId: null }, tx),
      { weight: 1, grantId: null, scopeEvidence: null },
    );
    const scoped = {
      id: randomUUID(),
      role: 'school_admin' as const,
      operatingRegionId: region,
      validUntil: 12345,
    };
    assert.equal(
      source.resolve(
        [scoped],
        { kind: 'regional', operatingRegionId: region },
        tx,
      ).weight,
      5,
    );
    assert.deepEqual(
      [...checkpointTransactionDeadlines(tx)],
      [['AUTHORIZATION_UNAVAILABLE', 12345]],
    );
    for (const scope of [
      { kind: 'global' as const, operatingRegionId: null },
      { kind: 'regional' as const, operatingRegionId: randomUUID() },
    ])
      assert.throws(
        () => source.resolve([scoped], scope, tx),
        (error) =>
          error instanceof ApplicationError &&
          error.code === 'REPORT_SCOPE_UNAVAILABLE',
      );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('default-off worker and bounded manual command reject implicit apply, remote/production databases and invalid config', () => {
  assert.equal(config.SAFETY_JURY_PROCESSING, 'disabled');
  assert.deepEqual(parseJuryCommand([]), { mode: 'dry-run', juryIds: [] });
  assert.throws(() => parseJuryCommand(['apply']));
  assert.throws(() => parseJuryCommand(['apply', '--all']));
  assertLocalJuryWorker(config);
  assert.throws(() =>
    assertLocalJuryWorker({ ...config, NODE_ENV: 'production' }),
  );
  assert.throws(() =>
    assertLocalJuryWorker({
      ...config,
      DATABASE_URL: 'postgres://synthetic:synthetic@remote.invalid/whaleu_test',
    }),
  );
  assert.throws(() =>
    assertLocalJuryWorker({
      ...config,
      DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1/real_data',
    }),
  );
  assert.throws(() =>
    loadConfig({
      DATABASE_URL: config.DATABASE_URL,
      SAFETY_TARGET_REQUESTS_PER_MINUTE: '15',
    }),
  );
});
test('dispatcher concurrent start/stop stays stopped; explicit restart permits only one in-flight cycle', async () => {
  let cycles = 0,
    active = 0,
    max = 0;
  const worker = {
    due: async () => {
      cycles++;
      active++;
      max = Math.max(max, active);
      await sleep(5);
      active--;
      return [];
    },
    run: async () => ({}),
  } as unknown as JuryWorker;
  const d = new JuryDispatcher(
    {
      ...config,
      SAFETY_JURY_PROCESSING: 'automatic',
      SAFETY_JURY_INTERVAL_MS: 1,
    },
    worker,
  );
  await Promise.all([d.start(), d.stop()]);
  await sleep(20);
  assert.equal(cycles, 0);
  await Promise.all([d.start(), d.start(), d.start()]);
  await sleep(25);
  await d.stop();
  const stopped = cycles;
  await sleep(15);
  assert.equal(cycles, stopped);
  assert.ok(cycles > 0);
  assert.equal(max, 1);
  await d.start();
  await sleep(12);
  await d.beforeApplicationShutdown();
  assert.ok(cycles > stopped);
});
test('disabled and manual-only lifecycle never polls', async () => {
  let calls = 0;
  const worker = {
    due: async () => {
      calls++;
      return [];
    },
  } as unknown as JuryWorker;
  for (const mode of ['disabled', 'manual_only'] as const) {
    const d = new JuryDispatcher(
      { ...config, SAFETY_JURY_PROCESSING: mode, SAFETY_JURY_INTERVAL_MS: 1 },
      worker,
    );
    await d.onApplicationBootstrap();
    await d.start();
    await sleep(10);
    await d.stop();
  }
  assert.equal(calls, 0);
});
