import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { IdentityMaintenance } from '../../src/identity/maintenance.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { DatabaseService } from '../../src/database/database.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import {
  accountAppealsFixture,
  ownAppealPath,
  adminAppealPath,
} from '../support/account-appeals-fixture.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

test(
  'muted and suspended unverified owners submit durable private cases independent of feedback, provider, phone or active reviewer',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor(),
      peer = await f.actor();
    await f.grant(admin);
    const posts = [await f.publish(owner), await f.publish(owner)];
    for (const [i, kind] of (
      ['interaction_mute', 'access_suspension'] as const
    ).entries()) {
      const punishment = await f.issue(admin, owner, posts[i]!, kind);
      await setRuntimeVerification(
        f.pool,
        owner.accountId,
        f.scope.institutionId,
        f.scope.home.regionId,
        'unverified',
        'unavailable',
      );
      const submitted = await f.submit(owner, punishment);
      const view = await f.detail(owner, submitted.receipt.appealId);
      assert.equal(view.state, 'pending');
      assert.equal(view.text, submitted.command.text);
      assert.deepEqual(view.punishment.punishmentId, punishment.punishmentId);
      assert.equal(
        (await f.send(peer, f.submitCommand(punishment))).status,
        404,
      );
      assert.equal(
        (await f.get(peer, `${ownAppealPath}/appeals/${view.appealId}`)).status,
        404,
      );
      assert.deepEqual(
        (
          await f.get(
            peer,
            `${ownAppealPath}/appeal-requests/${submitted.command.clientRequestId}`,
          )
        ).body,
        { state: 'not_recorded' },
      );
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_safety.account_appeals',
        )
      ).rows[0]!.n,
      2,
    );
  },
);

test(
  'same key, changed intent, duplicate pending keys and cancellation retain one immutable case without a lifetime appeal limit',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const punishment = await f.issue(
      admin,
      owner,
      await f.publish(owner),
      'interaction_mute',
    );
    const first = await f.submit(owner, punishment);
    assert.deepEqual((await f.send(owner, first.command)).body, first.receipt);
    assert.equal(
      (await f.send(owner, { ...first.command, text: 'changed' })).status,
      409,
    );
    const second = await f.submit(owner, punishment);
    assert.equal(second.receipt.appealId, first.receipt.appealId);
    assert.equal(second.receipt.reusedOpenCase, true);
    const cancelled = f.submitCommand(punishment),
      cancellation = await f.send(owner, cancelled, true);
    profileOk(cancellation);
    assert.equal(cancellation.body.code, 'SAFETY_MODERATION_CANCELLED');
    assert.deepEqual((await f.send(owner, cancelled)).body, cancellation.body);
    const upheld = await f.send(
      admin,
      await f.decision(admin, first.receipt.appealId, 'upheld'),
    );
    profileOk(upheld);
    assert.equal(upheld.body.decision, 'upheld');
    const later = await f.submit(owner, punishment);
    assert.notEqual(later.receipt.appealId, first.receipt.appealId);
    assert.equal(
      (await f.detail(owner, first.receipt.appealId)).decision?.outcome,
      'upheld',
    );
  },
);

test(
  'current super-admin exact release preserves other kind and baseline identity and appends one private result',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor(),
      school = await f.actor(),
      developer = await f.actor();
    await f.grant(admin, 'super_admin', null);
    await f.grant(school);
    await f.grant(developer, 'developer', null);
    const posts = [await f.publish(owner), await f.publish(owner)];
    const mute = await f.issue(admin, owner, posts[0]!, 'interaction_mute');
    const suspended = await f.issue(
      admin,
      owner,
      posts[1]!,
      'access_suspension',
    );
    const submitted = await f.submit(owner, suspended);
    for (const actor of [owner, school, developer]) {
      assert.equal(
        (await f.get(actor, `${adminAppealPath}/appeals`)).status,
        403,
      );
      assert.equal(
        (
          await f.get(
            actor,
            `${adminAppealPath}/appeals/${submitted.receipt.appealId}`,
          )
        ).status,
        403,
      );
    }
    const before = (
      await f.pool.query(
        'SELECT to_jsonb(a) identity,to_jsonb(h) safety FROM whaleu_identity.accounts a JOIN whaleu_safety.account_heads h ON h.account_id=a.id WHERE a.id=$1',
        [owner.accountId],
      )
    ).rows[0];
    const command = await f.decision(
      admin,
      submitted.receipt.appealId,
      'released',
    );
    const decided = await f.send(admin, command);
    profileOk(decided);
    assert.equal(decided.body.outcome, 'applied');
    assert.equal(decided.body.decision, 'released');
    assert.deepEqual((await f.send(admin, command)).body, decided.body);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(a) identity,to_jsonb(h) safety FROM whaleu_identity.accounts a JOIN whaleu_safety.account_heads h ON h.account_id=a.id WHERE a.id=$1',
          [owner.accountId],
        )
      ).rows[0],
      before,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_safety.account_punishment_terminals WHERE punishment_id=$1',
          [mute.punishmentId],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await f.detail(owner, submitted.receipt.appealId)).decision?.outcome,
      'released',
    );
    const notices = await f.get(owner, '/v1/me/system-notices');
    profileOk(notices);
    const result = notices.body.items.filter(
      (n: { kind: string }) => n.kind === 'account_appeal_decided',
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].appealId, submitted.receipt.appealId);
    assert.equal(JSON.stringify(result).includes(owner.accountId), false);
  },
);

