import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { accountDeletionFixture } from '../support/account-deletion-fixture.js';
import {
  COOLING_MS,
  REREGISTRATION_MS,
} from '../../src/account-deletion/contracts.js';
import { hashToken } from '../../src/identity/tokens.js';
import { accountDeletionCapability } from '../../src/account-deletion/contracts.js';
import { AccountDeletionWorker } from '../../src/account-deletion/worker.js';
import { SyntheticDeletionMedia } from '../../src/account-deletion/synthetic-media.js';
import { eraseIdentity } from '../../src/account-deletion/owners/identity.js';
const request = () => ({
  version: 1,
  requestId: randomUUID(),
  expectedGeneration: '0',
  consent: 'account-deletion-explicit-v1',
});

test(
  'real PG local synthetic deletion: true payload erasure, causal history, cooling/cancel, exact media, receipt and completion-based registration guard',
  { timeout: 300000 },
  async (t) => {
    const f = await accountDeletionFixture();
    t.after(() => f.close());
    const owner = await f.create(),
      other = await f.create(),
      privateData = await f.populate(owner),
      sharedData = await f.populate(other);
    assert.equal(accountDeletionCapability().status, 'unavailable');
    await assert.rejects(
      f.pool.query(
        "UPDATE whaleu_profile.self_edit_causes SET patch='{}' WHERE actor_id=$1",
        [owner.accountId],
      ),
      /immutable|causal|erasure/i,
    );
    assert.ok(
      (await f.residue(privateData.sentinels)).includes(
        'whaleu_profile.self_edit_causes',
      ),
    );
    assert.equal(
      (await f.service.eligibility(f.assertion(owner))).status,
      'eligible',
    );
    const ownObject = f.media.create(
        [owner.accountId],
        Buffer.from('generated private binary'),
      ),
      sharedObject = f.media.create(
        [owner.accountId, other.accountId],
        Buffer.from('generated shared binary'),
      ),
      writer = f.media.writer(ownObject);
    const cmd = request(),
      accepted = await f.service.request(f.assertion(owner), cmd);
    assert.ok(accepted.receiptRecoveryKey);
    const recovery = accepted.receiptRecoveryKey!;
    assert.equal(accepted.status.phase, 'cooling');
    assert.equal(
      accepted.status.eligibleAt - accepted.status.requestedAt,
      COOLING_MS,
    );
    await assert.rejects(
      f.pool.query(
        "INSERT INTO whaleu_account_deletion.owner_receipts(request_id,owner,generation,inventory,proof) SELECT id,'profile',generation,inventory,repeat('a',64) FROM whaleu_account_deletion.requests WHERE id=$1",
        [cmd.requestId],
      ),
      /cause|receipt|erasing/i,
      'A shaped hash without a current owner cause is not completion evidence',
    );
    assert.deepEqual(
      (await f.service.request(f.assertion(owner), cmd)).status,
      accepted.status,
    );
    await assert.rejects(
      f.service.request(f.assertion(owner), {
        ...cmd,
        expectedGeneration: '1',
      }),
      /IDEMPOTENCY_CONFLICT/,
    );
    await assert.rejects(f.identity.authenticate(hashToken(owner.accessToken)));
    await assert.rejects(
      f.identity.rotate(hashToken(owner.refreshToken), {
        access: '1'.repeat(64),
        refresh: '2'.repeat(64),
      }),
    );
    await assert.rejects(
      f.identity.createSession(
        {
          provider: 'wechat',
          appId: 'synthetic-account-deletion-rehearsal',
          subject: owner.subject,
        },
        { access: '3'.repeat(64), refresh: '4'.repeat(64) },
      ),
    );
    for (let i = 0; i < 3; i++)
      assert.deepEqual(
        await f.service.status(recovery),
        accepted.status,
        'polling must not cancel or move the clock',
      );
    // Real SQL writes, not a stopped fixture worker, see the lifecycle guard.
    await assert.rejects(
      f.pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id) VALUES($1) ON CONFLICT(account_id) DO UPDATE SET bio='resurrect'",
        [owner.accountId],
      ),
      /lifecycle/i,
    );
    await assert.rejects(
      f.pool.query(
        'INSERT INTO whaleu_community.user_follows(follower_id,followed_id,followed_profile_id) VALUES($1,$2,$3)',
        [other.accountId, owner.accountId, privateData.profileId],
      ),
      /lifecycle/i,
    );
    await assert.rejects(
      f.pool.query(
        "UPDATE whaleu_verification.assertions SET student_number='injected' WHERE account_id=$1",
        [owner.accountId],
      ),
    );
    await f.advance(COOLING_MS - 1);
    assert.equal((await f.worker.tick(cmd.requestId)).phase, 'cooling');
    await f.advance(1);
    const limited = await f.service.reauthenticate(
      f.assertion(owner),
      cmd.requestId,
    );
    assert.equal(limited.purpose, 'account-deletion-status-cancel');
    await assert.rejects(f.identity.authenticate(hashToken(limited.token)));
    await assert.rejects(
      f.service.cancel(limited.token, {
        version: 1,
        commandId: randomUUID(),
        requestId: cmd.requestId,
        expectedRevision: '1',
        action: 'explicitly_cancel_account_deletion',
      }),
      /TOO_LATE/,
    );
    let waiting = await f.worker.tick(cmd.requestId);
    for (
      let i = 0;
      i < 10 && !waiting.pending.includes('MEDIA_WRITER_NOT_QUIESCENT');
      i++
    )
      waiting = await f.worker.tick(cmd.requestId);
    assert.equal(waiting.phase, 'waiting');
    assert.ok(waiting.pending.includes('MEDIA_WRITER_NOT_QUIESCENT'));
    assert.equal(waiting.completedAt, null);
    assert.equal(waiting.reregisterAfter, null);
    assert.equal(f.media.exists(ownObject), true);
    const restarted = new AccountDeletionWorker(
        f.repository,
        new SyntheticDeletionMedia(),
      ),
      unknownCohort = await restarted.tick(cmd.requestId);
    assert.deepEqual(unknownCohort.pending, ['MEDIA_COHORT_UNAVAILABLE']);
    assert.equal(unknownCohort.completedAt, null);
    assert.equal(
      f.media.exists(ownObject),
      true,
      'Replacing the adapter cannot erase or certify the original private object',
    );
    const erased = (
      await f.pool.query<{
        patch: unknown;
        before_row: unknown;
        token_hash: string;
        erased_by_request_id: string;
      }>(
        'SELECT patch,before_row,token_hash,erased_by_request_id FROM whaleu_profile.self_edit_causes WHERE actor_id=$1',
        [owner.accountId],
      )
    ).rows[0]!;
    assert.deepEqual(erased.patch, {});
    assert.deepEqual(erased.before_row, {});
    assert.equal(erased.token_hash, '0'.repeat(64));
    assert.equal(erased.erased_by_request_id, cmd.requestId);
    await assert.rejects(
      f.pool.query(
        'UPDATE whaleu_profile.self_edit_causes SET patch=\'{"bio":"restore"}\' WHERE actor_id=$1',
        [owner.accountId],
      ),
      /causal|lifecycle|erasure/i,
    );
    await f.advance(10 * 86400000);
    writer.stop();
    f.media.setUnknown(ownObject, true);
    assert.deepEqual((await f.worker.tick(cmd.requestId)).pending, [
      'MEDIA_EFFECT_UNKNOWN',
    ]);
    f.media.setUnknown(ownObject, false);
    let done = await f.worker.tick(cmd.requestId);
    assert.equal(done.phase, 'waiting');
    // Every other final condition is genuine, but omitting the registration guard
    // must roll the final Identity erasure back, not emit a completion receipt.
    await assert.rejects(
      f.repository.transaction(async (tx) => {
        await f.repository.lockAccount(tx, owner.accountId);
        const row = await f.repository.request(tx, cmd.requestId);
        await f.repository.cause(tx, row, 'identity');
        const media = f.media.settle(owner.accountId, row.id, f.media.cohortId);
        assert.equal(media.kind, 'complete');
        await tx.query(
          'INSERT INTO whaleu_account_deletion.media_observations(request_id,cohort_id,generation,proof) VALUES($1,$2,$3,$4)',
          [row.id, f.media.cohortId, row.generation, media.proof],
        );
        const proof = await eraseIdentity(tx, owner.accountId, row.id);
        assert.ok(proof);
        await f.repository.proof(tx, row, 'identity', proof);
        await tx.query(
          "UPDATE whaleu_account_deletion.requests SET phase='completed',revision=revision+1,completed_at=$2,reregister_after=$3,pending='{}' WHERE id=$1",
          [row.id, new Date(f.now()), new Date(f.now() + REREGISTRATION_MS)],
        );
      }),
      /completion|guard|predicate|final deletion evidence/i,
    );
    // A real concurrent registrar has checked the guard under the provider key.
    // Finalization must yield without dropping that key's still-existing mapping.
    let observed!: () => void, release!: () => void;
    const checked = new Promise<void>((resolve) => {
        observed = resolve;
      }),
      resume = new Promise<void>((resolve) => {
        release = resolve;
      });
    const racingRegistration = f.create(owner.subject, true, async () => {
        observed();
        await resume;
      }),
      registrationRejected = assert.rejects(
        racingRegistration,
        /duplicate key|unique constraint/i,
      );
    await checked;
    try {
      const raced = await f.worker.tick(cmd.requestId);
      assert.deepEqual(raced.pending, ['IDENTITY_REGISTRATION_LOCK_BUSY']);
      assert.equal(raced.completedAt, null);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=$1',
            [owner.accountId],
          )
        ).rowCount,
        1,
      );
    } finally {
      release();
    }
    await registrationRejected;
    for (let i = 0; i < 10 && done.phase !== 'completed'; i++)
      done = await f.worker.tick(cmd.requestId);
    assert.equal(done.phase, 'completed', JSON.stringify(done));
    assert.equal(done.reregisterAfter, done.completedAt! + REREGISTRATION_MS);
    assert.equal(done.completedAt, f.now());
    assert.equal(f.media.exists(ownObject), false);
    assert.equal(f.media.exists(sharedObject), true);
    assert.deepEqual(
      await f.residue(privateData.sentinels),
      [],
      'Private values and ordinary credential hashes must physically disappear from every actual relation',
    );
    assert.ok(
      (await f.residue(sharedData.sentinels)).includes(
        'whaleu_profile.profiles',
      ),
      'Other account payload survives',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_account_deletion.reserved_profile_ids WHERE public_id=$1',
          [privateData.profileId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_timetable.terms WHERE account_id=$1 AND term_id=$2 AND deleted_at IS NOT NULL AND name IS NULL',
          [owner.accountId, privateData.termId],
        )
      ).rowCount,
      1,
    );
    assert.deepEqual(await f.worker.tick(cmd.requestId), done);
    assert.deepEqual(await f.service.status(recovery), done);
    await assert.rejects(f.create(owner.subject), /REREGISTRATION_RESTRICTED/);
    await f.advance(REREGISTRATION_MS - 1);
    await assert.rejects(f.create(owner.subject), /REREGISTRATION_RESTRICTED/);
    await f.advance(1);
    const replacement = await f.create(owner.subject);
    assert.notEqual(replacement.accountId, owner.accountId);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_profile.profiles WHERE account_id=$1',
          [replacement.accountId],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      f.pool.query(
        'INSERT INTO whaleu_profile.profiles(account_id,public_id) VALUES($1,$2)',
        [replacement.accountId, privateData.profileId],
      ),
      /reserved/i,
    );

    await t.test(
      'explicit cancellation preserves moderation and never revives a revoked session',
      async () => {
        const actor = await f.create(),
          c = request();
        const result = await f.service.request(f.assertion(actor), c);
        const access = await f.service.reauthenticate(
          f.assertion(actor),
          c.requestId,
        );
        const cancellation = {
          version: 1,
          commandId: randomUUID(),
          requestId: c.requestId,
          expectedRevision: '1',
          action: 'explicitly_cancel_account_deletion',
        };
        assert.equal(
          (await f.service.cancel(access.token, cancellation)).phase,
          'cancelled',
        );
        assert.equal(
          (await f.service.cancel(access.token, cancellation)).phase,
          'cancelled',
        );
        await assert.rejects(
          f.identity.authenticate(hashToken(actor.accessToken)),
        );
        await assert.rejects(
          f.identity.rotate(hashToken(actor.refreshToken), {
            access: '5'.repeat(64),
            refresh: '6'.repeat(64),
          }),
        );
        const next = { ...request(), expectedGeneration: '1' };
        await f.service.request(f.assertion(actor), next);
        await assert.rejects(
          f.service.cancel(access.token, cancellation),
          /IDENTITY_UNAVAILABLE/,
        );
        const fresh = await f.service.reauthenticate(
          f.assertion(actor),
          next.requestId,
        );
        await f.pool.query(
          "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
          [actor.accountId],
        );
        await assert.rejects(
          f.service.cancel(fresh.token, {
            ...cancellation,
            commandId: randomUUID(),
            requestId: next.requestId,
          }),
          /IDENTITY_UNAVAILABLE/,
        );
        assert.equal(
          (
            await f.pool.query<{ status: string }>(
              'SELECT status FROM whaleu_identity.accounts WHERE id=$1',
              [actor.accountId],
            )
          ).rows[0]!.status,
          'blocked',
        );
        assert.equal(
          (await f.service.status(result.receiptRecoveryKey!)).phase,
          'cancelled',
        );
      },
    );

    await t.test(
      'a prior logout does not block deletion or get relabelled',
      async () => {
        const actor = await f.create();
        await f.identity.revoke(hashToken(actor.accessToken));
        const fresh = await f.identity.createSession(
          {
            provider: 'wechat',
            appId: 'synthetic-account-deletion-rehearsal',
            subject: actor.subject,
          },
          { access: hashToken(randomUUID()), refresh: hashToken(randomUUID()) },
        );
        const c = request();
        assert.equal(
          (await f.service.request(f.assertion(actor), c)).status.phase,
          'cooling',
        );
        const sessions = (
          await f.pool.query<{ id: string; revoke_reason: string }>(
            'SELECT id,revoke_reason FROM whaleu_identity.sessions WHERE account_id=$1',
            [actor.accountId],
          )
        ).rows;
        assert.equal(
          sessions.find((s) => s.id === actor.sessionId)?.revoke_reason,
          'logout',
        );
        assert.equal(
          sessions.find((s) => s.id === fresh.sessionId)?.revoke_reason,
          'account_deletion',
        );
      },
    );

    await t.test(
      'Profile erasure cannot be attributed to an older cancelled request',
      async () => {
        const actor = await f.create();
        await f.populate(actor);
        const previous = request();
        await f.service.request(f.assertion(actor), previous);
        const grant = await f.service.reauthenticate(
          f.assertion(actor),
          previous.requestId,
        );
        await f.service.cancel(grant.token, {
          version: 1,
          commandId: randomUUID(),
          requestId: previous.requestId,
          expectedRevision: '1',
          action: 'explicitly_cancel_account_deletion',
        });
        const current = { ...request(), expectedGeneration: '1' };
        await f.service.request(f.assertion(actor), current);
        await f.advance(COOLING_MS);
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            await f.repository.lockAccount(tx, actor.accountId);
            await tx.query(
              "UPDATE whaleu_account_deletion.requests SET phase='erasing',revision=revision+1,irreversible_at=$2 WHERE id=$1",
              [current.requestId, new Date(f.now())],
            );
            const row = await f.repository.request(tx, current.requestId);
            await f.repository.cause(tx, row, 'profile');
            await tx.query(
              "UPDATE whaleu_profile.self_edit_causes SET patch='{}',before_row='{}',token_hash=repeat('0',64),erased_by_request_id=$2 WHERE actor_id=$1",
              [actor.accountId, previous.requestId],
            );
          }),
          /causal|erasure|request/i,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_profile.self_edit_causes WHERE actor_id=$1 AND erased_by_request_id IS NULL',
              [actor.accountId],
            )
          ).rowCount,
          1,
        );
      },
    );

    await t.test(
      'actual FollowingService history with a non-admitted peer remains unsupported, not fake completion',
      async () => {
        // Successor mapping: admitted follow-only coverage is positively tested in
        // account-deletion-follow-social.test.ts. This negative still uses the real
        // service and exact native source provenance, but the peer is NOT admitted.
        const follower = await f.create(),
          target = await f.identity.createSession(
            {
              provider: 'wechat',
              appId: 'synthetic-nonfixture-follow-peer',
              subject: 'generated-' + randomUUID(),
            },
            {
              access: hashToken(randomUUID()),
              refresh: hashToken(randomUUID()),
            },
          );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_account_deletion.fixture_accounts WHERE account_id=$1',
              [target.accountId],
            )
          ).rowCount,
          0,
        );
        await f.repository.transaction((tx) =>
          f.profiles.authorDisplay(target.accountId, tx),
        );
        const targetProfile = await f.repository.transaction((tx) =>
          f.profiles.publicReference(target.accountId, tx),
        );
        assert.ok(targetProfile);
        const applied = await f.following.set(
          follower.accessToken,
          targetProfile,
          true,
          randomUUID(),
        );
        assert.equal(applied.outcome, 'applied');
        const eligibility = await f.service.eligibility(f.assertion(follower));
        assert.equal(eligibility.status, 'blocked');
        assert.ok(
          eligibility.blockers.includes('UNSUPPORTED_FOLLOW_SOCIAL_PARTITION'),
        );
        await assert.rejects(
          f.service.request(f.assertion(follower), request()),
          /OWNER_COVERAGE_UNAVAILABLE/,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_account_deletion.requests WHERE account_id=$1',
              [follower.accountId],
            )
          ).rowCount,
          0,
        );
      },
    );
  },
);
