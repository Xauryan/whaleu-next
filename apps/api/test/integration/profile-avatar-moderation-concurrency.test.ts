/** Actual concurrent writers share the original Profile CAS and avatar actor fence.
 * Synthetic upload/Review fixtures only; no budgets, deadlines or triggers change. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import type { AvatarCommand } from '../../src/profile/avatar/contracts.js';
import { avatarAppearanceId } from '../../src/profile/avatar/repository.js';
import { profileAvatarModerationFixture } from '../support/profile-avatar-moderation-fixture.js';
import type { AvatarModerationFixture } from '../support/profile-avatar-moderation-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  approveProfileAvatar,
  currentProfileAvatar,
  profileCommandEnvelope,
  profileOk,
  readyProfileAvatar,
  setProfileAvatarReview,
} from '../support/media/profile-runtime-fixture.js';

function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Hold the first writer after it acquires the real subject actor fence.
 * A contender can wait at the earlier policy gate or at that actor fence. Observe
 * an actual advisory wait blocked by the first backend before release; no sleeps
 * simulate ordering and no test hook changes state, authorization or deadlines. */
async function orderedWriters(
  f: AvatarModerationFixture,
  actor: string,
  firstDatabase: DatabaseService,
  secondDatabase: DatabaseService,
  firstWork: () => PromiseLike<Response>,
  secondWork: () => PromiseLike<Response>,
  afterFirst?: (response: Response) => Promise<void>,
): Promise<readonly [Response, Response]> {
  assert.notEqual(firstDatabase, secondDatabase);
  const entered = signal<number>(),
    release = signal<void>(),
    contender = signal<number>();
  const originals = [
    firstDatabase.transaction,
    secondDatabase.transaction,
  ] as const;
  const databases = [firstDatabase, secondDatabase] as const;
  const captured = [false, false];
  let first: Promise<Response> | undefined,
    second: Promise<Response> | undefined;
  let checkpointError: unknown;
  for (const [index, database] of databases.entries()) {
    const run = originals[index]!.bind(database);
    database.transaction = (work, options) =>
      run(async (tx) => {
        const raw = tx.query;
        const query = raw.bind(tx) as (
          sql: string,
          values?: unknown[],
        ) => Promise<QueryResult>;
        const pid = (await query('SELECT pg_backend_pid() pid')).rows[0]!
          .pid as number;
        tx.query = (async (sql: string, values?: unknown[]) => {
          const result = query(sql, values);
          const actorFence =
            sql.startsWith('SELECT pg_advisory_xact_lock(') &&
            sql.includes('whaleu:profile-avatar:actor:v1:') &&
            values?.[0] === actor;
          const policyFence =
            sql.startsWith('SELECT pg_advisory_xact_lock') &&
            sql.includes('whaleu:named-block-policy:v1');
          if (
            !captured[index] &&
            (index === 0 ? actorFence : actorFence || policyFence)
          ) {
            captured[index] = true;
            if (index === 0) {
              const locked = await result;
              entered.resolve(pid);
              await release.promise;
              return locked;
            }
            contender.resolve(pid);
            if (afterFirst) {
              const locked = await result;
              assert.ok(first);
              try {
                await afterFirst(await first);
              } catch (error) {
                checkpointError = error;
                throw error;
              }
              return locked;
            }
          }
          return result;
        }) as PoolClient['query'];
        try {
          return await work(tx);
        } finally {
          tx.query = raw;
        }
      }, options);
  }
  const beforeCompletion = async <T>(
    gate: Promise<T>,
    result: Promise<Response>,
    label: string,
  ) =>
    Promise.race([
      gate,
      result.then((response) => {
        throw Error(
          `${label} completed before fence: ${response.status} ${JSON.stringify(response.body)}`,
        );
      }),
      sleep(2000, undefined, { ref: false }).then(() => {
        throw Error(`${label} did not reach an existing policy or actor fence`);
      }),
    ]);
  try {
    first = Promise.resolve(firstWork());
    const firstPid = await beforeCompletion(
      entered.promise,
      first,
      'First writer',
    );
    second = Promise.resolve(secondWork());
    const pid = await beforeCompletion(
      contender.promise,
      second,
      'Contending writer',
    );
    const deadline = Date.now() + 1000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      waiting =
        (
          await f.pool.query<{ waiting: boolean }>(
            `SELECT wait_event_type='Lock'
              AND (a.query LIKE '%whaleu:named-block-policy:v1%'
                OR a.query LIKE '%whaleu:profile-avatar:actor:v1:%')
              AND $2::integer=ANY(pg_blocking_pids(a.pid))
              AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid
                AND l.locktype='advisory' AND NOT l.granted) waiting
              FROM pg_stat_activity a WHERE pid=$1`,
            [pid, firstPid],
          )
        ).rows[0]?.waiting === true;
      if (!waiting) await sleep(1);
    }
    assert.equal(
      waiting,
      true,
      'The second writer actually waits on the existing policy or subject actor gate held by the first backend',
    );
    release.resolve();
    const outcomes = await Promise.all([first, second] as const);
    if (checkpointError !== undefined) throw checkpointError;
    return outcomes;
  } finally {
    release.resolve();
    await Promise.allSettled(
      [first, second].filter((value) => value !== undefined),
    );
    firstDatabase.transaction = originals[0];
    secondDatabase.transaction = originals[1];
  }
}