test(
  'replacement makes an old case close accurately and can never release the new same-kind or other-kind punishment',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const posts = [
      await f.publish(owner),
      await f.publish(owner),
      await f.publish(owner),
    ];
    const old = await f.issue(admin, owner, posts[0]!, 'interaction_mute');
    const submitted = await f.submit(owner, old),
      stale = await f.decision(admin, submitted.receipt.appealId, 'released');
    const current = await f.issue(
      admin,
      owner,
      posts[1]!,
      'interaction_mute',
      old.revision,
    );
    const other = await f.issue(admin, owner, posts[2]!, 'access_suspension');
    const rejected = await f.send(admin, stale);
    profileOk(rejected);
    assert.equal(rejected.body.code, 'SAFETY_MODERATION_STALE');
    const closed = await f.send(
      admin,
      await f.decision(
        admin,
        submitted.receipt.appealId,
        'closed_no_longer_effective',
      ),
    );
    profileOk(closed);
    assert.equal(closed.body.decision, 'closed_no_longer_effective');
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_safety.account_punishment_terminals WHERE punishment_id=ANY($1::uuid[])',
          [[current.punishmentId, other.punishmentId]],
        )
      ).rowCount,
      0,
    );
  },
);

test(
  'historical appeal requests survive actual Identity maintenance and same-account replacement session recovery',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor(),
      peer = await f.actor();
    await f.grant(admin);
    const punishment = await f.issue(
      admin,
      owner,
      await f.publish(owner),
      'access_suspension',
    );
    const submitted = await f.submit(owner, punishment);
    const provider = (
      await f.pool.query<{ app_id: string; subject: string }>(
        'SELECT app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
        [owner.accountId],
      )
    ).rows[0]!;
    const accessToken = mintToken('access'),
      refreshToken = mintToken('refresh');
    const session = await f.app.get(IdentityRepository).createSession(
      {
        provider: 'wechat',
        appId: provider.app_id,
        subject: provider.subject,
      },
      { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
    );
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()-interval '40 days',refresh_expires_at=clock_timestamp()-interval '40 days',absolute_expires_at=clock_timestamp()-interval '40 days',revoked_at=clock_timestamp()-interval '40 days',revoke_reason='logout' WHERE id=$1",
        [owner.sessionId],
      );
      await tx.query(
        "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '40 days' WHERE session_id=$1",
        [owner.sessionId],
      );
    });
    const maintained = await new IdentityMaintenance(
      f.app.get(DatabaseService),
    ).run({ mode: 'apply', retentionDays: 30, batchSize: 100 });
    assert.equal(maintained.sessions, 1);
    const next = { ...owner, ...session, accessToken, refreshToken },
      path = `${ownAppealPath}/appeal-requests/${submitted.command.clientRequestId}`;
    assert.deepEqual((await f.get(next, path)).body, {
      state: 'recorded',
      receipt: submitted.receipt,
    });
    assert.deepEqual(
      (await f.send(next, submitted.command)).body,
      submitted.receipt,
    );
    assert.deepEqual((await f.get(peer, path)).body, { state: 'not_recorded' });
    assert.equal((await f.get(owner, path)).status, 401);
    assert.equal(
      (await f.get(next, `${ownAppealPath}/appeals/${randomUUID()}`)).status,
      404,
    );
  },
);

