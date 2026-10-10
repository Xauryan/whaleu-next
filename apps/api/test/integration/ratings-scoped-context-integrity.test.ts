import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingScopedFixture } from '../support/rating-scoped-fixture.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingScopedContextService } from '../../src/ratings/scoped/context.service.js';
import { ratingScopedDigest } from '../../src/ratings/scoped/protocol-registry.js';

test(
  'scoped context stored digests prove immutable full records without caching current authority',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    await f.seedScopedCatalogs({ different: false });
    await f.publish({ activate: true });
    const context = await f.scopedContext(f.creator);
    const original = (
      await f.pool.query(
        'SELECT * FROM whaleu_ratings.scoped_contexts WHERE id=$1',
        [context.id],
      )
    ).rows[0]!;
    await t.test(
      'database-generated digest equals the complete application canonical record',
      async () => {
        assert.equal(
          original.record_digest,
          ratingScopedDigest('context-record', {
            context: original.context,
            authority: original.authority,
            protocolTuples: original.protocol_tuples,
          }),
        );
        const column = (
          await f.pool.query(
            `SELECT attgenerated FROM pg_attribute WHERE attrelid='whaleu_ratings.scoped_contexts'::regclass AND attname='record_digest'`,
          )
        ).rows[0]!;
        assert.equal(column.attgenerated, 's');
      },
    );
    for (const statement of [
      "UPDATE whaleu_ratings.scoped_contexts SET authority=jsonb_set(authority,'{sourceVector}','[]') WHERE id=$1",
      'DELETE FROM whaleu_ratings.scoped_contexts WHERE id=$1',
    ])
      await t.test(
        'immutable record rejects ' + statement.split(' ')[0],
        async () => {
          await assert.rejects(
            f.pool.query(statement, [context.id]),
            (error: unknown) =>
              !!error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === '23514',
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_ratings.scoped_contexts WHERE id=$1',
                [context.id],
              )
            ).rows[0],
            original,
          );
        },
      );
    await t.test(
      'a caller cannot provide a trusted digest for a forged record',
      async () => {
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_ratings.scoped_contexts(id,account_id,session_id,token_digest,context,authority,protocol_tuples,record_digest,issued_at,valid_until)
      SELECT $2,account_id,session_id,token_digest,context,authority,protocol_tuples,record_digest,issued_at,valid_until FROM whaleu_ratings.scoped_contexts WHERE id=$1`,
            [context.id, randomUUID()],
          ),
          (error: unknown) =>
            !!error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === '428C9',
        );
      },
    );
    await t.test(
      'a newly forged immutable source vector gets its own digest and fails current authority recapture',
      async () => {
        const id = randomUUID(),
          token = randomBytes(32).toString('base64url'),
          digest = createHash('sha256').update(token).digest('hex');
        const forged = (
          await f.pool.query(
            `INSERT INTO whaleu_ratings.scoped_contexts(id,account_id,session_id,token_digest,context,authority,protocol_tuples,issued_at,valid_until)
      SELECT $2,account_id,session_id,$3,context||jsonb_build_object('id',$2::uuid,'token',$4::text,'tokenDigest',$3::text),
      jsonb_set(authority,'{sourceVector}','[]'),protocol_tuples,issued_at,valid_until FROM whaleu_ratings.scoped_contexts WHERE id=$1 RETURNING record_digest`,
            [context.id, id, digest, token],
          )
        ).rows[0]!;
        assert.notEqual(forged.record_digest, original.record_digest);
        const response = await f
          .auth(request(f.http).get('/v2/ratings/categories'), f.creator)
          .query({ contextId: id, contextToken: token });
        assert.equal(response.status, 409, JSON.stringify(response.body));
        assert.equal(response.body.error.code, 'RATING_SCOPED_CONTEXT_CHANGED');
        const current = await f
          .auth(request(f.http).get('/v2/ratings/categories'), f.creator)
          .query({ contextId: context.id, contextToken: context.token });
        assert.equal(current.status, 200, JSON.stringify(current.body));
      },
    );
    await t.test(
      'two overlapping context issuances retain their own exact rows without conflicting or advancing public epochs',
      async () => {
        const db = f.app.get(DatabaseService),
          owner = f.app.get(RatingScopedContextService);
        const epochs = async () =>
          (
            await f.pool.query(
              `SELECT jsonb_build_object('source',(SELECT epoch FROM whaleu_ratings.scoped_source_epoch),'protocol',(SELECT epoch FROM whaleu_ratings.scope_protocol_epoch),'navigation',(SELECT epoch FROM whaleu_ratings.navigation_epoch),'random',(SELECT epoch FROM whaleu_ratings.random_pool_epoch)) value`,
            )
          ).rows[0]!.value;
        const before = await epochs();
        const gate = () => {
          let arrive!: () => void, release!: () => void;
          const arrived = new Promise<void>((resolve) => {
            arrive = resolve;
          });
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          return { arrived, released, arrive, release };
        };
        const first = gate(),
          second = gate();
        const issue = (barrier: ReturnType<typeof gate>) =>
          db.transaction(
            async (tx) => {
              const value = await owner.create(
                f.creator.accessToken,
                {
                  selector: { kind: 'global' },
                  mode: 'public',
                  purpose: 'read',
                },
                tx,
              );
              barrier.arrive();
              await barrier.released;
              return value;
            },
            { isolationLevel: 'read committed' },
          );
        // Both INSERTs are genuinely uncommitted when the first final proof runs.
        const a = issue(first);
        const b = issue(second);
        const aResult = a.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const bResult = b.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let firstResult: Awaited<typeof aResult>;
        try {
          await Promise.all([first.arrived, second.arrived]);
          first.release();
          firstResult = await aResult;
        } finally {
          first.release();
          second.release();
        }
        const secondResult = await bResult;
        assert.ok(
          'value' in firstResult,
          'First read must commit while unrelated context INSERT remains uncommitted: ' +
            JSON.stringify(firstResult),
        );
        assert.ok(
          'value' in secondResult,
          'Second read must also commit: ' + JSON.stringify(secondResult),
        );
        assert.notEqual(firstResult.value.id, secondResult.value.id);
        assert.deepEqual(await epochs(), before);
        for (const current of [firstResult.value, secondResult.value]) {
          const response = await f
            .auth(request(f.http).get('/v2/ratings/categories'), f.creator)
            .query({ contextId: current.id, contextToken: current.token });
          assert.equal(response.status, 200, JSON.stringify(response.body));
        }
      },
    );
    await t.test(
      'a table-level exclusive blocker is rejected at final proof without waiting or changing context history',
      async () => {
        const db = f.app.get(DatabaseService),
          owner = f.app.get(RatingScopedContextService),
          blocker = await f.pool.connect();
        const before = (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.scoped_contexts',
          )
        ).rows[0]!.n;
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            'LOCK TABLE whaleu_ratings.scoped_contexts IN EXCLUSIVE MODE',
          );
          const started = performance.now();
          await assert.rejects(
            db.transaction(
              async (tx) => {
                await owner.resolve(
                  f.creator.accessToken,
                  { contextId: context.id, contextToken: context.token },
                  tx,
                  { purpose: 'read' },
                );
              },
              { isolationLevel: 'read committed' },
            ),
            (error: unknown) =>
              !!error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === 'RATING_SCOPE_UNAVAILABLE',
          );
          assert.ok(
            performance.now() - started < 1500,
            'Final relation fence must fail while blocker is still held',
          );
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.scoped_contexts',
            )
          ).rows[0]!.n,
          before,
        );
      },
    );
    await t.test(
      'TRUNCATE cannot remove immutable context history or its generated digest',
      async () => {
        await assert.rejects(
          f.pool.query('TRUNCATE whaleu_ratings.scoped_contexts CASCADE'),
          (error: unknown) =>
            !!error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === '23514',
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.scoped_contexts WHERE id=$1',
              [context.id],
            )
          ).rows[0],
          original,
        );
      },
    );
  },
);
