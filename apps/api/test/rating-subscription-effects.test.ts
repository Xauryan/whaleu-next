import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { CommunityExperienceSourceFacade } from '../src/community/experience-source/facade.js';
import type {
  ExperienceEnqueueUnit,
  ExperienceIngressService,
} from '../src/experience/ingress.js';
import type { ExperienceSourceUnit } from '../src/experience/source-contracts.js';
import { ExperienceSourceRouter } from '../src/experience/source-router.js';
import {
  RatingEffectsCapture,
  type RatingSubscriptionTransitionSource,
} from '../src/ratings/effects/capture.js';
import { RatingExperienceSourceFacade } from '../src/ratings/experience-source/facade.js';

function captureFixture(
  options: {
    delta?: 1 | -1;
    missing?: boolean;
    expected?: { beneficiary_id: string; action: string }[];
  } = {},
) {
  const transition: RatingSubscriptionTransitionSource = {
    id: randomUUID(),
    target_id: randomUUID(),
    account_id: randomUUID(),
    request_id: randomUUID(),
    delta: options.delta ?? 1,
    target_order: '9007199254740993',
    occurred_at: '2026-10-09 03:14:00.123456+00',
  };
  const eventId = randomUUID();
  const calls: string[] = [];
  const queries: { sql: string; args: unknown[] }[] = [];
  let enqueued: readonly ExperienceEnqueueUnit[] = [];
  const tx = {
    query: async (sql: string, args: unknown[]) => {
      queries.push({ sql, args });
      if (sql.startsWith('SELECT e.id')) {
        calls.push('source');
        return { rows: options.missing ? [] : [{ id: eventId }] };
      }
      if (
        sql.startsWith('SELECT * FROM whaleu_ratings.expected_reward_units')
      ) {
        calls.push('expected');
        return {
          rows: options.expected ?? [
            { beneficiary_id: transition.account_id, action: 'like_save' },
          ],
        };
      }
      if (sql.startsWith('INSERT INTO whaleu_ratings.reward_groups'))
        calls.push('group');
      else if (sql.startsWith('INSERT INTO whaleu_ratings.reward_units'))
        calls.push('unit');
      else throw new Error(`Unexpected SQL: ${sql}`);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const ingress = {
    reserve: async (client: PoolClient, owners: readonly string[]) => {
      assert.equal(client, tx);
      assert.deepEqual(owners, [transition.account_id]);
      calls.push('reserve');
      return { enrollmentOrder: '9007199254740995' };
    },
    enqueue: async (
      client: PoolClient,
      rows: readonly ExperienceEnqueueUnit[],
    ) => {
      assert.equal(client, tx);
      enqueued = rows;
      calls.push('enqueue');
    },
  } as ExperienceIngressService;
  return {
    capture: new RatingEffectsCapture(ingress),
    transition,
    tx,
    eventId,
    calls,
    queries,
    enqueued: () => enqueued,
  };
}

test('subscription captures one SQL-owned actor like_save source without a root or received reward', async () => {
  const f = captureFixture();
  await f.capture.captureSubscription(f.tx, f.transition);
  assert.deepEqual(f.calls, [
    'source',
    'expected',
    'reserve',
    'group',
    'unit',
    'enqueue',
  ]);
  const source = f.queries[0]!;
  assert.deepEqual(source.args, Object.values(f.transition));
  assert.match(source.sql, /t\.target_order=\$6/);
  assert.match(source.sql, /e\.occurred_at=\$7::timestamptz/);
  assert.match(source.sql, /e\.mutation_transaction=pg_current_xact_id\(\)/);
  assert.match(
    source.sql,
    /e\.source_version=3 AND e\.rule_version='rating-subscriptions-v1'/,
  );
  for (const name of [
    'root_id',
    'root_author_id',
    'author_mode',
    'reply_id',
    'reply_to_id',
    'direct_reply_author_id',
    'comment_transition_id',
    'reply_transition_id',
    'like_transition_id',
    'subject_author_id',
    'subject_author_mode',
  ])
    assert.match(source.sql, new RegExp(`e\\.${name} IS NULL`));
  assert.match(source.sql, /e\.expected_direct_notice_obligations=0/);
  const group = f.queries.find((q) =>
    q.sql.startsWith('INSERT INTO whaleu_ratings.reward_groups'),
  )!;
  assert.match(group.sql, /subscription_transition_id,occurred_at/);
  assert.match(group.sql, /FROM whaleu_ratings.effect_events WHERE id=\$2/);
  assert.deepEqual(group.args.slice(1), [f.eventId, '9007199254740995']);
  assert.equal(f.enqueued().length, 1);
  assert.deepEqual(
    f.enqueued().map((u) => [u.beneficiaryId, u.action, u.enrollmentOrder]),
    [[f.transition.account_id, 'like_save', '9007199254740995']],
  );
});

test('unsubscribe verifies its fresh source but reserves no enrollment and makes no deduction', async () => {
  const f = captureFixture({ delta: -1 });
  await f.capture.captureSubscription(f.tx, f.transition);
  assert.deepEqual(f.calls, ['source']);
  assert.deepEqual(f.enqueued(), []);
  assert.equal(f.queries[0]!.args[4], -1);
});

for (const delta of [-1, 1] as const)
  test(`subscription delta ${delta} cannot capture a replay or missing exact source`, async () => {
    const f = captureFixture({ delta, missing: true });
    await assert.rejects(
      f.capture.captureSubscription(f.tx, f.transition),
      /Fresh rating subscription source is absent/,
    );
    assert.deepEqual(f.calls, ['source']);
  });

for (const expected of [
  [],
  [{ beneficiary_id: randomUUID(), action: 'like_save' }],
  [{ beneficiary_id: randomUUID(), action: 'received_like_save' }],
  [
    { beneficiary_id: randomUUID(), action: 'like_save' },
    { beneficiary_id: randomUUID(), action: 'received_like_save' },
  ],
])
  test(`subscription rejects a noncanonical reward set before reservation: ${JSON.stringify(expected)}`, async () => {
    const f = captureFixture({ expected });
    await assert.rejects(
      f.capture.captureSubscription(f.tx, f.transition),
      /reward source does not match/,
    );
    assert.deepEqual(f.calls, ['source', 'expected']);
  });

test('invalid subscription delta does not query or enroll a source', async () => {
  const f = captureFixture();
  await assert.rejects(
    f.capture.captureSubscription(f.tx, { ...f.transition, delta: 0 as 1 }),
    /Invalid rating subscription transition/,
  );
  assert.deepEqual(f.calls, []);
});

function routerFixture(
  action: ExperienceSourceUnit['action'] = 'like_save',
  sourceVersion = 3,
) {
  const source: ExperienceSourceUnit = {
    unitId: randomUUID(),
    groupId: randomUUID(),
    beneficiaryId: randomUUID(),
    action,
    occurredAt: '2026-10-09 03:14:00.123456+00',
    sourceKind: 'rating_event',
    sourceId: randomUUID(),
  };
  const reference = {
    ...source,
    sourceDomain: 'ratings',
    sourceVersion,
    enrollmentOrder: '9007199254740993',
  };
  const calls: string[] = [];
  const tx = {
    query: async () => {
      calls.push('registry');
      return { rows: [reference] };
    },
  } as unknown as PoolClient;
  const community = {
    loadUnit: async () => {
      calls.push('community');
      return null;
    },
  } as unknown as CommunityExperienceSourceFacade;
  const ratings = {
    loadUnit: async () => {
      calls.push('ratings');
      return source;
    },
    acknowledge: async (id: string, settlement: string, client: PoolClient) => {
      assert.equal(id, source.unitId);
      assert.equal(settlement, 'settlement');
      assert.equal(client, tx);
      calls.push('ack');
    },
  } as RatingExperienceSourceFacade;
  return {
    router: new ExperienceSourceRouter(community, ratings),
    source,
    tx,
    calls,
  };
}

test('registered v3 actor source routes and acknowledges as a rating event without another domain probe', async () => {
  const f = routerFixture();
  const routed = await f.router.loadUnit(f.source.unitId, f.tx);
  assert.deepEqual(routed, {
    ...f.source,
    sourceDomain: 'ratings',
    enrollmentOrder: '9007199254740993',
  });
  assert.ok(routed);
  await f.router.acknowledge(routed, 'settlement', f.tx);
  assert.deepEqual(f.calls, ['registry', 'ratings', 'ack']);
});

for (const action of [
  'comment',
  'received_comment',
  'received_like_save',
] as const)
  test(`v3 rejects registered ${action} before consulting ratings`, async () => {
    const f = routerFixture(action);
    assert.equal(await f.router.loadUnit(f.source.unitId, f.tx), null);
    assert.deepEqual(f.calls, ['registry']);
  });

test('unknown future version cannot masquerade as a subscription actor source', async () => {
  const f = routerFixture('like_save', 4);
  assert.equal(await f.router.loadUnit(f.source.unitId, f.tx), null);
  assert.deepEqual(f.calls, ['registry']);
});

test('rating load and acknowledgement share the same exact target-only v3 branch and never lock mutable parents', async () => {
  const queries: string[] = [];
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [{ unit_id: 'unit' }] };
    },
  } as unknown as PoolClient;
  const facade = new RatingExperienceSourceFacade();
  await facade.loadUnit('unit', tx);
  await facade.acknowledge('unit', 'settlement', tx);
  for (const sql of queries) {
    assert.match(
      sql,
      /g\.source_version=3 AND g\.event_kind='target_subscribed'/,
    );
    assert.match(
      sql,
      /g\.subscription_transition_id IS NOT NULL AND g\.expected_unit_count=1/,
    );
    assert.match(
      sql,
      /u\.action='like_save' AND u\.beneficiary_id=g\.actor_account_id/,
    );
    assert.match(sql, /g\.root_id IS NULL AND g\.root_author_id IS NULL/);
    assert.doesNotMatch(
      sql,
      /target_unsubscribed|whaleu_ratings\.(targets|comments|replies|subscription_memberships)|FOR (SHARE|UPDATE)/,
    );
  }
  assert.equal(
    queries[0]!.slice(queries[0]!.indexOf('(\n  (g.source_version')),
    queries[1]!.slice(queries[1]!.indexOf('(\n  (g.source_version')),
  );
  assert.match(queries[1]!, /sg\.source_version=g\.source_version/);
});