test(
  'original-key recovery and cancellation remain session-only while unrelated source and authority tables are locked',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const punishment = await f.issue(
      admin,
      owner,
      await f.publish(owner),
      'interaction_mute',
    );
    const submitted = await f.submit(owner, punishment);
    const lock = await f.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query(
        'LOCK TABLE whaleu_authorization.role_grants,whaleu_safety.account_heads,whaleu_safety.account_punishments,whaleu_safety.account_punishment_heads,whaleu_safety.account_punishment_terminals IN ACCESS EXCLUSIVE MODE',
      );
      const recovered = await f.get(
        owner,
        `${ownAppealPath}/appeal-requests/${submitted.command.clientRequestId}`,
      );
      profileOk(recovered);
      assert.deepEqual(recovered.body, {
        state: 'recorded',
        receipt: submitted.receipt,
      });
      const cancelled = await f.send(owner, f.submitCommand(punishment), true);
      profileOk(cancelled);
      assert.equal(cancelled.body.code, 'SAFETY_MODERATION_CANCELLED');
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  },
);

test(
  'case text, commands and decisions are immutable and missing result notice rolls back decision and exact release',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const punishment = await f.issue(
      admin,
      owner,
      await f.publish(owner),
      'access_suspension',
    );
    const submitted = await f.submit(owner, punishment);
    for (const sql of [
      'UPDATE whaleu_safety.account_appeals SET text=text WHERE false',
      'DELETE FROM whaleu_safety.account_appeals WHERE false',
      'UPDATE whaleu_safety.account_appeal_commands SET receipt=receipt WHERE false',
      'TRUNCATE whaleu_safety.account_appeal_open_cases',
      'UPDATE whaleu_safety.account_appeal_decisions SET reason=reason WHERE false',
    ])
      await assert.rejects(f.pool.query(sql));
    const command = await f.decision(
      admin,
      submitted.receipt.appealId,
      'released',
    );
    await f.pool
      .query(`CREATE FUNCTION whaleu_safety.test_reject_appeal_result() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic result failure';END$$;
    CREATE TRIGGER a_test_reject_appeal_result BEFORE INSERT ON whaleu_notifications.account_appeal_notices FOR EACH ROW EXECUTE FUNCTION whaleu_safety.test_reject_appeal_result()`);
    try {
      const result = await f.send(admin, command);
      assert.equal(result.status, 503);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_safety.account_punishment_terminals WHERE punishment_id=$1',
            [punishment.punishmentId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_safety.account_appeal_decisions WHERE appeal_id=$1',
            [submitted.receipt.appealId],
          )
        ).rowCount,
        0,
      );
      assert.deepEqual(
        (
          await f.get(
            admin,
            `${adminAppealPath}/requests/${command.clientRequestId}`,
          )
        ).body,
        { state: 'not_recorded' },
      );
    } finally {
      await f.pool.query(
        'DROP TRIGGER a_test_reject_appeal_result ON whaleu_notifications.account_appeal_notices;DROP FUNCTION whaleu_safety.test_reject_appeal_result()',
      );
    }
    const retry = await f.send(admin, command);
    profileOk(retry);
    assert.equal(retry.body.outcome, 'applied');
  },
);

test(
  'reviewer revocation denies new private reads and decisions but retains own original-key decision recovery',
  { timeout: 240000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor();
    const grant = await f.grant(admin, 'super_admin', null);
    const punishment = await f.issue(
      admin,
      owner,
      await f.publish(owner),
      'interaction_mute',
    );
    const submitted = await f.submit(owner, punishment);
    const command = await f.decision(
        admin,
        submitted.receipt.appealId,
        'upheld',
      ),
      result = await f.send(admin, command);
    profileOk(result);
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
        [grant],
      );
    });
    assert.equal(
      (await f.get(admin, `${adminAppealPath}/appeals`)).status,
      403,
    );
    assert.deepEqual(
      (
        await f.get(
          admin,
          `${adminAppealPath}/requests/${command.clientRequestId}`,
        )
      ).body,
      { state: 'recorded', receipt: result.body },
    );
    assert.deepEqual((await f.send(admin, command)).body, result.body);
    assert.equal(
      (await f.send(admin, { ...command, clientRequestId: randomUUID() }))
        .status,
      403,
    );
  },
);
