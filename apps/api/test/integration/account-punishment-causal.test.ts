import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';
import type { PunishmentSelection } from '../../src/safety/account-moderation/contracts.js';

type Fixture = Awaited<ReturnType<typeof adminDiscussionRemovalFixture>>;
type Actor = Awaited<ReturnType<Fixture['actor']>>;
type Target = { kind: 'post' | 'comment' | 'reply'; id: string };
const endpoint = (target: Target) =>
  `/v1/community/admin-${target.kind === 'post' ? 'post' : 'discussion'}-removal`;
async function command(
  f: Fixture,
  admin: Actor,
  target: Target,
  punishment: PunishmentSelection,
) {
  const management = await request(f.http)
    .get(endpoint(target) + '/management')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .query({ kind: target.kind, id: target.id, version: '2' });
  profileOk(management);
  assert.equal(
    management.body.punishmentOptions[punishment.kind].revision,
    punishment.expectedRevision,
  );
  return {
    version: 2,
    clientRequestId: randomUUID(),
    target: { kind: target.kind, id: target.id },
    expectedTargetVersion: management.body.targetVersion,
    action: target.kind === 'post' ? 'remove_post' : 'remove_discussion',
    punishment,
  };
}
const send = (
  f: Fixture,
  admin: Actor,
  body: Awaited<ReturnType<typeof command>>,
  cancel = false,
) =>
  request(f.http)
    .post(endpoint(body.target) + '/commands' + (cancel ? '/cancel' : ''))
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send(body);
const selection = (
  kind: PunishmentSelection['kind'] = 'interaction_mute',
  expectedRevision = '0',
): PunishmentSelection => ({
  kind,
  duration: { kind: 'finite', unit: 'days', value: 7 },
  reason: 'Synthetic causal test',
  expectedRevision,
});

