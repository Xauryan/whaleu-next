import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { test } from 'node:test';
import request from 'supertest';
import { MediaLifecycleRepository } from '../../src/media/lifecycle-repository.js';
import type { MediaManifest } from '../../src/media/contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { PROFILE_AVATAR_RUNTIME } from '../../src/profile/avatar/service.js';
import { ProfileAvatarDelivery } from '../../src/profile/avatar/delivery.js';
import type { AvatarCommand } from '../../src/profile/avatar/contracts.js';
import { profileAvatarModerationFixture } from '../support/profile-avatar-moderation-fixture.js';
import type { AvatarModerationFixture } from '../support/profile-avatar-moderation-fixture.js';
import {
  approveProfileAvatar,
  currentProfileAvatar,
  profileCommandEnvelope,
  profileOk,
  setProfileAvatarReview,
  waitForProfileDeadline,
} from '../support/media/profile-runtime-fixture.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

async function scenario(f: AvatarModerationFixture) {
  const subject = await f.actor(),
    admin = await f.actor(),
    viewer = await f.actor();
  await f.grant(admin);
  const selected = await f.custom(subject),
    target = await f.publish(subject);
  assert.ok(selected.current.profileId);
  const view = await f.management(target, admin);
  assert.equal(view.canClearCustomAvatar, true);
  assert.equal(view.expectedAppearanceId, selected.appearanceId);
  const body = f.command(target, view.revision, selected.appearanceId);
  const path = (variant: string) =>
    `/v1/profiles/${selected.current.profileId}/avatar/${selected.appearanceId}/${variant}`;
  return { subject, admin, viewer, selected, target, view, body, path };
}

