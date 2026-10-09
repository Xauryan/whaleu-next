import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { RatingLikesService } from '../../src/ratings/likes/service.js';
import { RatingLikesRepository } from '../../src/ratings/likes/repository.js';
import { RatingEffectsCapture } from '../../src/ratings/effects/capture.js';
import type { SetRatingCommentLike } from '../../src/ratings/likes/contracts.js';
test(
  'rating likes retain bounded final facts, parent locks and post-deferred deadlines',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      b = await f.actor(),
      catalog = await f.catalog(a),
      target = catalog.targets[0]!,
      service = f.app.get(RatingLikesService);
    const command = async (root: {
      id: string;
      revision: string;
    }): Promise<SetRatingCommentLike> => {
      const state = await service.state(
        b.accessToken,
        'comment',
        root.id,
        null,
      );
      assert.equal(state.status, 'known');
      assert.ok(state.status === 'known');
      return {
        clientRequestId: randomUUID(),
        regionId: null,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        expectedRevision: root.revision,
        expectedLikeRevision: state.revision,
        liked: true,
      };
    };
    const noMutation = async (key: string) => {
      for (const table of ['requests', 'like_transitions', 'effect_events'])
        assert.equal(
          (
            await f.pool.query(
              `SELECT count(*)::integer n FROM whaleu_ratings.${table} WHERE request_id=$1`,
              [key],
            )
          ).rows[0]!.n,
          0,
        );
    };
    await t.test(
      'final like state fact is one exact post-mutation tuple and SQL-only NOWAIT',
      async () => {
        const root = await f.publish(a, catalog, target),
          input = await command(root),
          repo = f.app.get(RatingLikesRepository),
          original = repo.retain.bind(repo),
          restores: (() => void)[] = [];
        let final = false;
        const sql: string[] = [];
        let factCount = 0;
        repo.retain = (row, actor, tx) => {
          factCount++;
          const query = tx.query.bind(tx);
          tx.query = ((q: string, v?: unknown[]) => {
            if (q === 'SET CONSTRAINTS ALL IMMEDIATE') final = true;
            else if (final) sql.push(q);
            return query(q, v);
          }) as typeof tx.query;
          restores.push(() => {
            tx.query = query;
          });
          return original(row, actor, tx);
        };
        try {
          assert.equal(
            (await service.set(b.accessToken, 'comment', root.id, input))
              .outcome,
            'applied',
          );
        } finally {
          repo.retain = original;
          for (const restore of restores) restore();
        }
        assert.equal(factCount, 1);
        assert.ok(
          sql.some(
            (s) => s.includes('like_states') && s.includes('FOR SHARE NOWAIT'),
          ),
        );
        assert.ok(
          sql.some(
            (s) =>
              s.includes('unnest($1::uuid[]') && s.includes('like_memberships'),
          ),
        );
        assert.ok(sql.every((s) => !/^\s*(INSERT|UPDATE|DELETE)/i.test(s)));
      },
    );
    await t.test(
      'a real final NOWAIT fence failure rolls back membership, head, effect, work and receipt',
      async () => {
        const root = await f.publish(a, catalog, target),
          other = await f.publish(a, catalog, target),
          input = await command(root),
          held = await f.pool.connect(),
          repo = f.app.get(RatingLikesRepository),
          original = repo.retain.bind(repo);
        let ran = false,
          restore: () => void = () => {};
        await held.query('BEGIN');
        await held.query(
          'SELECT subject_id FROM whaleu_ratings.like_states WHERE subject_id=$1 FOR UPDATE',
          [other.id],
        );
        repo.retain = (row, actor, tx) => {
          const query = tx.query.bind(tx);
          tx.query = ((q: string, v?: unknown[]) => {
            if (
              q.startsWith(
                'SELECT subject_id FROM whaleu_ratings.like_states WHERE subject_id=ANY',
              )
            ) {
              ran = true;
              return query(q, [[other.id]]);
            }
            return query(q, v);
          }) as typeof tx.query;
          restore = () => {
            tx.query = query;
          };
          return original(row, actor, tx);
        };
        try {
          await assert.rejects(
            service.set(b.accessToken, 'comment', root.id, input),
            (e: unknown) =>
              !!e &&
              typeof e === 'object' &&
              'code' in e &&
              e.code === 'RATING_UNAVAILABLE',
          );
          assert.equal(ran, true);
        } finally {
          repo.retain = original;
          restore();
          await held.query('ROLLBACK');
          held.release();
        }
        await noMutation(input.clientRequestId);
        const current = await service.state(
          b.accessToken,
          'comment',
          root.id,
          null,
        );
        assert.ok(current.status === 'known');
        assert.equal(current.count, 0);
        assert.equal(current.revision, input.expectedLikeRevision);
      },
    );
    await t.test(
      'like followed by concurrent root deletion serializes at the parent and retains private obligations',
      async () => {
        const root = await f.publish(a, catalog, target),
          input = await command(root),
          effects = f.app.get(RatingEffectsCapture),
          original = effects.captureLiked.bind(effects);
        let entered!: () => void, release!: () => void;
        const enteredP = new Promise<void>((r) => {
            entered = r;
          }),
          releaseP = new Promise<void>((r) => {
            release = r;
          });
        effects.captureLiked = async (...args) => {
          entered();
          await releaseP;
          return original(...args);
        };
        try {
          const liking = service.set(b.accessToken, 'comment', root.id, input);
          await enteredP;
          const deletion = f.deleteRoot(a, catalog, target, root);
          await f.waitForLock('whaleu_ratings.targets');
          release();
          const [like, deleted] = await Promise.all([liking, deletion]);
          assert.equal(like.outcome, 'applied');
          assert.equal(deleted.outcome, 'applied');
          await assert.rejects(
            service.state(b.accessToken, 'comment', root.id, null),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count FROM whaleu_ratings.like_states WHERE subject_id=$1',
                [root.id],
              )
            ).rows[0]!.count,
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::integer n FROM whaleu_ratings.effect_events WHERE request_id=$1',
                [input.clientRequestId],
              )
            ).rows[0]!.n,
            1,
          );
        } finally {
          release();
          effects.captureLiked = original;
        }
      },
    );
    await t.test(
      'raw membership UPDATE cannot wait backward on an already held target',
      async () => {
        const root = await f.publish(a, catalog, target),
          input = await command(root),
          applied = await service.set(b.accessToken, 'comment', root.id, input);
        assert.ok(applied.outcome === 'applied');
        const held = await f.pool.connect(),
          raw = await f.pool.connect();
        try {
          await held.query('BEGIN');
          await held.query(
            'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
            [target.id],
          );
          await raw.query('BEGIN');
          const key = randomUUID();
          await raw.query(
            "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'set_comment_like',$3)",
            [b.accountId, key, 'a'.repeat(64)],
          );
          const start = Date.now();
          await assert.rejects(
            raw.query(
              'UPDATE whaleu_ratings.like_memberships SET liked=false,request_id=$3,expected_revision=$4 WHERE subject_id=$1 AND account_id=$2',
              [root.id, b.accountId, key, applied.revision],
            ),
            (e: unknown) =>
              !!e && typeof e === 'object' && 'code' in e && e.code === '55P03',
          );
          assert.ok(Date.now() - start < 1000);
        } finally {
          await raw.query('ROLLBACK');
          await held.query('ROLLBACK');
          raw.release();
          held.release();
        }
      },
    );
    await t.test(
      'phone expiry during a deferred like-source wait rejects and rolls back the entire command',
      async () => {
        const root = await f.publish(a, catalog, target),
          input = await command(root);
        await f.certify(b.accountId, {
          expiresAt: new Date(Date.now() + 1600),
        });
        await f.pool.query(
          'CREATE FUNCTION whaleu_ratings.test_like_final_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.0);RETURN NULL;END $$;CREATE CONSTRAINT TRIGGER z_test_like_final_wait AFTER INSERT ON whaleu_ratings.like_transitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.test_like_final_wait()',
        );
        try {
          const response = await f
            .auth(
              request(f.http).put(`/v1/ratings/comments/${root.id}/like`),
              b,
            )
            .send(input);
          assert.equal(response.status, 503, JSON.stringify(response.body));
          assert.equal(response.body.error.code, 'VERIFICATION_UNAVAILABLE');
          await noMutation(input.clientRequestId);
        } finally {
          await f.pool.query(
            'DROP TRIGGER z_test_like_final_wait ON whaleu_ratings.like_transitions;DROP FUNCTION whaleu_ratings.test_like_final_wait()',
          );
          await f.certify(b.accountId, {});
        }
      },
    );
  },
);