async function scenario(f: AvatarModerationFixture) {
  const subject = await f.actor(),
    admin = await f.actor();
  await f.grant(admin);
  const selected = await f.custom(subject),
    target = await f.publish(subject);
  const management = await f.management(target, admin);
  const command = f.command(target, management.revision, selected.appearanceId);
  return { subject, admin, selected, target, command };
}

async function avatarSnapshot(f: AvatarModerationFixture, subject: string) {
  return (
    await f.pool.query<{ value: unknown }>(
      `SELECT jsonb_build_object(
      'current',(SELECT to_jsonb(c) FROM whaleu_profile.avatar_current c WHERE actor_id=$1),
      'definitions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM whaleu_profile.avatar_definitions d WHERE actor_id=$1),
      'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.actor_id=$1),
      'events',(SELECT count(*) FROM whaleu_profile.avatar_moderation_events WHERE subject_id=$1),
      'notices',(SELECT count(*) FROM whaleu_notifications.profile_avatar_moderation_notices WHERE recipient_account_id=$1)
    ) value`,
      [subject],
    )
  ).rows[0]!.value;
}

async function binding(f: AvatarModerationFixture, assetId: string) {
  return (
    await f.pool.query<{ detached_at: Date | null }>(
      'SELECT detached_at FROM whaleu_media.bindings WHERE asset_id=$1',
      [assetId],
    )
  ).rows;
}

