import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type {
  ExperienceEnqueueUnit,
  ExperienceIngressService,
} from '../src/experience/ingress.js';
import { RatingEffectsCapture } from '../src/ratings/effects/capture.js';

function fixture(
  actions: readonly (
    'comment' | 'received_comment' | 'like_save' | 'received_like_save'
  )[],
  present = true,
) {
  const actor = randomUUID(),
    requestId = randomUUID(),
    eventId = randomUUID();
  const expected = actions.map((action, index) => ({
    action,
    beneficiary_id: index === 0 ? actor : randomUUID(),
  }));
  const calls: string[] = [];
  const queries: { sql: string; args: unknown[] }[] = [];
  let enqueued: readonly ExperienceEnqueueUnit[] = [];
  const tx = {
    query: async (sql: string, args: unknown[]) => {
      queries.push({ sql, args });
      if (sql.startsWith('SELECT id FROM')) {
        calls.push('source');
        return { rows: present ? [{ id: eventId }] : [] };
      }
      if (sql.startsWith('SELECT * FROM')) {
        calls.push('expected');
        return { rows: expected };
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
    reserve: async (client: PoolClient, beneficiaries: string[]) => {
      calls.push('reserve');
      assert.equal(client, tx);
      assert.deepEqual(
        beneficiaries,
        expected.map((u) => u.beneficiary_id),
      );
      return { enrollmentOrder: '9007199254740993' };
    },
    enqueue: async (
      client: PoolClient,
      units: readonly ExperienceEnqueueUnit[],
    ) => {
      calls.push('enqueue');
      assert.equal(client, tx);
      enqueued = units;
    },
  } as ExperienceIngressService;
  return {
    capture: new RatingEffectsCapture(ingress),
    actor,
    requestId,
    eventId,
    tx,
    expected,
    calls,
    queries,
    enqueued: () => enqueued,
  };
}

for (const method of ['captureCreated', 'captureLiked'] as const)
  for (const self of [false, true])
    test(`${method} ${self ? 'self' : 'nonself'} reserves canonical private owners before enqueue`, async () => {
      const actions =
        method === 'captureCreated'
          ? (['comment', 'received_comment'] as const)
          : (['like_save', 'received_like_save'] as const);
      const f = fixture(self ? [actions[0]] : actions);
      await f.capture[method](f.actor, f.requestId, f.tx);
      assert.deepEqual(f.calls, [
        'source',
        'expected',
        'reserve',
        'group',
        ...f.expected.map(() => 'unit'),
        'enqueue',
      ]);
      assert.deepEqual(f.queries[0]!.args, [f.actor, f.requestId]);
      assert.match(
        f.queries[0]!.sql,
        /mutation_transaction=pg_current_xact_id\(\)/,
      );
      assert.match(
        f.queries[0]!.sql,
        method === 'captureCreated'
          ? /source_version=1 AND rule_version='rating-effects-v1'/
          : /source_version=2 AND rule_version='rating-likes-v1' AND event_kind='content_liked'/,
      );
      assert.doesNotMatch(f.queries[0]!.sql, /content_unliked/);
      const group = f.queries.find((q) =>
        q.sql.startsWith('INSERT INTO whaleu_ratings.reward_groups'),
      )!;
      assert.match(
        group.sql,
        /like_transition_id,subject_author_id,subject_author_mode/,
      );
      assert.match(
        group.sql,
        /SELECT.*FROM whaleu_ratings.effect_events WHERE id=\$2/,
      );
      assert.deepEqual(group.args.slice(1), [f.eventId, '9007199254740993']);
      const units = f.enqueued();
      assert.equal(units.length, f.expected.length);
      assert.deepEqual(
        units.map((u) => ({
          action: u.action,
          beneficiary_id: u.beneficiaryId,
        })),
        f.expected,
      );
      assert.equal(new Set(units.map((u) => u.unitId)).size, units.length);
      for (const u of units) {
        assert.equal(u.groupId, group.args[0]);
        assert.equal(u.enrollmentOrder, '9007199254740993');
      }
    });

for (const method of ['captureCreated', 'captureLiked'] as const)
  test(`${method} cannot reserve, replay or manufacture a missing fresh source`, async () => {
    const f = fixture([], false);
    await assert.rejects(
      f.capture[method](f.actor, f.requestId, f.tx),
      /Fresh rating source is absent/,
    );
    assert.deepEqual(f.calls, ['source']);
    assert.deepEqual(f.enqueued(), []);
  });
