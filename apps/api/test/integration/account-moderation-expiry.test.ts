import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import request from 'supertest';
import { AccountModerationService } from '../../src/safety/account-moderation/service.js';
import { AccountPunishmentOwner } from '../../src/safety/account-moderation/owner.js';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

test(
  'real finite expiry uses the exact database boundary, rejects a crossing status observation and exposes the independent mute',
  { timeout: 180000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor(),
      other = await f.actor(),
      host = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const post = await f.publish(host);
    const targets = [
      await f.discussion(other, post.id),
      await f.discussion(owner, post.id),
      await f.discussion(owner, post.id),
    ];
    const issue = async (
      target: (typeof targets)[number],
      kind: 'interaction_mute' | 'access_suspension',
      minutes: number,
    ) => {
      const management = await request(f.http)
        .get('/v1/community/admin-discussion-removal/management')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .query({ kind: target.kind, id: target.id, version: '2' });
      profileOk(management);
      const applied = await request(f.http)
        .post('/v1/community/admin-discussion-removal/commands')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          version: 2,
          clientRequestId: randomUUID(),
          target: { kind: target.kind, id: target.id },
          expectedTargetVersion: management.body.targetVersion,
          action: 'remove_discussion',
          punishment: {
            kind,
            expectedRevision: '0',
            reason: 'Synthetic exact expiry',
            duration: { kind: 'finite', unit: 'minutes', value: minutes },
          },
        });
      profileOk(applied);
      assert.equal(applied.body.outcome, 'applied');
      return applied.body.punishment.punishmentId as string;
    };
    const otherMute = await issue(targets[0]!, 'interaction_mute', 1);
    const mute = await issue(targets[1]!, 'interaction_mute', 2);
    const suspension = await issue(targets[2]!, 'access_suspension', 1);
    const until = (
      await f.pool.query<{ at: string }>(
        'SELECT ends_at::text at FROM whaleu_safety.account_punishments WHERE id=$1',
        [suspension],
      )
    ).rows[0]!.at;
    const status = (actor: typeof owner) =>
      request(f.http)
        .get('/v1/me/safety/status')
        .set('Authorization', `Bearer ${actor.accessToken}`);
    assert.equal((await status(owner)).body.effective, 'access_suspension');
    const wait = (
      await f.pool.query<{ wait: number }>(
        'SELECT greatest(extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000-1500,0)::float8 wait',
        [until],
      )
    ).rows[0]!.wait;
    await sleep(wait);
    const reader = f.moderationApp.get(AccountPunishmentOwner),
      original = reader.view.bind(reader);
    let crossed = false;
    reader.view = async (id, tx) => {
      if (id === suspension && !crossed) {
        crossed = true;
        const remaining = (
          await tx.query<{ remaining: number }>(
            'SELECT (extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::float8 remaining',
            [until],
          )
        ).rows[0]!.remaining;
        assert.equal(typeof remaining, 'number');
        assert.ok(
          Number.isFinite(remaining) && remaining > 0,
          'Status made its initial effective observation before expiry',
        );
        // Scheduling hook only: no clock, policy, persisted row or proof is replaced.
        await sleep(remaining + 40);
      }
      return original(id, tx);
    };
    const service = f.moderationApp.get(AccountModerationService);
    const originalStatus = service.status.bind(service);
    let observedFailure: unknown;
    service.status = async (token: string) => {
      try {
        return await originalStatus(token);
      } catch (error) {
        observedFailure = error;
        throw error;
      }
    };
    try {
      const result = await status(owner);
      if (result.status !== 503)
        throw observedFailure ?? new Error(JSON.stringify(result.body));
      assert.equal(result.status, 503, JSON.stringify(result.body));
      assert.equal(result.body.error.code, 'SAFETY_MODERATION_UNAVAILABLE');
      assert.equal(crossed, true);
    } finally {
      reader.view = original;
      service.status = originalStatus;
    }
    const current = await status(owner);
    profileOk(current);
    assert.equal(current.body.effective, 'interaction_mute');
    assert.equal(
      current.body.current.find(
        (p: { punishmentId: string }) => p.punishmentId === suspension,
      ).state,
      'expired',
    );
    assert.equal(
      current.body.current.find(
        (p: { punishmentId: string }) => p.punishmentId === mute,
      ).state,
      'active',
    );
    const otherCurrent = await status(other);
    profileOk(otherCurrent);
    assert.equal(otherCurrent.body.effective, 'clear');
    assert.equal(
      otherCurrent.body.current.find(
        (p: { punishmentId: string }) => p.punishmentId === otherMute,
      ).state,
      'expired',
    );
    await request(f.http)
      .get(`/v1/community/posts/${post.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_safety.account_punishment_terminals WHERE punishment_id=ANY($1::uuid[])',
          [[mute, suspension, otherMute]],
        )
      ).rows[0]!.n,
      0,
      'Natural expiry does not fabricate release events or reset another kind',
    );
  },
);