/** Exact synthetic Safety event for the NEW, still-unbound self upload. */
async function holdNewAsset(f: AvatarModerationFixture, assetId: string) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const asset = (
      await tx.query<{ manifest_digest: string; policy_revision: string }>(
        'SELECT manifest_digest,policy_revision FROM whaleu_media.assets WHERE id=$1 FOR UPDATE',
        [assetId],
      )
    ).rows[0]!;
    const head = (
      await tx.query<{ revision: string }>(
        'SELECT revision FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
        [assetId],
      )
    ).rows[0]!;
    const revision = Number(head.revision) + 1,
      event = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_media.asset_safety_events
      (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
      VALUES($1,$2,$3,'held',$4,$5,'registered-synthetic-media',$6,'{}',clock_timestamp(),clock_timestamp()+interval '30 minutes')`,
      [
        event,
        assetId,
        revision,
        asset.manifest_digest,
        asset.policy_revision,
        `synthetic-new-avatar-held:${event}`,
      ],
    );
    await tx.query(
      'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
      [assetId, revision, event],
    );
  });
}

async function pendingUploadSnapshot(
  f: AvatarModerationFixture,
  editId: string,
  assetId: string,
  intentId: string,
  decisionId: string,
) {
  return (
    await f.pool.query<{ value: unknown }>(
      `SELECT jsonb_build_object(
    'edit',(SELECT to_jsonb(e) FROM whaleu_profile.avatar_edits e WHERE id=$1),
    'asset',(SELECT to_jsonb(a) FROM whaleu_media.assets a WHERE id=$2),
    'intent',(SELECT to_jsonb(i) FROM whaleu_media.upload_intents i WHERE id=$3),
    'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM whaleu_media.bindings b WHERE asset_id=$2),
    'safetyHead',(SELECT to_jsonb(h) FROM whaleu_media.asset_safety_heads h WHERE asset_id=$2),
    'safetyEvents',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM whaleu_media.asset_safety_events e WHERE asset_id=$2),
    'cleanup',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM whaleu_media.cleanup_obligations c
      LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id
      LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
      LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
      LEFT JOIN whaleu_media.object_attempts wo ON wo.id=w.object_attempt_id
      WHERE c.asset_id=$2 OR o.intent_id=$3 OR d.intent_id=$3 OR wo.intent_id=$3),
    'reviewHead',(SELECT to_jsonb(h) FROM whaleu_community.profile_avatar_approval_heads h WHERE decision_id=$4),
    'reviewEvents',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM whaleu_community.profile_avatar_approval_events e WHERE decision_id=$4),
    'consumption',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.appearance_id) FROM whaleu_community.profile_avatar_approval_bindings b WHERE decision_id=$4)
  ) value`,
      [editId, assetId, intentId, decisionId],
    )
  ).rows[0]!.value;
}

test(
  'scoped custom-avatar clear and independent Profile writers share exact CAS without detaching a winner',
  { timeout: 360000 },
  async (t) => {
    const f = await profileAvatarModerationFixture();
    t.after(() => f.close());
    const selfDatabase = f.app.get(DatabaseService),
      clearDatabase = f.ordinary.get(DatabaseService),
      selfHttp = f.app.getHttpServer();

    for (const clearFirst of [false, true]) {
      await t.test(
        `self custom selection ${clearFirst ? 'queues behind clear' : 'wins before clear'}; original receipts cannot resurrect or detach another appearance`,
        async () => {
          const s = await scenario(f);
          const ready = await readyProfileAvatar(f, s.subject, f.bytes);
          const selfCommand: AvatarCommand = {
            protocol: 'profile-media-v1',
            clientRequestId: randomUUID(),
            expectedRevision: s.command.expectedProfileRevision,
            source: {
              kind: 'custom',
              editId: ready.status.editId,
              assetId: ready.status.assetId,
            },
          };
          await approveProfileAvatar(
            f.pool,
            await profileCommandEnvelope(f, s.subject, selfCommand),
          );
          const select = () =>
            request(selfHttp)
              .post('/v1/me/profile/avatar-commands')
              .set('Authorization', `Bearer ${s.subject.accessToken}`)
              .send(selfCommand);
          const clear = () => f.send(s.admin, s.command);
          const outcomes = clearFirst
            ? await orderedWriters(
                f,
                s.subject.accountId,
                clearDatabase,
                selfDatabase,
                clear,
                select,
              )
            : await orderedWriters(
                f,
                s.subject.accountId,
                selfDatabase,
                clearDatabase,
                select,
                clear,
              );
          const cleared = outcomes[clearFirst ? 0 : 1],
            selected = outcomes[clearFirst ? 1 : 0];
          const current = await currentProfileAvatar(f, s.subject);
          assert.equal(current.revision, s.command.expectedProfileRevision + 1);
          const oldBinding = await binding(f, s.selected.ready.status.assetId);
          assert.equal(oldBinding.length, 1);
          assert.ok(
            oldBinding[0]!.detached_at,
            'Exactly the old current custom binding retired',
          );
          if (clearFirst) {
            profileOk(cleared);
            assert.equal(cleared.body.outcome, 'applied');
            assert.equal(selected.status, 409, JSON.stringify(selected.body));
            assert.equal(selected.body.error.code, 'PROFILE_REVISION_CONFLICT');
            assert.equal(current.avatar.state, 'none');
            assert.equal(
              (await binding(f, ready.status.assetId)).length,
              0,
              'Losing prepared upload remains unbound',
            );
            const readyState = (
              await f.pool.query<{ state: string }>(
                'SELECT state FROM whaleu_media.upload_intents WHERE id=$1',
                [ready.status.intentId],
              )
            ).rows[0]!;
            assert.equal(
              readyState.state,
              'ready',
              'Admin clear does not retire a separate pending owner upload',
            );
          } else {
            profileOk(selected);
            profileOk(cleared);
            assert.equal(cleared.body.code, 'PROFILE_AVATAR_MODERATION_STALE');
            assert.equal(
              current.avatar.appearanceId,
              avatarAppearanceId(
                s.subject.accountId,
                selfCommand.clientRequestId,
              ),
            );
            assert.notEqual(
              current.avatar.appearanceId,
              s.selected.appearanceId,
            );
            assert.deepEqual(await binding(f, ready.status.assetId), [
              { detached_at: null },
            ]);
          }
          const frozen = await avatarSnapshot(f, s.subject.accountId);
          const historical = await request(selfHttp)
            .post('/v1/me/profile/avatar-commands')
            .set('Authorization', `Bearer ${s.subject.accessToken}`)
            .send(s.selected.body);
          profileOk(historical);
          assert.deepEqual(historical.body, s.selected.receipt);
          const replay = await clear();
          profileOk(replay);
          assert.deepEqual(replay.body, cleared.body);
          const conflicting = await f.send(s.admin, {
            ...s.command,
            expectedAppearanceId: randomUUID(),
          });
          assert.equal(conflicting.status, 409);
          const stranger = await f.actor();
          const otherRecovery = await request(f.http)
            .get(
              `/v1/community/profile-avatar-moderation/requests/${s.command.clientRequestId}`,
            )
            .set('Authorization', `Bearer ${stranger.accessToken}`);
          profileOk(otherRecovery);
          assert.deepEqual(otherRecovery.body, { state: 'not_recorded' });
          assert.deepEqual(
            await avatarSnapshot(f, s.subject.accountId),
            frozen,
            'Historical actor/key metadata never reactivates an appearance',
          );
          assert.equal(
            (await currentProfileAvatar(f, s.subject)).revision,
            current.revision,
          );
        },
      );
    }

    for (const held of ['new-self-review', 'new-asset-safety'] as const) {
      await t.test(
        `${held} cannot borrow the queued clear's authority or attach the held new source`,
        async () => {
          const s = await scenario(f);
          const ready = await readyProfileAvatar(f, s.subject, f.bytes);
          const selfCommand: AvatarCommand = {
            protocol: 'profile-media-v1',
            clientRequestId: randomUUID(),
            expectedRevision: s.command.expectedProfileRevision,
            source: {
              kind: 'custom',
              editId: ready.status.editId,
              assetId: ready.status.assetId,
            },
          };
          const approved = await approveProfileAvatar(
            f.pool,
            await profileCommandEnvelope(f, s.subject, selfCommand),
          );
          if (held === 'new-self-review')
            await setProfileAvatarReview(f.pool, approved.decisionId, 'held');
          else await holdNewAsset(f, ready.status.assetId);
          const uploadSnapshot = () =>
            pendingUploadSnapshot(
              f,
              ready.status.editId,
              ready.status.assetId,
              ready.status.intentId,
              approved.decisionId,
            );
          const profileSnapshot = async () =>
            (
              await f.pool.query<{ value: unknown }>(
                'SELECT to_jsonb(p) value FROM whaleu_profile.profiles p WHERE account_id=$1',
                [s.subject.accountId],
              )
            ).rows[0]!.value;
          const receiptSnapshot = async () =>
            (
              await f.pool.query<{ value: unknown }>(
                'SELECT jsonb_agg(to_jsonb(r) ORDER BY client_request_id) value FROM whaleu_profile.avatar_command_receipts r WHERE actor_id=$1',
                [s.subject.accountId],
              )
            ).rows[0]!.value;
          const before = {
            profile: await profileSnapshot(),
            avatar: await avatarSnapshot(f, s.subject.accountId),
            upload: await uploadSnapshot(),
            receipts: await receiptSnapshot(),
          };
          let checkedFailedSelf = false;
          const assertHeldFailure = (response: Response) => {
            // Held Review has an exact existing 503 contract; this is not a
            // generic service-failure allowance. The competing clear must succeed.
            assert.equal(
              response.status,
              held === 'new-self-review' ? 503 : 409,
              JSON.stringify(response.body),
            );
            assert.equal(
              response.body.error.code,
              held === 'new-self-review'
                ? 'CONTENT_REVIEW_UNAVAILABLE'
                : 'MEDIA_NOT_READY',
            );
          };
          const [selected, cleared] = await orderedWriters(
            f,
            s.subject.accountId,
            selfDatabase,
            clearDatabase,
            () =>
              request(selfHttp)
                .post('/v1/me/profile/avatar-commands')
                .set('Authorization', `Bearer ${s.subject.accessToken}`)
                .send(selfCommand),
            () => f.send(s.admin, s.command),
            async (failed) => {
              assertHeldFailure(failed);
              // The first transaction has fully rolled back. The second owns its
              // existing gate but has not yet resolved the target or changed data.
              assert.deepEqual(
                {
                  profile: await profileSnapshot(),
                  avatar: await avatarSnapshot(f, s.subject.accountId),
                  upload: await uploadSnapshot(),
                  receipts: await receiptSnapshot(),
                },
                before,
                'Held self selection changes neither Profile nor either avatar/upload',
              );
              checkedFailedSelf = true;
            },
          );
          assert.equal(checkedFailedSelf, true);
          assertHeldFailure(selected);
          profileOk(cleared);
          assert.equal(cleared.body.outcome, 'applied');
          assert.equal(
            cleared.body.revision,
            s.command.expectedProfileRevision + 1,
          );
          const current = await currentProfileAvatar(f, s.subject);
          assert.equal(current.revision, cleared.body.revision);
          assert.equal(current.avatar.state, 'none');
          assert.ok(
            (await binding(f, s.selected.ready.status.assetId))[0]!.detached_at,
          );
          assert.equal((await binding(f, ready.status.assetId)).length, 0);
          assert.deepEqual(
            await uploadSnapshot(),
            before.upload,
            'Clear does not change or retire the independently held pending new upload',
          );
          assert.deepEqual(
            await receiptSnapshot(),
            before.receipts,
            'No self receipt is created for the held selection',
          );
          const totals = (
            await f.pool.query(
              `SELECT
          (SELECT count(*)::int FROM whaleu_profile.avatar_moderation_events WHERE subject_id=$1) events,
          (SELECT count(*)::int FROM whaleu_notifications.profile_avatar_moderation_notices WHERE recipient_account_id=$1) notices,
          (SELECT count(*)::int FROM whaleu_community.profile_avatar_approval_bindings WHERE decision_id=$2) consumed,
          (SELECT count(*)::int FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.actor_id=$1 AND b.detached_at IS NOT NULL) detached`,
              [s.subject.accountId, approved.decisionId],
            )
          ).rows[0]!;
          assert.deepEqual(totals, {
            events: 1,
            notices: 1,
            consumed: 0,
            detached: 1,
          });
          const stable = await avatarSnapshot(f, s.subject.accountId);
          const replay = await f.send(s.admin, s.command);
          profileOk(replay);
          assert.deepEqual(replay.body, cleared.body);
          assert.deepEqual(
            await avatarSnapshot(f, s.subject.accountId),
            stable,
          );
        },
      );
    }

    for (const field of [
      'nickname-moderation',
      'bio',
      'preferences',
      'campus',
    ] as const) {
      for (const clearFirst of [false, true]) {
        await t.test(
          `${field} ${clearFirst ? 'queues behind clear' : 'wins before clear'} on the same revision`,
          async () => {
            const s = await scenario(f);
            // A separate named post avoids conflating target-row serialization with
            // the shared subject Profile fence under test.
            const nicknameTarget =
              field === 'nickname-moderation'
                ? await f.publish(s.subject)
                : null;
            const before = await request(selfHttp)
              .get('/v1/me/profile')
              .set('Authorization', `Bearer ${s.subject.accessToken}`);
            profileOk(before);
            const revision = before.body.revision as number;
            const nicknameCommand = {
              clientRequestId: randomUUID(),
              target: { kind: 'post', id: nicknameTarget?.id },
              expectedProfileRevision: revision,
              action: 'reset_nickname',
            };
            const edit = () => {
              if (field === 'nickname-moderation')
                return request(selfHttp)
                  .post('/v1/community/profile-moderation/commands')
                  .set('Authorization', `Bearer ${s.admin.accessToken}`)
                  .send(nicknameCommand);
              if (field === 'preferences')
                return request(selfHttp)
                  .patch('/v1/me/preferences')
                  .set('Authorization', `Bearer ${s.subject.accessToken}`)
                  .send({
                    expectedRevision: revision,
                    preferences: { showOfficialAccountTip: false },
                  });
              if (field === 'campus')
                return request(selfHttp)
                  .put('/v1/me/campus')
                  .set('Authorization', `Bearer ${s.subject.accessToken}`)
                  .send({
                    expectedRevision: revision,
                    campusId: f.scope.foreign.campusId,
                  });
              return request(selfHttp)
                .patch('/v1/me/profile')
                .set('Authorization', `Bearer ${s.subject.accessToken}`)
                .send({
                  expectedRevision: revision,
                  bio: 'Concurrent owner bio wins',
                });
            };
            const clear = () => f.send(s.admin, s.command);
            const outcomes = clearFirst
              ? await orderedWriters(
                  f,
                  s.subject.accountId,
                  clearDatabase,
                  selfDatabase,
                  clear,
                  edit,
                )
              : await orderedWriters(
                  f,
                  s.subject.accountId,
                  selfDatabase,
                  clearDatabase,
                  edit,
                  clear,
                );
            const cleared = outcomes[clearFirst ? 0 : 1],
              edited = outcomes[clearFirst ? 1 : 0];
            profileOk(cleared);
            const after = await request(selfHttp)
              .get('/v1/me/profile')
              .set('Authorization', `Bearer ${s.subject.accessToken}`);
            profileOk(after);
            assert.equal(after.body.revision, revision + 1);
            const current = await currentProfileAvatar(f, s.subject);
            if (clearFirst) {
              assert.equal(cleared.body.outcome, 'applied');
              if (field === 'nickname-moderation') {
                profileOk(edited);
                assert.equal(edited.body.code, 'PROFILE_MODERATION_STALE');
              } else {
                assert.equal(edited.status, 409, JSON.stringify(edited.body));
                assert.equal(
                  edited.body.error.code,
                  'PROFILE_REVISION_CONFLICT',
                );
              }
              assert.equal(current.avatar.state, 'none');
              assert.ok(
                (await binding(f, s.selected.ready.status.assetId))[0]!
                  .detached_at,
              );
              assert.deepEqual(
                { ...after.body, revision },
                before.body,
                'Clear changes no other Profile fields',
              );
            } else {
              profileOk(edited);
              assert.equal(
                cleared.body.code,
                'PROFILE_AVATAR_MODERATION_STALE',
              );
              assert.equal(
                current.avatar.appearanceId,
                s.selected.appearanceId,
              );
              assert.deepEqual(
                await binding(f, s.selected.ready.status.assetId),
                [{ detached_at: null }],
              );
              if (field === 'nickname-moderation') {
                assert.equal(edited.body.outcome, 'applied');
                assert.match(after.body.nickname, /^违规昵称[A-Za-z0-9]{6}$/);
              } else if (field === 'bio')
                assert.equal(after.body.bio, 'Concurrent owner bio wins');
              else if (field === 'preferences')
                assert.equal(
                  after.body.preferences.showOfficialAccountTip,
                  false,
                );
              else
                assert.equal(
                  after.body.selectedCampus.id,
                  f.scope.foreign.campusId,
                );
            }
            const notices = await request(f.http)
              .get('/v1/me/system-notices')
              .set('Authorization', `Bearer ${s.subject.accessToken}`);
            profileOk(notices);
            const expectedKind = clearFirst
              ? 'profile_custom_avatar_cleared'
              : field === 'nickname-moderation'
                ? 'profile_nickname_reset'
                : null;
            assert.equal(
              notices.body.items.length,
              expectedKind === null ? 0 : 1,
            );
            if (expectedKind !== null)
              assert.equal(notices.body.items[0].kind, expectedKind);
            const frozen = await avatarSnapshot(f, s.subject.accountId);
            const replay = await clear();
            profileOk(replay);
            assert.deepEqual(replay.body, cleared.body);
            assert.deepEqual(
              await avatarSnapshot(f, s.subject.accountId),
              frozen,
            );
          },
        );
      }
    }
  },
);