async function safety(
  f: AvatarModerationFixture,
  assetId: string,
  state: 'held' | 'revoked',
) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const asset = (
      await tx.query<{ manifest_digest: string; policy_revision: string }>(
        'SELECT manifest_digest,policy_revision FROM whaleu_media.assets WHERE id=$1 FOR UPDATE',
        [assetId],
      )
    ).rows[0]!;
    const revision =
      Number(
        (
          await tx.query<{ revision: string }>(
            'SELECT revision FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
            [assetId],
          )
        ).rows[0]!.revision,
      ) + 1;
    const event = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_media.asset_safety_events
      (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
      VALUES($1,$2,$3,$4,$5,$6,'registered-synthetic-media',$7,'{}',clock_timestamp(),clock_timestamp()+interval '30 minutes')`,
      [
        event,
        assetId,
        revision,
        state,
        asset.manifest_digest,
        asset.policy_revision,
        `synthetic-clear:${event}`,
      ],
    );
    await tx.query(
      'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
      [assetId, revision, event],
    );
  });
}

const cleanupJoin = `FROM whaleu_media.cleanup_obligations c
  LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id
  LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id
  LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
  LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
  LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id`;

test(
  'scoped avatar clear denies current bytes and retains exact owner retirement and future self-selection',
  { timeout: 360000 },
  async (t) => {
    const f = await profileAvatarModerationFixture();
    const http = f.app.getHttpServer();
    try {
      assert.equal(f.ordinary.get(PROFILE_AVATAR_RUNTIME), null);
      const unaffected = await f.actor(),
        unaffectedSelection = await f.custom(unaffected);
      const unaffectedPath = `/v1/profiles/${unaffectedSelection.current.profileId}/avatar/${unaffectedSelection.appearanceId}/display-v1`;
      const unaffectedBefore = await request(http).get(unaffectedPath);
      profileOk(unaffectedBefore);

      await t.test(
        'ordinary null-runtime clear removes only the exact binding; new guest/session requests and both variants deny old bytes',
        async () => {
          const s = await scenario(f);
          const before = (
            await f.pool.query<{
              intent_id: string;
              generation: number;
              manifest: MediaManifest;
              binding_id: string;
            }>(
              `SELECT a.intent_id,i.generation,a.manifest,b.id binding_id FROM whaleu_media.assets a
         JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.bindings b ON b.asset_id=a.id WHERE a.id=$1`,
              [s.selected.ready.status.assetId],
            )
          ).rows[0]!;
          const oldDefinitions = (
            await f.pool.query(
              'SELECT to_jsonb(d) row FROM whaleu_profile.avatar_definitions d WHERE id=$1',
              [s.selected.appearanceId],
            )
          ).rows;
          const oldCleanup = new Set(
            (
              await f.pool.query<{ id: string }>(
                `SELECT c.id ${cleanupJoin} WHERE coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id)=$1`,
                [before.intent_id],
              )
            ).rows.map((r) => r.id),
          );
          for (const variant of ['thumb-v1', 'display-v1']) {
            const response = await request(http).get(s.path(variant));
            profileOk(response);
            assert.equal(
              sha256(response.body as Buffer),
              before.manifest.variants.find((v) => v.name === variant)!.sha256,
            );
          }
          const applied = await f.send(s.admin, s.body);
          profileOk(applied);
          assert.equal(applied.body.outcome, 'applied');
          assert.equal(applied.body.revision, s.view.revision + 1);
          for (const variant of ['thumb-v1', 'display-v1'])
            for (const viewer of [null, s.viewer]) {
              const call = request(http).get(s.path(variant));
              if (viewer)
                call.set('Authorization', `Bearer ${viewer.accessToken}`);
              const response = await call;
              assert.notEqual(response.status, 200);
              assert.equal(Buffer.isBuffer(response.body), false);
            }
          for (const app of [f.app, f.ordinary]) {
            const current = await request(app.getHttpServer())
              .get('/v1/me/profile/avatar')
              .set('Authorization', `Bearer ${s.subject.accessToken}`);
            profileOk(current);
            assert.equal(current.body.avatar.state, 'none');
            assert.equal(current.body.revision, applied.body.revision);
            const publicCurrent = await request(app.getHttpServer()).get(
              `/v1/profiles/${s.selected.current.profileId}/avatar`,
            );
            profileOk(publicCurrent);
            assert.equal(publicCurrent.body.avatar.state, 'none');
          }
          const binding = (
            await f.pool.query<{
              id: string;
              detached_at: Date;
              detach_reason: string;
            }>(
              'SELECT id,detached_at,detach_reason FROM whaleu_media.bindings WHERE asset_id=$1',
              [s.selected.ready.status.assetId],
            )
          ).rows;
          assert.equal(binding.length, 1);
          assert.equal(binding[0]!.id, before.binding_id);
          assert.ok(binding[0]!.detached_at instanceof Date);
          assert.equal(binding[0]!.detach_reason, 'profile-avatar-replaced');
          const intent = (
            await f.pool.query<{ state: string; generation: number }>(
              'SELECT state,generation FROM whaleu_media.upload_intents WHERE id=$1',
              [before.intent_id],
            )
          ).rows[0]!;
          assert.equal(intent.state, 'cleanup_pending');
          assert.equal(
            Number(intent.generation),
            Number(before.generation) + 1,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.quota_reservations WHERE intent_id=$1 AND released_at IS NULL',
                [before.intent_id],
              )
            ).rowCount,
            0,
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT to_jsonb(d) row FROM whaleu_profile.avatar_definitions d WHERE id=$1',
                [s.selected.appearanceId],
              )
            ).rows,
            oldDefinitions,
          );
          const clear = (
            await f.pool.query<{
              id: string;
              authority: string;
              binding_id: string | null;
              digest: string;
            }>(
              `SELECT d.* FROM whaleu_profile.avatar_current c JOIN whaleu_profile.avatar_definitions d ON d.id=c.appearance_id WHERE c.actor_id=$1`,
              [s.subject.accountId],
            )
          ).rows[0]!;
          assert.equal(clear.authority, 'scoped_moderation_clear');
          assert.equal(clear.binding_id, null);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.avatar_command_receipts WHERE appearance_id=$1',
                [clear.id],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.profile_avatar_approval_bindings WHERE appearance_id=$1',
                [clear.id],
              )
            ).rowCount,
            0,
          );
          const obligations = (
            await f.pool.query<{
              id: string;
              not_before: Date;
              confirmed_deleted_at: Date | null;
              retention: number;
            }>(
              `SELECT c.id,c.not_before,c.confirmed_deleted_at,extract(epoch FROM(c.not_before-c.created_at))::double precision retention ${cleanupJoin} WHERE coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id)=$1 ORDER BY c.id`,
              [before.intent_id],
            )
          ).rows;
          const newObligations = obligations.filter(
            (row) => !oldCleanup.has(row.id),
          );
          assert.ok(newObligations.length > 0);
          assert.ok(
            newObligations.every(
              (row) => row.retention >= 119.9 && row.retention <= 120.1,
            ),
          );
          assert.ok(
            obligations.every((row) => row.confirmed_deleted_at === null),
          );
          const knownMissing = await f.pool.query(
            `WITH known AS (
          SELECT o.provider,o.environment,o.staging_bucket bucket,o.staging_key key,o.source_version version FROM whaleu_media.object_attempts o WHERE o.intent_id=$1 AND o.source_version IS NOT NULL
          UNION SELECT o.provider,o.environment,o.sealed_bucket,o.sealed_key,o.sealed_version FROM whaleu_media.object_attempts o WHERE o.intent_id=$1 AND o.sealed_version IS NOT NULL
          UNION SELECT d.provider,d.environment,d.bucket,d.object_key,d.object_version FROM whaleu_media.derived_object_attempts d WHERE d.intent_id=$1
          UNION SELECT v.provider,v.environment,v.bucket,v.object_key,v.object_version FROM whaleu_media.variants v JOIN whaleu_media.assets a ON a.id=v.asset_id WHERE a.intent_id=$1
        ) SELECT * FROM known k WHERE NOT EXISTS(SELECT 1 FROM whaleu_media.cleanup_obligations c WHERE (c.provider,c.environment,c.bucket,c.object_key,c.object_version)=(k.provider,k.environment,k.bucket,k.key,k.version))`,
            [before.intent_id],
          );
          assert.equal(
            knownMissing.rowCount,
            0,
            'every known exact locator has a durable cleanup obligation',
          );
          const replay = await f.send(s.admin, s.body);
          profileOk(replay);
          assert.deepEqual(replay.body, applied.body);
          assert.deepEqual(
            (
              await f.pool.query<{ id: string }>(
                `SELECT c.id ${cleanupJoin} WHERE coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id)=$1 ORDER BY c.id`,
                [before.intent_id],
              )
            ).rows.map((r) => r.id),
            obligations.map((r) => r.id),
          );
          for (const image of [
            before.manifest.original,
            ...before.manifest.variants,
          ])
            assert.equal(
              (await f.storage.measure(image.object)).sha256,
              image.sha256,
              'logical clear does not claim physical deletion before retention/quiescence',
            );
          // Ingress scratch has its own pre-existing immediate cleanup obligation.
          // Only the newly staged image locators retain the real two-minute floor.
          const earlyCleanup = new SyntheticMediaCleanup(f.pool, f.storage);
          let early = 0;
          for (;;) {
            const result = await earlyCleanup.runOne();
            if (result === 'idle') break;
            assert.equal(result, 'deleted');
            assert.ok(++early <= oldCleanup.size);
          }
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_media.cleanup_obligations WHERE id=ANY($1::uuid[]) AND (state<>'pending' OR confirmed_deleted_at IS NOT NULL)",
                [newObligations.map((row) => row.id)],
              )
            ).rowCount,
            0,
          );
        },
      );

      await t.test(
        'clear during paused exact storage open rejects before second authorization for guest/session variants',
        async () => {
          for (const authenticated of [false, true])
            for (const variant of ['thumb-v1', 'display-v1']) {
              const s = await scenario(f);
              const open = f.storage.openExact.bind(f.storage);
              let changed = false;
              f.storage.openExact = async (object, maximum) => {
                const opened = await open(object, maximum);
                if (!changed) {
                  changed = true;
                  const cleared = await f.send(s.admin, s.body);
                  profileOk(cleared);
                  assert.equal(cleared.body.outcome, 'applied');
                }
                return opened;
              };
              try {
                const call = request(http).get(s.path(variant));
                if (authenticated)
                  call.set('Authorization', `Bearer ${s.viewer.accessToken}`);
                const response = await call;
                assert.equal(changed, true);
                assert.notEqual(response.status, 200);
                assert.equal(
                  Buffer.isBuffer(response.body),
                  false,
                  'no previously selected image bytes leave the paused-open path',
                );
              } finally {
                f.storage.openExact = open;
              }
              assert.equal(
                (await currentProfileAvatar(f, s.subject)).avatar.state,
                'none',
              );
            }
        },
      );

      await t.test(
        'clear does not recall a stream whose final authorization already committed, while new requests reject it',
        async () => {
          const s = await scenario(f);
          const manifest = (
            await f.pool.query<{ manifest: MediaManifest }>(
              'SELECT manifest FROM whaleu_media.assets WHERE id=$1',
              [s.selected.ready.status.assetId],
            )
          ).rows[0]!.manifest;
          const image = manifest.variants.find(
            (variant) => variant.name === 'display-v1',
          );
          assert.ok(image);
          assert.ok(s.selected.current.profileId);
          const socket = new Socket();
          // Use the actual application-owned delivery and shared budget. Returning
          // from open proves that its second authorization transaction committed.
          const delivery = f.app.get(ProfileAvatarDelivery);
          const authorized = await delivery.open(
            s.viewer.accessToken,
            s.selected.current.profileId,
            s.selected.appearanceId,
            'display-v1',
            socket,
          );
          try {
            const cleared = await f.send(s.admin, s.body);
            profileOk(cleared);
            assert.equal(cleared.body.outcome, 'applied');
            assert.equal(
              (await currentProfileAvatar(f, s.subject)).avatar.state,
              'none',
            );

            const chunks: Buffer[] = [];
            for await (const chunk of authorized.stream) {
              assert.ok(Buffer.isBuffer(chunk));
              chunks.push(chunk);
            }
            const bytes = Buffer.concat(chunks);
            assert.equal(bytes.length, image.bytes);
            assert.equal(sha256(bytes), image.sha256);
            assert.equal(
              authorized.headers['Content-Length'],
              String(image.bytes),
            );

            for (const token of [null, s.viewer.accessToken]) {
              await assert.rejects(
                delivery.open(
                  token,
                  s.selected.current.profileId,
                  s.selected.appearanceId,
                  'display-v1',
                  socket,
                ),
                { code: 'MEDIA_UNAVAILABLE' },
              );
              const call = request(http).get(s.path('display-v1'));
              if (token) call.set('Authorization', `Bearer ${token}`);
              const fresh = await call;
              assert.notEqual(fresh.status, 200);
              assert.equal(Buffer.isBuffer(fresh.body), false);
            }
          } finally {
            authorized.abort();
            socket.destroy();
          }
        },
      );

      await t.test(
        'held/revoked old appearance Review and asset Safety do not block ownership-based removal',
        async () => {
          for (const owner of ['review', 'safety'] as const)
            for (const state of ['held', 'revoked'] as const) {
              const s = await scenario(f);
              if (owner === 'review')
                await setProfileAvatarReview(
                  f.pool,
                  s.selected.approved.decisionId,
                  state,
                );
              else await safety(f, s.selected.ready.status.assetId, state);
              assert.equal(
                (await currentProfileAvatar(f, s.subject)).avatar.state,
                'unavailable',
              );
              const preview = await request(http).get(s.path('display-v1'));
              assert.notEqual(preview.status, 200);
              const view = await f.management(s.target, s.admin);
              assert.equal(view.canClearCustomAvatar, true);
              const cleared = await f.send(s.admin, s.body);
              profileOk(cleared);
              assert.equal(cleared.body.outcome, 'applied');
              assert.equal(
                (await currentProfileAvatar(f, s.subject)).avatar.state,
                'none',
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1 AND detached_at IS NULL',
                    [s.selected.ready.status.assetId],
                  )
                ).rowCount,
                0,
              );
            }
        },
      );

      await t.test(
        'same pixels in a new upload remain selectable; old asset and historical receipts cannot restore a prior appearance',
        async () => {
          const s = await scenario(f);
          const cleared = await f.send(s.admin, s.body);
          profileOk(cleared);
          assert.equal(cleared.body.outcome, 'applied');
          const clearId = (
            await f.pool.query<{ appearance_id: string }>(
              'SELECT appearance_id FROM whaleu_profile.avatar_current WHERE actor_id=$1',
              [s.subject.accountId],
            )
          ).rows[0]!.appearance_id;
          const reuse: AvatarCommand = {
            ...s.selected.body,
            clientRequestId: randomUUID(),
            expectedRevision: cleared.body.revision,
          };
          await approveProfileAvatar(
            f.pool,
            await profileCommandEnvelope(f, s.subject, reuse),
          );
          const denied = await request(http)
            .post('/v1/me/profile/avatar-commands')
            .set('Authorization', `Bearer ${s.subject.accessToken}`)
            .send(reuse);
          assert.notEqual(denied.status, 200);
          assert.equal(
            (await currentProfileAvatar(f, s.subject)).avatar.state,
            'none',
          );
          const next = await f.custom(s.subject);
          assert.notEqual(
            next.ready.status.assetId,
            s.selected.ready.status.assetId,
          );
          assert.equal(next.approved.envelope.previousAppearanceId, clearId);
          assert.equal(
            next.approved.envelope.expectedRevision,
            cleared.body.revision,
          );
          assert.equal(next.current.revision, cleared.body.revision + 1);
          const newPath = `/v1/profiles/${next.current.profileId}/avatar/${next.appearanceId}/display-v1`;
          profileOk(await request(http).get(newPath));
          const selfReplay = await request(http)
            .post('/v1/me/profile/avatar-commands')
            .set('Authorization', `Bearer ${s.subject.accessToken}`)
            .send(s.selected.body);
          profileOk(selfReplay);
          assert.deepEqual(selfReplay.body, s.selected.receipt);
          const moderationReplay = await f.send(s.admin, s.body);
          profileOk(moderationReplay);
          assert.deepEqual(moderationReplay.body, cleared.body);
          assert.equal(
            (await currentProfileAvatar(f, s.subject)).avatar.appearanceId,
            next.appearanceId,
          );
          assert.notEqual(
            (await request(http).get(s.path('display-v1'))).status,
            200,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
                [s.selected.ready.status.assetId],
              )
            ).rowCount,
            1,
          );
        },
      );

      await t.test(
        'real two-minute retention and exact quiescence remain required before cleanup can claim physical deletion',
        async () => {
          const all = (
            await f.pool.query<{ id: string; not_before: Date }>(
              `SELECT c.id,c.not_before ${cleanupJoin} JOIN whaleu_media.upload_intents i ON i.id=coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id) WHERE c.state='pending' AND i.state='cleanup_pending' ORDER BY c.not_before DESC`,
            )
          ).rows;
          assert.ok(all.length > 1);
          await waitForProfileDeadline(f.pool, all[0]!.not_before);
          const lifecycle = new MediaLifecycleRepository();
          const lease = await withCommunityScopeWriter(f.pool, (tx) =>
            lifecycle.claimCleanup(tx),
          );
          assert.ok(lease);
          assert.equal(
            await withCommunityScopeWriter(f.pool, (tx) =>
              lifecycle.settleCleanup(lease, 'confirmed-absent', tx),
            ),
            'retained',
            'absence without exact quiescence is not physical deletion',
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT state,confirmed_deleted_at FROM whaleu_media.cleanup_obligations WHERE id=$1',
                [lease.id],
              )
            ).rows,
            [{ state: 'retained', confirmed_deleted_at: null }],
          );
          const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
          let deleted = 0;
          for (;;) {
            const result = await cleanup.runOne();
            if (result === 'idle') break;
            assert.equal(result, 'deleted');
            deleted++;
            assert.ok(
              deleted <= all.length,
              'cleanup is bounded by the exact retained set',
            );
          }
          assert.equal(deleted, all.length - 1);
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_media.cleanup_obligations WHERE id=ANY($1::uuid[]) AND (state NOT IN ('deleted','retained') OR (state='deleted' AND confirmed_deleted_at IS NULL))",
                [all.map((row) => row.id)],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                `SELECT 1 FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.object_attempts o ON o.id=w.object_attempt_id JOIN whaleu_media.upload_intents i ON i.id=o.intent_id WHERE i.state='cleanup_pending' AND w.state<>'retired'`,
              )
            ).rowCount,
            0,
          );
          const unaffectedAfter = await request(http).get(unaffectedPath);
          profileOk(unaffectedAfter);
          assert.deepEqual(unaffectedAfter.body, unaffectedBefore.body);
          assert.equal(
            (await currentProfileAvatar(f, unaffected)).avatar.appearanceId,
            unaffectedSelection.appearanceId,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
