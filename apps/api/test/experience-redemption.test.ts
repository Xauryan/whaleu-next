import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { redemptionSchema } from '../src/experience/contracts.js';
import {
  RedemptionProvider,
  RedemptionAttemptBudget,
  redemptionFingerprints,
} from '../src/experience/redemption.provider.js';
import { RedemptionRepository } from '../src/experience/redemption.repository.js';
import { ExperienceRedemptionService } from '../src/experience/redemption.service.js';
import {
  ExperienceRepository,
  ExperienceClock,
} from '../src/experience/repository.js';
import type { DatabaseService } from '../src/database/database.js';
import type { IdentityService } from '../src/identity/identity.service.js';
const material = { version: 'synthetic_v1', key: Buffer.alloc(32, 0x39) };
test('redemption exact byte boundary rejects control, oversize and unknown client authority', () => {
  const requestId = randomUUID();
  for (const code of [
    '',
    '\0',
    '\n',
    '\u0085',
    'x'.repeat(129),
    '界'.repeat(43),
    '\ud800',
  ])
    assert.equal(
      redemptionSchema.safeParse({ requestId, code }).success,
      false,
    );
  for (const code of [' Case Exact ', '界'.repeat(42), '😀'.repeat(32)])
    assert.deepEqual(redemptionSchema.parse({ requestId, code }), {
      requestId,
      code,
    });
  assert.equal(
    redemptionSchema.safeParse({
      requestId,
      code: 'synthetic',
      titleKey: 'level_1',
    }).success,
    false,
  );
});
test('HMAC binds exact owner operation bytes, separates lookup and has no short-key fallback', () => {
  const a = redemptionFingerprints('owner-a', 'synthetic input', material)!;
  assert.equal(a.intent.length, 64);
  assert.notEqual(a.intent, a.lookup);
  assert.notEqual(
    a.intent,
    redemptionFingerprints('owner-b', 'synthetic input', material)!.intent,
  );
  assert.equal(
    a.lookup,
    redemptionFingerprints('owner-b', 'synthetic input', material)!.lookup,
  );
  for (const code of ['Synthetic input', 'synthetic input ', 'synthetic Input'])
    assert.notEqual(
      a.intent,
      redemptionFingerprints('owner-a', code, material)!.intent,
    );
  assert.equal(
    redemptionFingerprints('owner-a', 'synthetic', {
      version: 'bad version',
      key: material.key,
    }),
    null,
  );
  assert.equal(
    redemptionFingerprints('owner-a', 'synthetic', {
      version: 'v1',
      key: Buffer.alloc(1),
    }),
    null,
  );
});
function harness(
  provider: RedemptionProvider,
  budget: RedemptionAttemptBudget,
  prior: Awaited<ReturnType<ExperienceRepository['request']>> = null,
) {
  const queries: unknown[] = [];
  const tx = {
    query: async (sql: string, params: unknown[]) => {
      queries.push([sql, params]);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => fn(tx),
  } as DatabaseService;
  const identity = {
    session: async () => ({ accountId: 'synthetic-owner' }),
  } as unknown as IdentityService;
  const records = new ExperienceRepository();
  records.request = async () => prior;
  const clock = {
    now: async () => ({
      at: new Date('2026-10-08T00:00:00Z'),
      day: '2026-10-08',
    }),
  } as ExperienceClock;
  return {
    service: new ExperienceRedemptionService(
      database,
      identity,
      records,
      clock,
      new RedemptionRepository(),
      provider,
      budget,
    ),
    queries,
  };
}
test('production defaults deny before HMAC key, lookup and command writes', async () => {
  const provider = new RedemptionProvider();
  provider.key = () => {
    throw new Error('must not request key for unavailable new command');
  };
  const h = harness(provider, new RedemptionAttemptBudget());
  await assert.rejects(
    h.service.redeem('synthetic-token', {
      requestId: randomUUID(),
      code: 'synthetic-canary',
    }),
    { code: 'EXPERIENCE_REDEMPTION_UNAVAILABLE' },
  );
  assert.equal(h.queries.length, 1);
  assert.ok(!JSON.stringify(h.queries).includes('synthetic-canary'));
});
test('budget rejection happens before lookup or ownership mutation, and capability validates readiness', async () => {
  const provider = new RedemptionProvider();
  provider.available = () => true;
  provider.key = () => material;
  provider.lookup = async () => {
    throw new Error('lookup forbidden');
  };
  const budget = new RedemptionAttemptBudget();
  budget.available = () => true;
  const h = harness(provider, budget);
  assert.deepEqual(await h.service.capability('token'), {
    status: 'available',
  });
  await assert.rejects(
    h.service.redeem('token', {
      requestId: randomUUID(),
      code: 'synthetic-canary',
    }),
    { code: 'EXPERIENCE_REDEMPTION_RATE_LIMITED' },
  );
  assert.equal(h.queries.length, 1);
  provider.key = () => ({ ...material, key: Buffer.alloc(1) });
  assert.deepEqual(await h.service.capability('token'), {
    status: 'unavailable',
  });
});
test('safe fingerprints only cross SQL boundary and receipt contains only allowed facts', async () => {
  const provider = new RedemptionProvider();
  provider.available = () => true;
  provider.key = () => material;
  provider.lookup = async () => 'redeem_liangchenmeijing';
  const budget = new RedemptionAttemptBudget();
  budget.available = () => true;
  budget.permit = async () => true;
  const h = harness(provider, budget),
    requestId = randomUUID();
  assert.deepEqual(
    await h.service.redeem('token', {
      requestId,
      code: 'SYNTHETIC_CANARY_ONLY_982',
    }),
    {
      requestId,
      operation: 'redeem_title',
      outcome: 'granted',
      titleKey: 'redeem_liangchenmeijing',
    },
  );
  const sql = JSON.stringify(h.queries);
  assert.ok(!sql.includes('SYNTHETIC_CANARY_ONLY_982'));
  assert.ok(!sql.includes(material.key.toString('hex')));
  assert.ok(!sql.includes('account_states'));
  assert.ok(!sql.includes('baselines'));
  assert.ok(!sql.includes('appearance'));
});
test('replay after deactivation needs saved key but not budget; conflicting bytes remain conflict', async () => {
  const requestId = randomUUID(),
    code = 'synthetic replay';
  const receipt = {
    requestId,
    operation: 'redeem_title' as const,
    outcome: 'rejected' as const,
    code: 'EXPERIENCE_REDEMPTION_INVALID' as const,
  };
  const prior = {
    intent_hash: redemptionFingerprints('synthetic-owner', code, material)!
      .intent,
    intent_key_version: material.version,
    operation: 'redeem_title',
    receipt,
  };
  const provider = new RedemptionProvider();
  provider.key = (version) => (version === material.version ? material : null);
  const h = harness(provider, new RedemptionAttemptBudget(), prior);
  assert.deepEqual(
    await h.service.redeem('token', { requestId, code }),
    receipt,
  );
  await assert.rejects(
    h.service.redeem('token', { requestId, code: code + ' ' }),
    { code: 'EXPERIENCE_REQUEST_CONFLICT' },
  );
  provider.key = () => null;
  await assert.rejects(h.service.redeem('token', { requestId, code }), {
    code: 'EXPERIENCE_REDEMPTION_UNAVAILABLE',
  });
});