test(
  'actual HTTP post/root/reply causal punishment binds exact original author, tombstone, notices and replay',
  { timeout: 300000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      host = await f.actor();
    await f.grant(admin);
    for (const kind of ['post', 'comment', 'reply'] as const) {
      const subject = await f.actor();
      const post = await f.publish(kind === 'post' ? subject : host, {
        authorMode: 'anonymous',
      });
      const root =
        kind === 'post'
          ? null
          : await f.discussion(kind === 'comment' ? subject : host, post.id, {
              authorMode: 'anonymous',
            });
      const target: Target =
        kind === 'post'
          ? { kind, id: post.id }
          : kind === 'comment'
            ? root!
            : await f.discussion(subject, post.id, {
                rootId: root!.id,
                authorMode: 'anonymous',
              });
      const body = await command(
        f,
        admin,
        target,
        selection(kind === 'reply' ? 'access_suspension' : 'interaction_mute'),
      );
      if (kind !== 'post')
        body.punishment.duration = {
          kind: 'finite',
          unit: 'minutes',
          value: 7,
        };
      const result = await send(f, admin, body);
      profileOk(result);
      assert.equal(result.body.outcome, 'applied');
      assert.equal(result.body.version, 2);
      assert.deepEqual(result.body.selection, body.punishment);
      assert.ok(!JSON.stringify(result.body).includes(subject.accountId));
      const id = result.body.punishment.punishmentId;
      const p = (
        await f.pool.query(
          'SELECT * FROM whaleu_safety.account_punishments WHERE id=$1',
          [id],
        )
      ).rows[0]!;
      assert.equal(p.subject_id, subject.accountId);
      assert.equal(p.source_kind, kind);
      assert.equal(p.source_id, target.id);
      assert.equal(p.source_event_id, result.body.eventId);
      assert.equal(p.revision, '1');
      const table =
        kind === 'post'
          ? 'posts'
          : kind === 'comment'
            ? 'root_comments'
            : 'replies';
      assert.ok(
        (
          await f.pool.query(
            `SELECT deleted_at FROM whaleu_community.${table} WHERE id=$1`,
            [target.id],
          )
        ).rows[0]!.deleted_at,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer n FROM whaleu_notifications.account_punishment_notices WHERE punishment_id=$1',
            [id],
          )
        ).rows[0]!.n,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::integer n FROM whaleu_notifications.admin_${kind === 'post' ? 'post' : 'discussion'}_removal_notices WHERE event_id=$1`,
            [result.body.eventId],
          )
        ).rows[0]!.n,
        1,
      );
      const replay = await send(f, admin, body);
      profileOk(replay);
      assert.deepEqual(replay.body, result.body);
      const cancelled = await send(f, admin, body, true);
      profileOk(cancelled);
      assert.deepEqual(cancelled.body, result.body);
      const v1 = {
        clientRequestId: body.clientRequestId,
        target: body.target,
        action: body.action,
        expectedTargetVersion: body.expectedTargetVersion,
      };
      assert.equal(
        (
          await request(f.http)
            .post(endpoint(target) + '/commands')
            .set('Authorization', `Bearer ${admin.accessToken}`)
            .send(v1)
        ).status,
        409,
      );
      const changed = {
        ...body,
        punishment: {
          ...body.punishment,
          reason: 'Different immutable intent',
        },
      };
      assert.equal((await send(f, admin, changed)).status, 409);
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer n FROM whaleu_safety.account_punishments WHERE id=$1',
            [id],
          )
        ).rows[0]!.n,
        1,
      );
    }
  },
);

test(
  'v2 cancellation is identity-only; permanent replacement, protection and post-minute rejection leave source untouched',
  { timeout: 300000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      subject = await f.actor(),
      protectedAuthor = await f.actor();
    await f.grant(admin);
    await f.grant(protectedAuthor);
    const post = await f.publish(subject),
      second = await f.publish(subject),
      protectedPost = await f.publish(protectedAuthor);
    const cancelled = await command(
      f,
      admin,
      { kind: 'post', id: post.id },
      selection(),
    );
    const cancel = await send(f, admin, cancelled, true);
    profileOk(cancel);
    assert.equal(cancel.body.code, 'ADMIN_POST_REMOVAL_CANCELLED');
    assert.deepEqual(cancel.body.selection, cancelled.punishment);
    const permanent = await command(
      f,
      admin,
      { kind: 'post', id: post.id },
      { ...selection(), duration: { kind: 'permanent' } },
    );
    profileOk(await send(f, admin, permanent));
    const shortened = await command(
      f,
      admin,
      { kind: 'post', id: second.id },
      selection('interaction_mute', '1'),
    );
    assert.equal((await send(f, admin, shortened)).status, 409);
    const minute = {
      ...shortened,
      clientRequestId: randomUUID(),
      punishment: {
        ...shortened.punishment,
        duration: {
          kind: 'finite' as const,
          unit: 'minutes' as const,
          value: 1,
        },
      },
    };
    assert.equal((await send(f, admin, minute)).status, 400);
    const protectedBody = await command(
      f,
      admin,
      { kind: 'post', id: protectedPost.id },
      selection(),
    );
    assert.equal((await send(f, admin, protectedBody)).status, 403);
    for (const id of [second.id, protectedPost.id])
      assert.equal(
        (
          await f.pool.query(
            'SELECT deleted_at FROM whaleu_community.posts WHERE id=$1',
            [id],
          )
        ).rows[0]!.deleted_at,
        null,
      );
  },
);

test(
  'emitted native removal controls submit both punishment kinds through AppModule and PostgreSQL',
  { timeout: 300000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      subject = await f.actor(),
      host = await f.actor();
    await f.grant(admin);
    const post = await f.publish(subject, { authorMode: 'anonymous' }),
      parent = await f.publish(host),
      root = await f.discussion(subject, parent.id, {
        authorMode: 'anonymous',
      });
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/account-punishment-causal-native-child.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
      },
    );
    t.after(() => {
      if (child.connected) child.disconnect();
      if (child.exitCode === null) child.kill();
    });
    child.stdout?.resume();
    let logs = '';
    child.stderr?.on('data', (d) => (logs += String(d)));
    const result = await new Promise<{ commands: unknown[] }>(
      (resolve, reject) => {
        child.on(
          'message',
          (value: { event: string; commands: unknown[]; error?: string }) => {
            if (value.event === 'done') resolve(value);
            if (value.event === 'failed') reject(new Error(value.error));
          },
        );
        child.on('exit', (code) => {
          if (code) reject(new Error(logs));
        });
        const server = f.http as { address(): { port: number } };
        child.send({
          port: server.address().port,
          admin,
          subjectId: subject.accountId,
          targets: [
            {
              target: { kind: 'post', id: post.id },
              kind: 'interaction_mute',
              unit: 'days',
            },
            { target: root, kind: 'access_suspension', unit: 'minutes' },
          ],
        });
      },
    );
    assert.equal(result.commands.length, 2);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_safety.account_punishments WHERE subject_id=$1',
          [subject.accountId],
        )
      ).rows[0]!.n,
      2,
    );
  },
);

test(
  'raw v2 source insertion cannot commit a punishment without the real removal closure; direct and zero-row ledger writers fail',
  { timeout: 300000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      subject = await f.actor();
    const grant = await f.grant(admin);
    const post = await f.publish(subject);
    const body = await command(
      f,
      admin,
      { kind: 'post', id: post.id },
      selection(),
    );
    const { adminPostRemovalIntentHash } =
      await import('../../src/community/admin-removal/evidence.js');
    const { hashToken } = await import('../../src/identity/tokens.js');
    const parsed = (
      await import('../../src/community/admin-removal/contracts.js')
    ).adminPostRemovalCommandSchema.parse(body);
    const receipt = {
      version: 2,
      requestId: body.clientRequestId,
      target: body.target,
      expectedTargetVersion: body.expectedTargetVersion,
      action: body.action,
      outcome: 'applied',
      eventId: randomUUID(),
      recordedAt: new Date().toISOString(),
      selection: body.punishment,
      punishment: {
        punishmentId: randomUUID(),
        kind: body.punishment.kind,
        revision: '1',
      },
    };
    const tx = await f.pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      receipt.recordedAt = (
        await tx.query<{ at: string }>(
          `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at`,
        )
      ).rows[0]!.at;
      await tx.query(
        `INSERT INTO whaleu_community.admin_post_removal_commands(actor_id,request_id,session_id,token_hash,target_id,grant_id,intent_hash,command,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          admin.accountId,
          body.clientRequestId,
          admin.sessionId,
          hashToken(admin.accessToken),
          post.id,
          grant,
          adminPostRemovalIntentHash(admin.accountId, parsed),
          body,
          receipt,
        ],
      );
      assert.equal(
        (
          await tx.query(
            'SELECT count(*)::integer n FROM whaleu_safety.account_punishments WHERE id=$1',
            [receipt.punishment.punishmentId],
          )
        ).rows[0]!.n,
        1,
        'source trigger alone derives pending ledger row',
      );
      await assert.rejects(() => tx.query('COMMIT'));
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_safety.account_punishments WHERE id=$1',
          [receipt.punishment.punishmentId],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT deleted_at FROM whaleu_community.posts WHERE id=$1',
          [post.id],
        )
      ).rows[0]!.deleted_at,
      null,
    );
    await assert.rejects(() =>
      f.pool.query(
        'SELECT whaleu_safety.issue_account_punishment($1,$2,$3,$4)',
        [admin.accountId, body.clientRequestId, 'post', post.id],
      ),
    );
    await assert.rejects(() =>
      f.pool.query(
        'INSERT INTO whaleu_safety.account_punishments SELECT * FROM whaleu_safety.account_punishments WHERE false',
      ),
    );
    const epochBefore = (
      await f.pool.query(
        'SELECT whaleu_safety.account_punishment_authority_epoch() revision',
      )
    ).rows[0]!.revision;
    await f.pool.query(
      'UPDATE whaleu_authorization.role_grants SET revoked_at=revoked_at WHERE false',
    );
    const epochAfter = (
      await f.pool.query(
        'SELECT whaleu_safety.account_punishment_authority_epoch() revision',
      )
    ).rows[0]!.revision;
    assert.equal(
      BigInt(epochAfter),
      BigInt(epochBefore) + 1n,
      'zero-row authority write leaves monotone evidence',
    );
    for (const sql of [
      'DELETE FROM whaleu_authorization.account_punishment_authority_epoch',
      'TRUNCATE whaleu_authorization.account_punishment_authority_epoch',
      'UPDATE whaleu_authorization.account_punishment_authority_epoch SET revision=0',
      'UPDATE whaleu_authorization.account_punishment_authority_epoch SET revision=revision+1 WHERE false',
    ])
      await assert.rejects(() => f.pool.query(sql));
    assert.equal(
      (
        await f.pool.query(
          'SELECT whaleu_safety.account_punishment_authority_epoch() revision',
        )
      ).rows[0]!.revision,
      epochAfter,
    );
  },
);
