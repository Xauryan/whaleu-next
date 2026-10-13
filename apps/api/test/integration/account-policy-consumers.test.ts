import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { accountAppealsFixture } from '../support/account-appeals-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

type Fixture = Awaited<ReturnType<typeof accountAppealsFixture>>;
type Actor = Awaited<ReturnType<Fixture['actor']>>;
async function rawSavedReceipt(
  tx: PoolClient,
  actor: string,
  post: string,
  rejected = false,
) {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO whaleu_community.saved_requests(account_id,client_request_id,payload_hash,operation,post_id,desired,channel)
    VALUES($1,$2,$3,'set_post_saved',$4,true,NULL)`,
    [actor, id, 'a'.repeat(64), post],
  );
  await tx.query(
    `UPDATE whaleu_community.saved_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2`,
    [
      actor,
      id,
      JSON.stringify({
        requestId: id,
        operation: 'set_post_saved',
        postId: post,
        desired: true,
        channel: null,
        ...(rejected
          ? { outcome: 'rejected', code: 'COMMUNITY_ACTION_RESTRICTED' }
          : { outcome: 'applied' }),
      }),
    ],
  );
  return id;
}
const causalFailure = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === '23514' &&
  'constraint' in error &&
  error.constraint === 'account_policy_consumer_causal';

test(
  'actual mute/suspension consumers preserve browsing, own settings, bounded notices, cleanup and old receipts',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor(),
      reader = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const muteSource = await f.publish(owner),
      suspensionSource = await f.publish(owner),
      retainedPost = await f.publish(owner),
      otherPost = await f.publish(reader);
    const auth = (actor: Actor) => ({
      Authorization: `Bearer ${actor.accessToken}`,
    });
    const saveId = randomUUID();
    const saved = await request(f.http)
      .put(`/v1/community/posts/${otherPost.id}/save`)
      .set(auth(owner))
      .send({ clientRequestId: saveId });
    profileOk(saved);
    assert.equal(saved.body.outcome, 'applied');
    const original = (
      await f.pool.query(
        'SELECT to_jsonb(q) value FROM whaleu_community.saved_requests q WHERE account_id=$1 AND client_request_id=$2',
        [owner.accountId, saveId],
      )
    ).rows[0]!.value;
    const guestBefore = await request(f.http).get(
      `/v1/community/posts/${retainedPost.id}`,
    );
    await f.issue(admin, owner, muteSource, 'interaction_mute');
    profileOk(
      await request(f.http)
        .get(`/v1/community/posts/${otherPost.id}`)
        .set(auth(owner)),
    );
    profileOk(
      await request(f.http)
        .get(`/v1/community/posts/${retainedPost.id}`)
        .set(auth(reader)),
    );
    const guestAfter = await request(f.http).get(
      `/v1/community/posts/${retainedPost.id}`,
    );
    assert.equal(
      guestAfter.status,
      guestBefore.status,
      'author mute does not change guest authority',
    );
    const profile = await request(f.http)
      .get('/v1/me/profile')
      .set(auth(owner));
    profileOk(profile);
    profileOk(
      await request(f.http)
        .patch('/v1/me/preferences')
        .set(auth(owner))
        .send({
          expectedRevision: profile.body.revision,
          preferences: { showHotTopic: false },
        }),
    );
    const ownerGrant = await f.grant(owner, 'super_admin', null);
    await f.removalManagement(otherPost, owner); // Muted administrator read retains independent role/source gates.
    const denied = await request(f.http)
      .put(`/v1/community/posts/${otherPost.id}/save`)
      .set(auth(owner))
      .send({ clientRequestId: randomUUID() });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'SAFETY_ACTION_RESTRICTED');
    const replay = await request(f.http)
      .put(`/v1/community/posts/${otherPost.id}/save`)
      .set(auth(owner))
      .send({ clientRequestId: saveId });
    profileOk(replay);
    assert.deepEqual(replay.body, saved.body);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(q) value FROM whaleu_community.saved_requests q WHERE account_id=$1 AND client_request_id=$2',
          [owner.accountId, saveId],
        )
      ).rows[0]!.value,
      original,
    );
    profileOk(
      await request(f.http)
        .put(`/v1/community/posts/${otherPost.id}/update-preferences`)
        .set(auth(owner))
        .send({
          clientRequestId: randomUUID(),
          channel: 'external',
          enabled: true,
        }),
    );
    profileOk(
      await request(f.http)
        .delete(`/v1/community/posts/${otherPost.id}/save`)
        .set(auth(owner))
        .send({ clientRequestId: randomUUID() }),
    );
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
        [ownerGrant],
      );
    });
    await f.issue(admin, owner, suspensionSource, 'access_suspension');
    const suspended = await request(f.http)
      .get(`/v1/community/posts/${otherPost.id}`)
      .set(auth(owner));
    assert.equal(suspended.status, 403, JSON.stringify(suspended.body));
    assert.equal(suspended.body.error.code, 'SAFETY_ACCESS_SUSPENDED');
    profileOk(
      await request(f.http).get('/v1/me/safety/status').set(auth(owner)),
    );
    for (const route of [
      '/v1/me/community/updates',
      '/v1/me/ratings/updates',
      '/v2/me/ratings/updates',
      '/v1/me/system-notices',
    ]) {
      const notices = await request(f.http).get(route).set(auth(owner));
      profileOk(notices);
      if (route !== '/v1/me/system-notices')
        for (const item of notices.body.items ?? []) {
          assert.equal(item.status, 'unavailable');
          for (const field of ['target', 'preview', 'author', 'actor', 'media'])
            assert.equal(field in item, false);
        }
    }
    const cold = await request(f.http)
      .get(`/v1/me/community/saved-requests/${saveId}`)
      .set(auth(owner));
    profileOk(cold);
    assert.deepEqual(cold.body, saved.body);
  },
);

test(
  'raw pending-to-terminal writer keeps original actor policy through late issuance and does not admit denied success',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const cause = await f.publish(owner),
      target = await f.publish(admin);
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await rawSavedReceipt(client, owner.accountId, target.id);
      await f.issue(admin, owner, cause, 'interaction_mute');
      await assert.rejects(client.query('COMMIT'), causalFailure);
      await client.query('ROLLBACK');
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await rawSavedReceipt(client, owner.accountId, target.id);
      await assert.rejects(
        client.query('SET CONSTRAINTS ALL IMMEDIATE'),
        causalFailure,
      );
      await client.query('ROLLBACK');
      await assert.rejects(
        client.query(
          'UPDATE whaleu_safety.account_punishment_heads SET subject_id=subject_id WHERE false',
        ),
        (error: unknown) =>
          !!error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '23514',
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  },
);

test(
  'raw negative receipt expires by database time and every inventoried source has its exact capture trigger',
  { timeout: 240000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const owners = JSON.parse(
      await readFile(
        new URL(
          '../../../../docs/account-moderation/sql-source-owners.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { relation: string }[];
    const installed = (
      await f.pool.query<{ relation: string }>(
        `SELECT n.nspname||'.'||c.relname relation FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND t.tgfoid='whaleu_safety.account_policy_consumer_capture()'::regprocedure ORDER BY 1`,
      )
    ).rows.map((r) => r.relation);
    assert.equal(new Set(installed).size, installed.length);
    assert.deepEqual(installed, owners.map((r) => r.relation).sort());
    const admin = await f.actor(),
      owner = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const target = await f.publish(admin);
    const cause = await f.discussion(owner, target.id);
    const view = await f.removalManagement(cause, admin);
    const command = {
      ...f.removalCommand(cause, view.targetVersion),
      version: 2,
      punishment: {
        kind: 'interaction_mute',
        duration: { kind: 'finite', unit: 'minutes', value: 1 },
        reason: 'Synthetic DB-time negative receipt expiry',
        expectedRevision: '0',
      },
    };
    profileOk(
      await request(f.http)
        .post('/v1/community/admin-discussion-removal/commands')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(command),
    );
    const remaining = (
      await f.pool.query<{ milliseconds: number }>(
        `SELECT greatest(0,extract(epoch FROM ends_at-clock_timestamp())*1000)::float8 milliseconds FROM whaleu_safety.account_punishments WHERE actor_id=$1 AND request_id=$2`,
        [admin.accountId, command.clientRequestId],
      )
    ).rows[0]!.milliseconds;
    // Wait outside any transaction; production SQL/deadline budgets stay unchanged.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, remaining - 1500)),
    );
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await rawSavedReceipt(client, owner.accountId, target.id, true);
      // No forged ledger row, clock override or shortening of an immutable issue.
      await client.query(
        `SELECT pg_sleep(greatest(0,extract(epoch FROM p.ends_at-clock_timestamp()))+0.025) FROM whaleu_safety.account_punishments p WHERE p.actor_id=$1 AND p.request_id=$2`,
        [admin.accountId, command.clientRequestId],
      );
      await assert.rejects(client.query('COMMIT'), causalFailure);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  },
);
