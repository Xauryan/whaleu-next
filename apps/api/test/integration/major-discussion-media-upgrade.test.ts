import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  majorDiscussionFixture,
  reviewMajorDiscussion,
} from '../support/major-discussion-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { majorDiscussionIntentHash } from '../../src/majors/discussion/service.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
const rejectsConstraint = (e: unknown) =>
  !!e && typeof e === 'object' && 'code' in e && e.code === '23514';
test(
  '0124→0125 forward upgrade preserves real v1 rows, envelope hashes and receipts while raw v1 empty/image-bearing commands remain forbidden',
  { timeout: 180000 },
  async (t) => {
    const base = await directoryRuntimeFixture(124),
      f = await majorDiscussionFixture(base);
    t.after(() => f.close());
    const actor = await f.actor({ identity: false }),
      w = f.add(),
      catalog = await f.accept([w]);
    await f.acceptDiscussion([w.id]);
    const command = f.root(catalog, w, '  exact v1 😀 text\n'),
      review = await reviewMajorDiscussion(
        f.pool,
        actor.accountId,
        w.id,
        command,
      ),
      commentId = randomUUID();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1) ON CONFLICT DO NOTHING',
        [actor.accountId],
      ),
    );
    const hash = majorDiscussionIntentHash(
      actor.accountId,
      w.id,
      null,
      'major.discussion.root.v1',
      command,
    );
    const receipt = await inTransaction(
      f.pool,
      async (tx) => {
        const row = (
          await tx.query<{ created_at: Date }>(
            `INSERT INTO whaleu_majors.major_discussion_comments(id,major_id,actor_id,request_id,catalog_id,major_revision,population_assertion_id,review_decision_id,body) VALUES($1,$2,$3,$4,$5,$6,whaleu_majors.major_discussion_history($2,'population',clock_timestamp()),$7,$8) RETURNING created_at`,
            [
              commentId,
              w.id,
              actor.accountId,
              command.clientRequestId,
              catalog,
              w.revision,
              review,
              command.body,
            ],
          )
        ).rows[0]!;
        const value = {
          requestId: command.clientRequestId,
          operation: 'major.discussion.root.v1',
          majorId: w.id,
          outcome: 'applied',
          commentId,
          createdAt: row.created_at.toISOString(),
        };
        await tx.query(
          'INSERT INTO whaleu_majors.major_discussion_commands(actor_id,request_id,session_id,major_id,subject_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8)',
          [
            actor.accountId,
            command.clientRequestId,
            actor.sessionId,
            w.id,
            value.operation,
            command,
            hash,
            value,
          ],
        );
        return value;
      },
      { isolationLevel: 'read committed' },
    );
    const before = (
      await f.pool.query<{
        intent_hash: string;
        command: string;
        receipt: string;
        digest: string;
        body: string;
      }>(
        `SELECT q.intent_hash,q.command::text command,q.receipt::text receipt,d.digest,c.body FROM whaleu_majors.major_discussion_commands q JOIN whaleu_majors.major_discussion_comments c ON(c.actor_id,c.request_id)=(q.actor_id,q.request_id) JOIN whaleu_community.major_discussion_review_decisions d ON d.id=c.review_decision_id WHERE q.actor_id=$1 AND q.request_id=$2`,
        [actor.accountId, command.clientRequestId],
      )
    ).rows[0]!;
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    );
    await runMigrations(f.pool, migrations, { mode: 'up' });
    await f.restartApp();
    const after = (
      await f.pool.query(
        `SELECT q.intent_hash,q.command::text command,q.receipt::text receipt,d.digest,c.body FROM whaleu_majors.major_discussion_commands q JOIN whaleu_majors.major_discussion_comments c ON(c.actor_id,c.request_id)=(q.actor_id,q.request_id) JOIN whaleu_community.major_discussion_review_decisions d ON d.id=c.review_decision_id WHERE q.actor_id=$1 AND q.request_id=$2`,
        [actor.accountId, command.clientRequestId],
      )
    ).rows[0];
    assert.deepEqual(after, before);
    const columns = (
      await f.pool.query(
        'SELECT publication_version,image_set,media_review_decision_id FROM whaleu_majors.major_discussion_comments WHERE id=$1',
        [commentId],
      )
    ).rows[0];
    assert.deepEqual(columns, {
      publication_version: 1,
      image_set: [],
      media_review_decision_id: null,
    });
    const http = f.app.getHttpServer(),
      auth = 'Bearer ' + actor.accessToken;
    const replay = await request(http)
      .post(`/v1/majors/${w.id}/discussion`)
      .set('Authorization', auth)
      .send(command);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, receipt);
    for (const version of ['v1', 'v2']) {
      const page = await request(http)
        .get(`/${version}/majors/${w.id}/discussion`)
        .set('Authorization', auth);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.equal(page.body.items[0].body, command.body);
      if (version === 'v1') assert.equal('images' in page.body.items[0], false);
      else assert.deepEqual(page.body.items[0].images, []);
    }
    for (const changed of [
      { ...command, clientRequestId: randomUUID(), body: '' },
      { ...command, clientRequestId: randomUUID(), images: [] },
    ])
      await assert.rejects(
        inTransaction(
          f.pool,
          (tx) =>
            tx.query(
              'INSERT INTO whaleu_majors.major_discussion_commands(actor_id,request_id,session_id,major_id,subject_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8)',
              [
                actor.accountId,
                changed.clientRequestId,
                actor.sessionId,
                w.id,
                'major.discussion.root.v1',
                changed,
                majorDiscussionIntentHash(
                  actor.accountId,
                  w.id,
                  null,
                  'major.discussion.root.v1',
                  changed,
                ),
                {
                  requestId: changed.clientRequestId,
                  operation: 'major.discussion.root.v1',
                  majorId: w.id,
                  outcome: 'rejected',
                  code: 'MAJOR_DISCUSSION_CANCELLED',
                },
              ],
            ),
          { isolationLevel: 'read committed' },
        ),
        rejectsConstraint,
      );
    assert.equal(
      (
        await f.pool.query(
          "SELECT whaleu_majors.major_discussion_body_valid('') valid",
        )
      ).rows[0]!.valid,
      false,
    );
  },
);
