import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { approveRating } from '../support/rating-runtime-fixture.js';
import { RatingsRepository } from '../../src/ratings/repository.js';
import { RatingDiscussionRepository } from '../../src/ratings/discussion-repository.js';
import { RatingsService } from '../../src/ratings/service.js';
import { RatingDiscussionService } from '../../src/ratings/discussion-service.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingEffectsCapture } from '../../src/ratings/effects/capture.js';
import { ExperienceIngressService } from '../../src/experience/ingress.js';
import { RatingContentReviewFacade } from '../../src/community/content-review/rating-content-review.facade.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';
import { AuthorDisplayService } from '../../src/profile/author-display.service.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';

test('rating reply bounded final facts, large-root tombstones, source capture rollback and parent-first locks', async (t) => {
  const f = await ratingDiscussionFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    b = await f.actor(),
    c = await f.actor(),
    catalog = await f.catalog(a),
    target = catalog.targets[0]!,
    root = await f.publish(a, catalog, target),
    service = f.app.get(RatingDiscussionService);
  const originals: Awaited<ReturnType<typeof f.publishReply>>[] = [],
    later: Awaited<ReturnType<typeof f.publishReply>>[] = [];
  await t.test(
    'seed fifty distinct quotations and fifty later flat replies without a history count',
    async () => {
      for (let i = 0; i < 50; i++)
        originals.push(
          await f.publishReply(
            b,
            catalog,
            target,
            root,
            f.replyBody(catalog, target, root, { body: `Original ${i}` }),
          ),
        );
      for (let i = 0; i < 50; i++)
        later.push(
          await f.publishReply(
            c,
            catalog,
            target,
            root,
            f.replyBody(catalog, target, root, {
              body: `Later ${i}`,
              replyTo: {
                replyId: originals[i]!.id,
                expectedRevision: originals[i]!.revision,
              },
            }),
          ),
        );
    },
  );
  await t.test(
    'fifty replies plus fifty quote rows use 104 Ratings and 205 Review facts with unchanged owner budgets',
    async () => {
      const records = f.app.get(RatingsRepository),
        originalEnable = records.enable.bind(records),
        restores: (() => void)[] = [],
        seen = new WeakSet<PoolClient>();
      let final = false;
      const counts = {
        catalog: 0,
        target: 0,
        comment: 0,
        reply: 0,
        reviewBindings: 0,
        reviewTimes: 0,
      };
      const businessBodies: string[] = [];
      const finalSql: string[] = [];
      records.enable = (tx) => {
        originalEnable(tx);
        if (seen.has(tx)) return;
        seen.add(tx);
        const query = tx.query.bind(tx);
        tx.query = (async (sql: string, values?: unknown[]) => {
          if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') final = true;
          if (final) {
            finalSql.push(sql);
            if (sql.includes('JOIN whaleu_ratings.catalog_heads'))
              counts.catalog = (values?.[0] as unknown[]).length;
            if (sql.includes('JOIN whaleu_ratings.targets t'))
              counts.target = (values?.[0] as unknown[]).length;
            if (sql.includes('JOIN whaleu_ratings.comments c'))
              counts.comment = (values?.[0] as unknown[]).length;
            if (sql.includes('JOIN whaleu_ratings.replies r'))
              counts.reply = (values?.[0] as unknown[]).length;
            if (
              sql.includes(
                'LEFT JOIN whaleu_community.rating_approval_bindings b',
              )
            )
              counts.reviewBindings = (values?.[0] as unknown[]).length;
            if (
              sql.includes('WITH instant AS MATERIALIZED') &&
              sql.includes('wanted AS')
            )
              counts.reviewTimes = (values?.[0] as unknown[]).length;
          } else if (sql.includes('SELECT r.*,r.ordinal::text'))
            businessBodies.push(String(values?.[0]));
          return query(sql, values);
        }) as typeof tx.query;
        restores.push(() => {
          tx.query = query;
        });
      };
      try {
        const position = await service.locateReply(
          a.accessToken,
          later[0]!.id,
          { limit: 50 },
        );
        assert.equal(position.page.items.length, 50);
        assert.equal(position.page.items[0]!.id, later[0]!.id);
        assert.deepEqual(counts, {
          catalog: 1,
          target: 1,
          comment: 1,
          reply: 100,
          reviewBindings: 102,
          reviewTimes: 102,
        });
        assert.equal(
          1 + counts.catalog + counts.target + counts.comment + counts.reply,
          104,
        );
        assert.equal(1 + counts.reviewBindings + counts.reviewTimes, 205);
        assert.equal(new Set(businessBodies).size, 100);
        assert.ok(
          finalSql.every((sql) => !/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)),
        );
      } finally {
        records.enable = originalEnable;
        for (const restore of restores) restore();
      }
    },
  );
  await t.test(
    'real populated continuation reads one retained per-root head, never transition history',
    async () => {
      await f.pool.query('ANALYZE whaleu_ratings.reply_heads');
      const explanation = (
        await f.pool.query(
          'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT sequence::text epoch FROM whaleu_ratings.reply_heads WHERE root_id=$1',
          [root.id],
        )
      ).rows[0]!['QUERY PLAN'];
      const serialized = JSON.stringify(explanation);
      assert.ok(serialized.includes('reply_heads'), serialized);
      assert.equal(explanation[0].Plan['Actual Rows'], 1);
      assert.ok(!serialized.includes('reply_transitions'));
      await assert.rejects(
        f.pool.query(
          'UPDATE whaleu_ratings.reply_heads SET sequence=sequence+1 WHERE root_id=$1',
          [root.id],
        ),
      );
    },
  );
  await t.test(
    'more than fifty descendants all become inaccessible under one root tombstone',
    async () => {
      const before = (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_ratings.replies WHERE root_id=$1 AND deleted_at IS NULL',
          [root.id],
        )
      ).rows[0]!.n;
      assert.equal(before, 100);
      const result = await f.deleteRoot(a, catalog, target, root);
      assert.equal(result.outcome, 'applied');
      for (const r of [originals[0]!, originals[49]!, later[0]!, later[49]!]) {
        await assert.rejects(service.reply(a.accessToken, r.id, null));
        await assert.rejects(
          service.locateReply(a.accessToken, r.id, { limit: 50 }),
        );
      }
      await assert.rejects(
        service.listReplies(a.accessToken, root.id, { limit: 50 }),
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer n FROM whaleu_ratings.replies WHERE root_id=$1 AND deleted_at IS NULL',
            [root.id],
          )
        ).rows[0]!.n,
        100,
        'effective tombstone never copies/deletes only a first batch',
      );
    },
  );
  await t.test(
    'omitted complete capture or real work rolls back content, review, persona, event and receipts',
    async () => {
      const owner = await f.actor(),
        newRoot = await f.publish(owner, catalog, target),
        effects = f.app.get(RatingEffectsCapture),
        ingress = f.app.get(ExperienceIngressService),
        originalCapture = effects.captureCreated.bind(effects),
        originalEnqueue = ingress.enqueue.bind(ingress);
      for (const missing of ['capture', 'work'] as const) {
        const command = f.replyBody(catalog, target, newRoot, {
          authorMode: 'anonymous',
        });
        await approveRating(
          f.pool,
          f.replyEnvelope(owner, catalog, target, newRoot, command),
        );
        if (missing === 'capture') effects.captureCreated = async () => {};
        else ingress.enqueue = async () => {};
        try {
          await assert.rejects(
            service.createReply(owner.accessToken, newRoot.id, command),
          );
        } finally {
          effects.captureCreated = originalCapture;
          ingress.enqueue = originalEnqueue;
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::integer n FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
              [owner.accountId, command.clientRequestId],
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::integer n FROM whaleu_ratings.replies WHERE request_id=$1',
              [command.clientRequestId],
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::integer n FROM whaleu_ratings.effect_events WHERE request_id=$1',
              [command.clientRequestId],
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT count(*)::integer n FROM whaleu_community.rating_approval_bindings WHERE decision_id=(SELECT id FROM whaleu_community.rating_approval_decisions WHERE envelope->>'clientRequestId'=$1)",
              [command.clientRequestId],
            )
          ).rows[0]!.n,
          0,
        );
      }
    },
  );
  await t.test(
    'parent-first application creation blocks root deletion and settles a legal create-then-hidden order',
    async () => {
      const owner = await f.actor(),
        writer = await f.actor(),
        r = await f.publish(owner, catalog, target),
        command = f.replyBody(catalog, target, r);
      await approveRating(
        f.pool,
        f.replyEnvelope(writer, catalog, target, r, command),
      );
      const effects = f.app.get(RatingEffectsCapture),
        original = effects.captureCreated.bind(effects);
      let entered!: () => void, release!: () => void;
      const enteredP = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        releaseP = new Promise<void>((resolve) => {
          release = resolve;
        });
      effects.captureCreated = async (...args) => {
        entered();
        await releaseP;
        return original(...args);
      };
      try {
        const creating = service.createReply(writer.accessToken, r.id, command);
        await enteredP;
        const deletion = f.deleteRoot(owner, catalog, target, r);
        await f.waitForLock('whaleu_ratings.targets');
        release();
        const [created, deleted] = await Promise.all([creating, deletion]);
        assert.equal(created.outcome, 'applied');
        assert.equal(deleted.outcome, 'applied');
        await assert.rejects(
          service.reply(writer.accessToken, created.replyId, null),
        );
      } finally {
        release();
        effects.captureCreated = original;
      }
    },
  );
  await t.test(
    'raw root and child UPDATE never wait for a parent already held by another transaction',
    async () => {
      const owner = await f.actor(),
        r = await f.publish(owner, catalog, target),
        reply = await f.publishReply(owner, catalog, target, r),
        held = await f.pool.connect(),
        raw = await f.pool.connect();
      try {
        await held.query('BEGIN');
        await held.query(
          'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
          [target.id],
        );
        for (const [table, id, operation] of [
          ['comments', r.id, 'delete_comment'],
          ['replies', reply.id, 'delete_reply'],
        ] as const) {
          await raw.query('BEGIN');
          const key = randomUUID();
          await raw.query(
            'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
            [owner.accountId, key, operation, 'e'.repeat(64)],
          );
          const started = Date.now();
          await assert.rejects(
            raw.query(
              `UPDATE whaleu_ratings.${table} SET deleted_at=clock_timestamp(),delete_request_id=$2,revision=gen_random_uuid() WHERE id=$1`,
              [id, key],
            ),
            (e: unknown) =>
              !!e && typeof e === 'object' && 'code' in e && e.code === '55P03',
          );
          assert.ok(Date.now() - started < 1000);
          await raw.query('ROLLBACK');
        }
      } finally {
        await raw.query('ROLLBACK');
        await held.query('ROLLBACK');
        raw.release();
        held.release();
      }
    },
  );
  await t.test(
    'one real transaction captures multiple root publications with independent matching transitions and receipts',
    async () => {
      const owner = await f.actor(),
        records = f.app.get(RatingsRepository),
        review = f.app.get(RatingContentReviewFacade),
        effects = f.app.get(RatingEffectsCapture),
        commands = [f.body(catalog, target), f.body(catalog, target)];
      for (const command of commands)
        await approveRating(
          f.pool,
          f.envelope(owner, catalog, target, command),
        );
      await f.app.get(DatabaseService).transaction(async (tx) => {
        await lockSafetyPolicy(tx);
        await f.app.get(AuthorDisplayService).prepare(owner.accountId, tx);
        await tx.query(
          'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
          [target.id],
        );
        for (const command of commands) {
          const envelope = f.envelope(owner, catalog, target, command);
          const accepted = await review.accepted(envelope, tx);
          await tx.query(
            "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_comment',$3)",
            [owner.accountId, command.clientRequestId, 'c'.repeat(64)],
          );
          const id = randomUUID(),
            result = await records.insertComment(
              {
                id,
                targetId: target.id,
                actor: owner.accountId,
                authorMode: 'named',
                personaId: null,
                body: command.body,
                revision: randomUUID(),
                requestId: command.clientRequestId,
                envelope,
              },
              tx,
            );
          await review.bind(accepted, 'comment', id, envelope, tx);
          await effects.captureCreated(
            owner.accountId,
            command.clientRequestId,
            tx,
          );
          await tx.query(
            'UPDATE whaleu_ratings.requests SET receipt=$3 WHERE account_id=$1 AND request_id=$2',
            [
              owner.accountId,
              command.clientRequestId,
              JSON.stringify({
                requestId: command.clientRequestId,
                operation: 'create_comment',
                ...result,
              }),
            ],
          );
        }
      });
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer n FROM whaleu_ratings.effect_events WHERE request_id=ANY($1::uuid[])',
            [commands.map((c) => c.clientRequestId)],
          )
        ).rows[0]!.n,
        2,
      );
    },
  );
  await t.test(
    'root newest-first numeric order crosses 9/10/100 without duplicates or omissions',
    async () => {
      const owner = await f.actor(),
        roots: string[] = [];
      for (let i = 0; i < 101; i++)
        roots.push((await f.publish(owner, catalog, target)).id);
      const ratings = f.app.get(RatingsService),
        seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await ratings.comments(owner.accessToken, target.id, {
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.deepEqual(seen.slice(0, 101), [...roots].reverse());
      assert.equal(new Set(seen).size, seen.length);
    },
  );
  await t.test(
    'independent replies in one transaction keep complete sources and the final root-local head',
    async () => {
      const owner = await f.actor(),
        r = await f.publish(owner, catalog, target),
        replies = f.app.get(RatingDiscussionRepository),
        review = f.app.get(RatingContentReviewFacade),
        effects = f.app.get(RatingEffectsCapture),
        commands = [
          f.replyBody(catalog, target, r),
          f.replyBody(catalog, target, r),
        ];
      for (const command of commands)
        await approveRating(
          f.pool,
          f.replyEnvelope(owner, catalog, target, r, command),
        );
      await f.app.get(DatabaseService).transaction(async (tx) => {
        await lockSafetyPolicy(tx);
        await tx.query(
          'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
          [target.id],
        );
        await tx.query(
          'SELECT id FROM whaleu_ratings.comments WHERE id=$1 FOR UPDATE',
          [r.id],
        );
        for (const command of commands) {
          const envelope = f.replyEnvelope(owner, catalog, target, r, command),
            accepted = await review.accepted(envelope, tx);
          await tx.query(
            "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_reply',$3)",
            [owner.accountId, command.clientRequestId, 'd'.repeat(64)],
          );
          const id = randomUUID(),
            result = await replies.insert(
              {
                id,
                targetId: target.id,
                rootId: r.id,
                replyToId: null,
                actor: owner.accountId,
                authorMode: 'named',
                personaId: null,
                body: command.body,
                revision: randomUUID(),
                requestId: command.clientRequestId,
                envelope,
              },
              tx,
            );
          await review.bind(accepted, 'reply', id, envelope, tx);
          await tx.query(
            'UPDATE whaleu_ratings.requests SET receipt=$3 WHERE account_id=$1 AND request_id=$2',
            [
              owner.accountId,
              command.clientRequestId,
              JSON.stringify({
                requestId: command.clientRequestId,
                operation: 'create_reply',
                ...result,
              }),
            ],
          );
        }
        for (const command of commands)
          await effects.captureCreated(
            owner.accountId,
            command.clientRequestId,
            tx,
          );
      });
      const result = (
        await f.pool.query(
          'SELECT h.sequence=(SELECT max(t.sequence) FROM whaleu_ratings.reply_transitions t WHERE t.root_id=h.root_id) exact FROM whaleu_ratings.reply_heads h WHERE root_id=$1',
          [r.id],
        )
      ).rows[0]!;
      assert.equal(result.exact, true);
    },
  );
  await t.test(
    'create then delete in one transaction retains earned cause; savepoint rollback restores the root head',
    async () => {
      const owner = await f.actor(),
        r = await f.publish(owner, catalog, target),
        records = f.app.get(RatingDiscussionRepository),
        review = f.app.get(RatingContentReviewFacade),
        effects = f.app.get(RatingEffectsCapture),
        command = f.replyBody(catalog, target, r),
        deleteKey = randomUUID();
      await approveRating(
        f.pool,
        f.replyEnvelope(owner, catalog, target, r, command),
      );
      let createdId = '';
      await f.app.get(DatabaseService).transaction(async (tx) => {
        await lockSafetyPolicy(tx);
        await tx.query(
          'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
          [target.id],
        );
        await tx.query(
          'SELECT id FROM whaleu_ratings.comments WHERE id=$1 FOR UPDATE',
          [r.id],
        );
        const envelope = f.replyEnvelope(owner, catalog, target, r, command),
          accepted = await review.accepted(envelope, tx);
        await tx.query(
          "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_reply',$3)",
          [owner.accountId, command.clientRequestId, '8'.repeat(64)],
        );
        createdId = randomUUID();
        const created = await records.insert(
          {
            id: createdId,
            targetId: target.id,
            rootId: r.id,
            replyToId: null,
            actor: owner.accountId,
            authorMode: 'named',
            personaId: null,
            body: command.body,
            revision: randomUUID(),
            requestId: command.clientRequestId,
            envelope,
          },
          tx,
        );
        await review.bind(accepted, 'reply', createdId, envelope, tx);
        const row = await records.reply(createdId, r.id, target.id, tx, true);
        await tx.query(
          "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'delete_reply',$3)",
          [owner.accountId, deleteKey, '9'.repeat(64)],
        );
        const deleted = await records.delete(
          row,
          owner.accountId,
          deleteKey,
          row.revision,
          tx,
        );
        await effects.captureCreated(
          owner.accountId,
          command.clientRequestId,
          tx,
        );
        for (const [key, operation, result] of [
          [command.clientRequestId, 'create_reply', created],
          [deleteKey, 'delete_reply', deleted],
        ] as const)
          await tx.query(
            'UPDATE whaleu_ratings.requests SET receipt=$3 WHERE account_id=$1 AND request_id=$2',
            [
              owner.accountId,
              key,
              JSON.stringify({ requestId: key, operation, ...result }),
            ],
          );
      });
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer n FROM whaleu_ratings.reply_transitions WHERE reply_id=$1',
            [createdId],
          )
        ).rows[0]!.n,
        2,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer n FROM whaleu_ratings.reward_groups WHERE reply_id=$1',
            [createdId],
          )
        ).rows[0]!.n,
        1,
      );
      const before = (
        await f.pool.query(
          'SELECT * FROM whaleu_ratings.reply_heads WHERE root_id=$1',
          [r.id],
        )
      ).rows;
      const rolled = f.replyBody(catalog, target, r);
      await approveRating(
        f.pool,
        f.replyEnvelope(owner, catalog, target, r, rolled),
      );
      await f.app.get(DatabaseService).transaction(async (tx) => {
        await lockSafetyPolicy(tx);
        await tx.query(
          'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
          [target.id],
        );
        await tx.query(
          'SELECT id FROM whaleu_ratings.comments WHERE id=$1 FOR UPDATE',
          [r.id],
        );
        const checkpoint = checkpointTransactionDeadlines(tx);
        await tx.query('SAVEPOINT synthetic_reply');
        const envelope = f.replyEnvelope(owner, catalog, target, r, rolled),
          accepted = await review.accepted(envelope, tx);
        await tx.query(
          "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_reply',$3)",
          [owner.accountId, rolled.clientRequestId, '7'.repeat(64)],
        );
        const id = randomUUID();
        await records.insert(
          {
            id,
            targetId: target.id,
            rootId: r.id,
            replyToId: null,
            actor: owner.accountId,
            authorMode: 'named',
            personaId: null,
            body: rolled.body,
            revision: randomUUID(),
            requestId: rolled.clientRequestId,
            envelope,
          },
          tx,
        );
        await review.bind(accepted, 'reply', id, envelope, tx);
        await tx.query('ROLLBACK TO SAVEPOINT synthetic_reply');
        restoreTransactionDeadlines(tx, checkpoint);
        await tx.query('RELEASE SAVEPOINT synthetic_reply');
      });
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.reply_heads WHERE root_id=$1',
            [r.id],
          )
        ).rows,
        before,
      );
      assert.equal(
        (await service.createReply(owner.accessToken, r.id, rolled)).outcome,
        'applied',
      );
    },
  );
  await t.test(
    'missing automatic effect, notice obligation, unit or root head aborts the whole publication',
    async () => {
      const owner = await f.actor(),
        writer = await f.actor(),
        r = await f.publish(owner, catalog, target);
      for (const table of [
        'effect_events',
        'notice_obligations',
        'reward_units',
        'reply_heads',
      ]) {
        await f.pool.query(
          'CREATE FUNCTION whaleu_ratings.synthetic_omit_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL;END $$',
        );
        await f.pool.query(
          `CREATE TRIGGER z_synthetic_omit BEFORE INSERT ON whaleu_ratings.${table} FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.synthetic_omit_source()`,
        );
        const command = f.replyBody(catalog, target, r);
        await approveRating(
          f.pool,
          f.replyEnvelope(writer, catalog, target, r, command),
        );
        try {
          await assert.rejects(
            service.createReply(writer.accessToken, r.id, command),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::integer n FROM whaleu_ratings.replies WHERE request_id=$1',
                [command.clientRequestId],
              )
            ).rows[0]!.n,
            0,
          );
        } finally {
          await f.pool.query(
            `DROP TRIGGER z_synthetic_omit ON whaleu_ratings.${table}`,
          );
          await f.pool.query(
            'DROP FUNCTION whaleu_ratings.synthetic_omit_source()',
          );
        }
      }
    },
  );
  await t.test(
    'reply-v2 consumption expiry after deferred work rolls back text, effect, work and receipt',
    async () => {
      const owner = await f.actor(),
        r = await f.publish(owner, catalog, target),
        command = f.replyBody(catalog, target, r);
      const approval = await approveRating(
        f.pool,
        f.replyEnvelope(owner, catalog, target, r, command),
        { consumeUntil: new Date(Date.now() + 2000) },
      );
      await f.pool.query(
        'CREATE FUNCTION whaleu_ratings.synthetic_final_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.4);RETURN NULL;END $$',
      );
      await f.pool.query(
        'CREATE CONSTRAINT TRIGGER z_synthetic_final_wait AFTER INSERT ON whaleu_ratings.replies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.synthetic_final_wait()',
      );
      try {
        const start = Date.now(),
          response = await f
            .auth(
              request(f.http).post(`/v1/ratings/comments/${r.id}/replies`),
              owner,
            )
            .send(command);
        assert.ok(Date.now() - start >= 2300);
        assert.equal(
          response.body.error.code,
          'CONTENT_REVIEW_UNAVAILABLE',
          JSON.stringify(response.body),
        );
        for (const table of ['requests', 'replies', 'effect_events'])
          assert.equal(
            (
              await f.pool.query(
                `SELECT count(*)::integer n FROM whaleu_ratings.${table} WHERE request_id=$1`,
                [command.clientRequestId],
              )
            ).rows[0]!.n,
            0,
          );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::integer n FROM whaleu_community.rating_approval_bindings WHERE decision_id=$1',
              [approval.decisionId],
            )
          ).rows[0]!.n,
          0,
        );
      } finally {
        await f.pool.query(
          'DROP TRIGGER z_synthetic_final_wait ON whaleu_ratings.replies',
        );
        await f.pool.query(
          'DROP FUNCTION whaleu_ratings.synthetic_final_wait()',
        );
      }
    },
  );
});
