import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import {
  syntheticProfileRuntimeFixture,
  seedSyntheticAvatarCatalog,
  readyProfileAvatar,
  currentProfileAvatar,
  selectProfileAvatar,
  profileCommandEnvelope,
  approveProfileAvatar,
  setProfileAvatarReview,
  profileOk,
  profileAssetRetentionBoundaryPool,
  waitForProfileDeadline,
} from '../support/media/profile-runtime-fixture.js';
import type { ProfileActor } from '../support/media/profile-runtime-fixture.js';
import { SyntheticMediaWorker } from '../support/media/synthetic-worker.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { profileMediaRecoverySchema } from '../../src/media/contracts-profile.js';
import type { AvatarCommand } from '../../src/profile/avatar/contracts.js';
import { checkTransactionDeadlines } from '../../src/database/transaction-deadlines.js';
import { requireAvatarCurrent } from '../../src/profile/avatar/current-proof.js';
import { inTransaction } from '../../src/database/database.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { ProfileAvatarUploadApplication } from '../../src/profile/avatar/upload-application.js';

const command = (
  revision: number,
  source: AvatarCommand['source'],
): AvatarCommand => ({
  protocol: 'profile-media-v1',
  clientRequestId: randomUUID(),
  expectedRevision: revision,
  source,
});
const codeIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const own = '/v1/me/profile';

test(
  'real Profile avatar catalog, exact upload, replacement, guest delivery, proofs and retained cleanup',
  { timeout: 360000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#226699' },
    })
      .png()
      .toBuffer();
    const jpeg = await sharp({
      create: { width: 80, height: 80, channels: 3, background: '#a55a38' },
    })
      .jpeg()
      .toBuffer();
    const f = await syntheticProfileRuntimeFixture([
      { sha256: sha256(png), verdict: 'allow' },
      { sha256: sha256(jpeg), verdict: 'allow' },
    ]);
    const http = f.app.getHttpServer();
    try {
      const catalog = await seedSyntheticAvatarCatalog(
        f,
        png,
        'image/png',
        64,
        48,
      );
      await t.test(
        'synthetic catalog selection and clear use shared CAS and immutable same-key receipt',
        async () => {
          const actor = await f.actor(),
            auth = `Bearer ${actor.accessToken}`;
          const empty = await currentProfileAvatar(f, actor);
          assert.equal(empty.revision, 0);
          assert.equal(empty.profileId, null);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.profiles WHERE account_id=$1',
                [actor.accountId],
              )
            ).rowCount,
            0,
            'read does not create a profile',
          );
          const input = command(0, {
            kind: 'catalog',
            catalogVersion: catalog.catalogVersion,
            itemId: catalog.itemId,
          });
          const catalogReview = await approveProfileAvatar(
            f.pool,
            await profileCommandEnvelope(f, actor, input),
          );
          const both = await Promise.all(
            [0, 1].map(() =>
              request(http)
                .post(`${own}/avatar-commands`)
                .set('Authorization', auth)
                .send(input),
            ),
          );
          for (const response of both) profileOk(response);
          assert.deepEqual(both[0]!.body, both[1]!.body);
          assert.equal(both[0]!.body.resultingRevision, 1);
          const selected = await currentProfileAvatar(f, actor);
          assert.equal(selected.avatar.state, 'available');
          assert.equal(selected.avatar.source?.kind, 'catalog');
          assert.ok(selected.profileId);
          assert.ok(selected.avatar.appearanceId);
          const path = `/v1/profiles/${selected.profileId}/avatar/${selected.avatar.appearanceId}/display-v1`;
          const bytes = await request(http).get(path);
          profileOk(bytes);
          assert.deepEqual(bytes.body, png);
          assert.equal(bytes.headers['cache-control'], 'private, no-store');
          assert.equal(bytes.headers['x-content-type-options'], 'nosniff');
          assert.notEqual(
            (
              await request(http)
                .get(path)
                .set('Authorization', 'Bearer invalid')
            ).status,
            200,
            'bad bearer never downgrades to guest',
          );
          assert.notEqual(
            (await request(http).get(path).set('Range', 'bytes=0-1')).status,
            200,
          );
          for (const change of ['profile', 'catalog', 'review'] as const) {
            const open = f.storage.openExact.bind(f.storage);
            let changed = false;
            f.storage.openExact = async (locator, maximum) => {
              const opened = await open(locator, maximum);
              if (!changed) {
                changed = true;
                if (change === 'profile')
                  await f.pool.query(
                    'UPDATE whaleu_profile.profiles SET nickname=nickname WHERE account_id=$1',
                    [actor.accountId],
                  );
                else if (change === 'catalog')
                  await f.pool.query(
                    'UPDATE whaleu_profile.avatar_catalog_items SET available=available WHERE catalog_version=$1 AND item_id=$2',
                    [catalog.catalogVersion, catalog.itemId],
                  );
                else
                  await setProfileAvatarReview(
                    f.pool,
                    catalogReview.decisionId,
                    'allow',
                  );
              }
              return opened;
            };
            try {
              const raced = await request(http).get(path);
              assert.notEqual(
                raced.status,
                200,
                `${change} same-value current rewrite must change the two-transaction plan`,
              );
              assert.equal(Buffer.isBuffer(raced.body), false);
              assert.equal(changed, true);
            } finally {
              f.storage.openExact = open;
            }
            profileOk(await request(http).get(path));
          }
          const stale = await request(http)
            .post(`${own}/avatar-commands`)
            .set('Authorization', auth)
            .send(command(0, { kind: 'clear' }));
          assert.equal(stale.status, 409);
          const clear = command(1, { kind: 'clear' });
          await selectProfileAvatar(f, actor, clear);
          assert.equal(
            (await currentProfileAvatar(f, actor)).avatar.state,
            'none',
          );
          assert.notEqual((await request(http).get(path)).status, 200);
          const historical = await request(http)
            .get(`${own}/avatar-command-requests/${input.clientRequestId}`)
            .set('Authorization', auth);
          profileOk(historical);
          assert.equal(historical.body.state, 'committed');
          assert.deepEqual(historical.body.receipt, both[0]!.body);
          const replay = await request(http)
            .post(`${own}/avatar-commands`)
            .set('Authorization', auth)
            .send(input);
          profileOk(replay);
          assert.deepEqual(replay.body, both[0]!.body);
          assert.equal((await currentProfileAvatar(f, actor)).revision, 2);
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_media.bindings WHERE owner_kind='profile'",
              )
            ).rowCount,
            0,
            'catalog never invents a user Media binding',
          );
          const ordinary = await f.startOrdinaryRuntime();
          const unavailable = await request(ordinary.getHttpServer()).get(
            '/v1/profile-avatar-catalog',
          );
          profileOk(unavailable);
          assert.equal(unavailable.body.availability, 'unavailable');
          const ordinaryActor = await f.actor(),
            ordinaryAuth = `Bearer ${ordinaryActor.accessToken}`;
          assert.equal(
            (
              await request(ordinary.getHttpServer())
                .post(`${own}/avatar-edits`)
                .set('Authorization', ordinaryAuth)
                .send({
                  protocol: 'profile-media-v1',
                  clientRequestId: randomUUID(),
                  expectedRevision: 0,
                  slot: 'avatar',
                  declaration: {
                    mime: 'image/png',
                    bytes: png.length,
                    sha256: sha256(png),
                  },
                })
            ).status,
            503,
          );
          assert.equal(
            (
              await request(ordinary.getHttpServer())
                .post(`${own}/avatar-commands`)
                .set('Authorization', ordinaryAuth)
                .send(command(0, { kind: 'clear' }))
            ).status,
            503,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.avatar_edits WHERE actor_id=$1',
                [ordinaryActor.accountId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'real multipart source, exact processing and Profile Review compose; failure preserves old appearance',
        async () => {
          const actor = await f.actor(),
            other = await f.actor(),
            auth = `Bearer ${actor.accessToken}`;
          const first = await readyProfileAvatar(f, actor, png);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.profiles WHERE account_id=$1',
                [actor.accountId],
              )
            ).rowCount,
            0,
            'prepare does not create public profile',
          );
          const one = command(0, {
            kind: 'custom',
            editId: first.status.editId,
            assetId: first.status.assetId,
          });
          const denied = await request(http)
            .post(`${own}/avatar-commands`)
            .set('Authorization', auth)
            .send(one);
          assert.notEqual(
            denied.status,
            200,
            'asset allow is not exact Profile Review',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
                [first.status.assetId],
              )
            ).rowCount,
            0,
          );
          const selected = await selectProfileAvatar(f, actor, one);
          assert.ok(selected.current.profileId);
          assert.ok(selected.current.avatar.appearanceId);
          const immutable = (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23514';
          await assert.rejects(
            f.pool.query(
              'UPDATE whaleu_media.assets SET resource_id=$2 WHERE id=$1',
              [first.status.assetId, randomUUID()],
            ),
            immutable,
          );
          await assert.rejects(
            f.pool.query(
              'UPDATE whaleu_media.bindings SET resource_id=$2 WHERE asset_id=$1',
              [first.status.assetId, randomUUID()],
            ),
            immutable,
          );
          await assert.rejects(
            f.pool.query(
              'UPDATE whaleu_profile.avatar_edits SET scope_revision=$2 WHERE id=$1',
              [first.status.editId, '1'],
            ),
            immutable,
          );
          const oldPath = `/v1/profiles/${selected.current.profileId}/avatar/${selected.current.avatar.appearanceId}/display-v1`;
          const firstBytes = await request(http).get(oldPath);
          profileOk(firstBytes);
          const manifest = (
            await f.pool.query<{
              manifest: { variants: { sha256: string }[] };
            }>('SELECT manifest FROM whaleu_media.assets WHERE id=$1', [
              first.status.assetId,
            ])
          ).rows[0]!.manifest;
          assert.equal(
            sha256(firstBytes.body as Buffer),
            manifest.variants[1]!.sha256,
          );
          const privateStatus = await request(http)
            .get(`${own}/avatar-edits/${first.status.editId}`)
            .set('Authorization', `Bearer ${other.accessToken}`);
          assert.notEqual(privateStatus.status, 200);
          const lateCancel = await request(http)
            .post(
              `${own}/avatar-edit-requests/${first.input.clientRequestId}/cancel`,
            )
            .set('Authorization', auth)
            .send({
              protocol: 'profile-media-v1',
              requestHash: first.status.requestHash,
            });
          profileOk(lateCancel);
          assert.equal(lateCancel.body.status.status, 'bound_history');
          assert.deepEqual(lateCancel.body.status.command, selected.receipt);
          await setProfileAvatarReview(
            f.pool,
            selected.approved.decisionId,
            'held',
          );
          assert.equal(
            (await currentProfileAvatar(f, actor)).avatar.state,
            'unavailable',
          );
          assert.notEqual((await request(http).get(oldPath)).status, 200);
          await setProfileAvatarReview(
            f.pool,
            selected.approved.decisionId,
            'allow',
          );
          const beforeReviewOpen = f.storage.openExact.bind(f.storage);
          let reviewChanged = false;
          f.storage.openExact = async (locator, maximum) => {
            const opened = await beforeReviewOpen(locator, maximum);
            if (!reviewChanged) {
              reviewChanged = true;
              await setProfileAvatarReview(
                f.pool,
                selected.approved.decisionId,
                'allow',
              );
            }
            return opened;
          };
          try {
            const raced = await request(http).get(oldPath);
            assert.notEqual(
              raced.status,
              200,
              'custom allow-to-allow Review revision is an exact plan dependency',
            );
            assert.equal(Buffer.isBuffer(raced.body), false);
            assert.equal(reviewChanged, true);
          } finally {
            f.storage.openExact = beforeReviewOpen;
          }
          profileOk(await request(http).get(oldPath));
          const second = await readyProfileAvatar(f, actor, jpeg, 'image/jpeg'),
            two = command(1, {
              kind: 'custom',
              editId: second.status.editId,
              assetId: second.status.assetId,
            });
          await approveProfileAvatar(
            f.pool,
            await profileCommandEnvelope(f, actor, two),
          );
          const faults = [
            {
              table: 'whaleu_media.scope_consumptions',
              event: 'INSERT',
              when: '',
            },
            { table: 'whaleu_media.bindings', event: 'INSERT', when: '' },
            {
              table: 'whaleu_community.profile_avatar_approval_bindings',
              event: 'INSERT',
              when: '',
            },
            {
              table: 'whaleu_profile.avatar_definitions',
              event: 'INSERT',
              when: '',
            },
            {
              table: 'whaleu_profile.avatar_current',
              event: 'UPDATE',
              when: '',
            },
            {
              table: 'whaleu_profile.avatar_command_receipts',
              event: 'INSERT',
              when: '',
            },
            {
              table: 'whaleu_media.bindings',
              event: 'UPDATE',
              when: 'WHEN (NEW.detached_at IS NOT NULL)',
            },
          ];
          for (const fault of faults) {
            // Fixed relation/event literals above only. Inject after the real write
            // so every earlier owner/Review/Media mutation has to roll back too.
            await f.pool.query(
              `CREATE FUNCTION whaleu_profile.synthetic_avatar_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic Profile replacement failure';END $$; CREATE TRIGGER z_synthetic_avatar_failure AFTER ${fault.event} ON ${fault.table} FOR EACH ROW ${fault.when} EXECUTE FUNCTION whaleu_profile.synthetic_avatar_failure()`,
            );
            try {
              const failed = await request(http)
                .post(`${own}/avatar-commands`)
                .set('Authorization', auth)
                .send(two);
              assert.equal(
                failed.status,
                500,
                `${fault.table}/${fault.event} must reach the injected transaction fault`,
              );
              const current = await currentProfileAvatar(f, actor);
              assert.equal(
                current.avatar.appearanceId,
                selected.current.avatar.appearanceId,
              );
              assert.equal(current.revision, 1);
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
                    [second.status.assetId],
                  )
                ).rowCount,
                0,
                'tentative new binding rolls back',
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_media.scope_consumptions WHERE scope_resource_id=$1',
                    [second.status.editId],
                  )
                ).rowCount,
                0,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1 AND detached_at IS NULL',
                    [first.status.assetId],
                  )
                ).rowCount,
                1,
                'old binding remains current after failure',
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_profile.avatar_command_receipts WHERE actor_id=$1 AND client_request_id=$2',
                    [actor.accountId, two.clientRequestId],
                  )
                ).rowCount,
                0,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_community.profile_avatar_approval_bindings WHERE appearance_id=$1',
                    [
                      (await profileCommandEnvelope(f, actor, two))
                        .appearanceId,
                    ],
                  )
                ).rowCount,
                0,
              );
            } finally {
              await f.pool.query(
                `DROP TRIGGER z_synthetic_avatar_failure ON ${fault.table};DROP FUNCTION whaleu_profile.synthetic_avatar_failure()`,
              );
            }
          }
          const open = f.storage.openExact.bind(f.storage);
          let replaced = false;
          f.storage.openExact = async (object, maximum) => {
            const opened = await open(object, maximum);
            if (!replaced) {
              replaced = true;
              profileOk(
                await request(http)
                  .post(`${own}/avatar-commands`)
                  .set('Authorization', auth)
                  .send(two),
              );
            }
            return opened;
          };
          try {
            const raced = await request(http).get(oldPath);
            assert.notEqual(raced.status, 200);
            assert.ok(
              !Buffer.isBuffer(raced.body),
              'no old image bytes after replacement during exact open',
            );
          } finally {
            f.storage.openExact = open;
          }
          assert.equal(replaced, true);
          assert.equal((await currentProfileAvatar(f, actor)).revision, 2);
          const oldState = (
            await f.pool.query<{ state: string }>(
              `SELECT i.state FROM whaleu_media.upload_intents i JOIN whaleu_media.assets a ON a.intent_id=i.id WHERE a.id=$1`,
              [first.status.assetId],
            )
          ).rows[0]!.state;
          assert.equal(oldState, 'cleanup_pending');
          const history = await request(http)
            .get(`${own}/avatar-edit-requests/${first.input.clientRequestId}`)
            .set('Authorization', auth);
          profileOk(history);
          const recovered = profileMediaRecoverySchema.parse(history.body);
          assert.equal(recovered.state, 'recorded');
          if (recovered.state !== 'recorded')
            throw new Error('Missing history');
          assert.equal(recovered.status.status, 'bound_history');
          if (recovered.status.status === 'bound_history')
            assert.equal(recovered.status.attachmentState, 'detached');
          const finalCatalog = command(2, {
            kind: 'catalog',
            catalogVersion: catalog.catalogVersion,
            itemId: catalog.itemId,
          });
          await selectProfileAvatar(f, actor, finalCatalog);
          const obligations = (
            await f.pool.query<{
              state: string;
              confirmed_deleted_at: Date | null;
            }>(
              'SELECT state,confirmed_deleted_at FROM whaleu_media.cleanup_obligations',
            )
          ).rows;
          assert.ok(obligations.length > 0);
          assert.ok(
            obligations.every((row) => row.confirmed_deleted_at === null),
            'durable detach is not physical deletion',
          );
          const delay = Number(
            (
              await f.pool.query<{ delay: number }>(
                `SELECT greatest(0,extract(epoch FROM(max(not_before)-clock_timestamp()))*1000)::integer delay FROM whaleu_media.cleanup_obligations WHERE state='pending'`,
              )
            ).rows[0]!.delay,
          );
          assert.ok(delay >= 0 && delay <= 120000);
          await sleep(delay + 50); // Real retention clock. Do not rewrite historical deadlines.
          const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
          let settled = 0;
          while (settled <= obligations.length) {
            const result = await cleanup.runOne();
            if (result === 'idle') break;
            assert.equal(result, 'deleted');
            settled++;
          }
          assert.equal(settled, obligations.length);
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_media.cleanup_obligations WHERE state<>'deleted' OR confirmed_deleted_at IS NULL",
              )
            ).rowCount,
            0,
          );
          for (const image of [
            catalog.manifest.original,
            ...catalog.manifest.variants,
          ])
            assert.equal(
              (await f.storage.measure(image.object)).sha256,
              image.sha256,
              'catalog objects are never user GC targets',
            );
          const after = await request(http)
            .get(`${own}/avatar-edit-requests/${first.input.clientRequestId}`)
            .set('Authorization', auth);
          profileOk(after);
          assert.equal(
            after.body.status.status,
            'bound_history',
            'physical cleanup retains historical receipt',
          );
        },
      );
      await t.test(
        'shared profile CAS and durable pre-prepare cancellation never rebase or allocate replacement IDs',
        async () => {
          const actor = await f.actor(),
            auth = `Bearer ${actor.accessToken}`,
            upload = f.app.get(ProfileAvatarUploadApplication);
          const input = {
            protocol: 'profile-media-v1',
            clientRequestId: randomUUID(),
            expectedRevision: 0,
            slot: 'avatar',
            declaration: {
              mime: 'image/png',
              bytes: png.length,
              sha256: sha256(png),
            },
          };
          const { profileMediaRequestHash } =
            await import('../../src/media/contracts-profile.js');
          const cancelled = await upload.cancelRequest(
            actor.accessToken,
            input.clientRequestId,
            {
              protocol: 'profile-media-v1',
              requestHash: profileMediaRequestHash(actor.accountId, input),
            },
          );
          assert.equal(cancelled.state, 'cancelled_before_prepare');
          await assert.rejects(
            upload.prepare(actor.accessToken, input),
            codeIs('MEDIA_REQUEST_CANCELLED'),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1',
                [actor.accountId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.avatar_edits WHERE actor_id=$1',
                [actor.accountId],
              )
            ).rowCount,
            0,
          );
          const prepared = await readyProfileAvatar(f, actor, png);
          const nickname = await request(http)
            .patch('/v1/me/profile')
            .set('Authorization', auth)
            .send({ expectedRevision: 0, nickname: 'avatar_cas' });
          profileOk(nickname);
          const stale = await request(http)
            .post(`${own}/avatar-commands`)
            .set('Authorization', auth)
            .send(
              command(0, {
                kind: 'custom',
                editId: prepared.status.editId,
                assetId: prepared.status.assetId,
              }),
            );
          assert.equal(stale.status, 409);
          assert.equal((await currentProfileAvatar(f, actor)).revision, 1);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
                [prepared.status.assetId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'Profile and legacy absent-intent cancellation histories are isolated in both directions',
        async () => {
          const actor = await f.actor(),
            auth = `Bearer ${actor.accessToken}`,
            key = randomUUID(),
            hash = 'a'.repeat(64);
          const profileFence = await request(http)
            .post(`${own}/avatar-edit-requests/${key}/cancel`)
            .set('Authorization', auth)
            .send({ protocol: 'profile-media-v1', requestHash: hash });
          profileOk(profileFence);
          const legacyRead = await request(http)
            .get(`/v2/media/upload-requests/${key}`)
            .set('Authorization', auth);
          assert.equal(legacyRead.status, 409);
          const other = randomUUID();
          const legacyFence = await request(http)
            .post(`/v2/media/upload-requests/${other}/cancel`)
            .set('Authorization', auth)
            .send({ requestHash: hash });
          profileOk(legacyFence);
          const profileRead = await request(http)
            .get(`${own}/avatar-edit-requests/${other}`)
            .set('Authorization', auth);
          assert.equal(profileRead.status, 409);
          const profileCancel = await request(http)
            .post(`${own}/avatar-edit-requests/${other}/cancel`)
            .set('Authorization', auth)
            .send({ protocol: 'profile-media-v1', requestHash: hash });
          assert.equal(profileCancel.status, 409);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.profile_request_markers WHERE actor_id=$1',
                [actor.accountId],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'command cancel-before and cancel-versus-commit establish one durable original-key outcome',
        async () => {
          const actor = await f.actor(),
            auth = `Bearer ${actor.accessToken}`,
            before = command(0, {
              kind: 'catalog',
              catalogVersion: catalog.catalogVersion,
              itemId: catalog.itemId,
            });
          const { avatarCommandHash } =
            await import('../../src/profile/avatar/contracts.js');
          const beforeHash = avatarCommandHash(actor.accountId, before);
          const cancelled = await request(http)
            .post(
              `${own}/avatar-command-requests/${before.clientRequestId}/cancel`,
            )
            .set('Authorization', auth)
            .send({ protocol: 'profile-media-v1', requestHash: beforeHash });
          profileOk(cancelled);
          assert.equal(cancelled.body.state, 'cancelled');
          const refused = await request(http)
            .post(`${own}/avatar-commands`)
            .set('Authorization', auth)
            .send(before);
          assert.equal(refused.status, 409);
          assert.equal((await currentProfileAvatar(f, actor)).revision, 0);
          const racing = command(0, {
              kind: 'catalog',
              catalogVersion: catalog.catalogVersion,
              itemId: catalog.itemId,
            }),
            hash = avatarCommandHash(actor.accountId, racing);
          await approveProfileAvatar(
            f.pool,
            await profileCommandEnvelope(f, actor, racing),
          );
          const [commit, cancel] = await Promise.all([
            request(http)
              .post(`${own}/avatar-commands`)
              .set('Authorization', auth)
              .send(racing),
            request(http)
              .post(
                `${own}/avatar-command-requests/${racing.clientRequestId}/cancel`,
              )
              .set('Authorization', auth)
              .send({ protocol: 'profile-media-v1', requestHash: hash }),
          ]);
          profileOk(cancel);
          if (cancel.body.state === 'committed') {
            profileOk(commit);
            assert.deepEqual(cancel.body.receipt, commit.body);
            assert.equal((await currentProfileAvatar(f, actor)).revision, 1);
          } else {
            assert.equal(cancel.body.state, 'cancelled');
            assert.equal(commit.status, 409);
            assert.equal((await currentProfileAvatar(f, actor)).revision, 0);
          }
          const repeated = await request(http)
            .post(
              `${own}/avatar-command-requests/${racing.clientRequestId}/cancel`,
            )
            .set('Authorization', auth)
            .send({ protocol: 'profile-media-v1', requestHash: hash });
          profileOk(repeated);
          assert.deepEqual(repeated.body, cancel.body);
        },
      );
      await t.test(
        'Profile Review consume deadline expiring inside a real deferred wait rolls the selection back',
        async () => {
          const actor = await f.actor(),
            auth = `Bearer ${actor.accessToken}`,
            input = command(0, {
              kind: 'catalog',
              catalogVersion: catalog.catalogVersion,
              itemId: catalog.itemId,
            }),
            envelope = await profileCommandEnvelope(f, actor, input);
          const until = new Date(Date.now() + 10000);
          await approveProfileAvatar(f.pool, envelope, { consumeUntil: until });
          await f.pool.query(
            `CREATE FUNCTION whaleu_profile.synthetic_avatar_expiry_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(8079,8081);RETURN NEW;END $$;CREATE CONSTRAINT TRIGGER z_synthetic_avatar_expiry_wait AFTER INSERT ON whaleu_profile.avatar_definitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.synthetic_avatar_expiry_wait()`,
          );
          const blocker = await f.pool.connect();
          await blocker.query('SELECT pg_advisory_lock(8079,8081)');
          try {
            const result = request(http)
              .post(`${own}/avatar-commands`)
              .set('Authorization', auth)
              .send(input)
              .then((value) => value);
            await f.waitForLock('SET CONSTRAINTS ALL IMMEDIATE');
            await f.pool.query(
              `SELECT pg_sleep(greatest(0,extract(epoch FROM($1::timestamptz-clock_timestamp())))+0.05)`,
              [until],
            );
            await blocker.query('SELECT pg_advisory_unlock(8079,8081)');
            assert.equal((await result).status, 503);
            assert.equal((await currentProfileAvatar(f, actor)).revision, 0);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_profile.avatar_definitions WHERE actor_id=$1',
                  [actor.accountId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await blocker.query('SELECT pg_advisory_unlock(8079,8081)');
            blocker.release();
            await f.pool.query(
              'DROP TRIGGER z_synthetic_avatar_expiry_wait ON whaleu_profile.avatar_definitions;DROP FUNCTION whaleu_profile.synthetic_avatar_expiry_wait()',
            );
          }
          await approveProfileAvatar(f.pool, envelope);
          profileOk(
            await request(http)
              .post(`${own}/avatar-commands`)
              .set('Authorization', auth)
              .send(input),
          );
          assert.equal((await currentProfileAvatar(f, actor)).revision, 1);
        },
      );
      await t.test(
        'Profile ready retention crosses a real cutoff from a legal immutable historical INSERT snapshot',
        async () => {
          const actor = await f.actor(),
            auth = `Bearer ${actor.accessToken}`;
          const worker = new SyntheticMediaWorker(
            profileAssetRetentionBoundaryPool(f.pool),
            f.storage,
            [{ sha256: sha256(png), verdict: 'allow' }],
          );
          const ready = await readyProfileAvatar(
            f,
            actor,
            png,
            'image/png',
            worker,
          );
          assert.ok(
            ready.status.readyRetentionUntil < ready.status.editExpiresAt,
            'asset retention, not edit lifetime, is the limiting deadline',
          );
          assert.equal(
            ready.status.bindBefore,
            ready.status.readyRetentionUntil,
          );
          const input = command(0, {
            kind: 'custom',
            editId: ready.status.editId,
            assetId: ready.status.assetId,
          });
          await approveProfileAvatar(
            f.pool,
            await profileCommandEnvelope(f, actor, input),
          );
          await waitForProfileDeadline(
            f.pool,
            ready.status.readyRetentionUntil,
          );
          const expired = await request(http)
            .get(`${own}/avatar-edits/${ready.status.editId}`)
            .set('Authorization', auth);
          profileOk(expired);
          assert.equal(expired.body.status, 'terminal');
          assert.equal(expired.body.reason, 'expired');
          const denied = await request(http)
            .post(`${own}/avatar-commands`)
            .set('Authorization', auth)
            .send(input);
          assert.notEqual(denied.status, 200);
          assert.equal((await currentProfileAvatar(f, actor)).revision, 0);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
                [ready.status.assetId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            await withCommunityScopeWriter(f.pool, (tx) =>
              f.profile.lifecycle.expireOne(tx),
            ),
            true,
          );
          const row = (
            await f.pool.query<{ state: string }>(
              `SELECT state FROM whaleu_media.upload_intents WHERE id=$1`,
              [ready.status.intentId],
            )
          ).rows[0]!;
          assert.equal(row.state, 'cleanup_pending');
          const obligations = (
            await f.pool.query<{
              variant_name: string;
              id: string | null;
              state: string | null;
              asset_id: string | null;
              obligation_variant: string | null;
              derived_attempt_id: string | null;
              derived_intent: string | null;
              derived_variant: string | null;
            }>(
              `SELECT v.variant_name,c.id,c.state,c.asset_id,c.variant_name AS obligation_variant,
              c.derived_attempt_id,d.intent_id AS derived_intent,d.variant_name AS derived_variant
             FROM whaleu_media.variants v
             LEFT JOIN whaleu_media.cleanup_obligations c
               ON (c.provider,c.environment,c.bucket,c.object_key,c.object_version)
                =(v.provider,v.environment,v.bucket,v.object_key,v.object_version)
             LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
             WHERE v.asset_id=$1 ORDER BY v.variant_name`,
              [ready.status.assetId],
            )
          ).rows;
          // The exact-locator uniqueness fence intentionally deduplicates the
          // derived-attempt and committed-variant paths to the same bytes.
          assert.deepEqual(
            obligations.map((value) => value.variant_name),
            ['display-v1', 'thumb-v1'],
          );
          assert.equal(new Set(obligations.map((value) => value.id)).size, 2);
          for (const obligation of obligations) {
            assert.ok(
              obligation.id,
              'every exact variant locator has a durable deletion obligation',
            );
            assert.equal(obligation.state, 'pending');
            assert.ok(
              (obligation.asset_id === ready.status.assetId &&
                obligation.obligation_variant === obligation.variant_name) ||
                (obligation.derived_attempt_id !== null &&
                  obligation.derived_intent === ready.status.intentId &&
                  obligation.derived_variant === obligation.variant_name),
              'expiry obligation belongs to this exact source intent and variant, not another object',
            );
          }
        },
      );
      await t.test(
        'real avatar endpoints use bounded actor proof instead of waiting on a writer-held Profile tuple',
        async () => {
          const actor = await f.actor(),
            selected = await selectProfileAvatar(
              f,
              actor,
              command(0, {
                kind: 'catalog',
                catalogVersion: catalog.catalogVersion,
                itemId: catalog.itemId,
              }),
            );
          const profileId = selected.current.profileId!,
            path = `/v1/profiles/${profileId}/avatar`,
            image = `${path}/${selected.current.avatar.appearanceId}/thumb-v1`,
            writer = await f.pool.connect();
          try {
            await writer.query('BEGIN');
            await writer.query(
              'UPDATE whaleu_profile.profiles SET nickname=nickname WHERE account_id=$1',
              [actor.accountId],
            );
            for (const endpoint of [path, image]) {
              const started = performance.now(),
                response = await request(http)
                  .get(endpoint)
                  .timeout({ response: 1000, deadline: 1500 });
              assert.equal(response.status, 503);
              assert.ok(performance.now() - started < 1000);
              assert.equal(Buffer.isBuffer(response.body), false);
            }
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
          const current = f.profile.repository.current.bind(
            f.profile.repository,
          );
          let captured!: () => void,
            release!: () => void,
            once = false;
          const fenced = new Promise<void>((resolve) => {
              captured = resolve;
            }),
            resume = new Promise<void>((resolve) => {
              release = resolve;
            });
          f.profile.repository.current = async (account, tx) => {
            const value = await current(account, tx);
            if (account === actor.accountId && !once) {
              once = true;
              await checkTransactionDeadlines(tx);
              captured();
              await resume;
            }
            return value;
          };
          try {
            const reading = request(http)
              .get(path)
              .then((value) => value);
            await fenced;
            const writing = f.pool.query(
              'UPDATE whaleu_profile.profiles SET nickname=nickname WHERE account_id=$1',
              [actor.accountId],
            );
            try {
              await f.waitForLock('UPDATE whaleu_profile.profiles');
            } finally {
              release();
            }
            profileOk(await reading);
            assert.equal((await writing).rowCount, 1);
          } finally {
            release();
            f.profile.repository.current = current;
          }
          profileOk(await request(http).get(image));
        },
      );
      await t.test(
        'HTTP target lookup rejects public and empty-owner identity rewrites while bound owner keys remain protected',
        async () => {
          const actor = await f.actor(),
            next = await f.actor();
          const selected = await selectProfileAvatar(
            f,
            actor,
            command(0, {
              kind: 'catalog',
              catalogVersion: catalog.catalogVersion,
              itemId: catalog.itemId,
            }),
          );
          const publicId = selected.current.profileId!;
          const image = `/v1/profiles/${publicId}/avatar/${selected.current.avatar.appearanceId}/thumb-v1`;
          const target = f.profile.profiles.avatarPublicTarget.bind(
            f.profile.profiles,
          );
          let changed = false;
          f.profile.profiles.avatarPublicTarget = async (id, tx) => {
            const found = await target(id, tx);
            if (id === publicId && !changed) {
              changed = true;
              assert.equal(
                (
                  await f.pool.query(
                    'UPDATE whaleu_profile.profiles SET public_id=$2 WHERE account_id=$1',
                    [actor.accountId, randomUUID()],
                  )
                ).rowCount,
                1,
              );
            }
            return found;
          };
          try {
            const response = await request(http).get(image);
            assert.equal(response.status, 503);
            assert.equal(changed, true);
            assert.equal(Buffer.isBuffer(response.body), false);
          } finally {
            f.profile.profiles.avatarPublicTarget = target;
            await f.pool.query(
              'UPDATE whaleu_profile.profiles SET public_id=$2 WHERE account_id=$1',
              [actor.accountId, publicId],
            );
          }
          const foreignKeyViolation = (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23503';
          // A selected avatar has an immediate FK to its Profile row. Illegal
          // rewrites are tested as DB failures, never mistaken for read races.
          await assert.rejects(
            f.pool.query(
              'UPDATE whaleu_profile.profiles SET account_id=$2 WHERE account_id=$1',
              [actor.accountId, next.accountId],
            ),
            foreignKeyViolation,
          );
          await assert.rejects(
            f.pool.query(
              'DELETE FROM whaleu_profile.profiles WHERE account_id=$1',
              [actor.accountId],
            ),
            foreignKeyViolation,
          );
          assert.deepEqual(
            await currentProfileAvatar(f, actor),
            selected.current,
            'failed bound-owner writes roll back the original pointer and revision',
          );
          assert.equal(
            (await currentProfileAvatar(f, next)).avatar.state,
            'none',
            'the failed actor move cannot transfer the selected appearance',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.avatar_current WHERE actor_id=$1 AND appearance_id=$2',
                [actor.accountId, selected.current.avatar.appearanceId],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.avatar_current WHERE actor_id=$1',
                [next.accountId],
              )
            ).rowCount,
            0,
          );
          const originalImage = await request(http).get(image);
          profileOk(originalImage);
          assert.deepEqual(originalImage.body, png);

          const empty = await f.actor();
          const emptyPublicId = (
            await f.pool.query<{ public_id: string }>(
              'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1) RETURNING public_id',
              [empty.accountId],
            )
          ).rows[0]!.public_id;
          const emptyPath = `/v1/profiles/${emptyPublicId}/avatar`;
          changed = false;
          f.profile.profiles.avatarPublicTarget = async (id, tx) => {
            const found = await target(id, tx);
            if (id === emptyPublicId && !changed) {
              changed = true;
              assert.equal(
                (
                  await f.pool.query(
                    'UPDATE whaleu_profile.profiles SET account_id=$2 WHERE account_id=$1',
                    [empty.accountId, next.accountId],
                  )
                ).rowCount,
                1,
              );
            }
            return found;
          };
          try {
            const response = await request(http).get(emptyPath);
            assert.equal(response.status, 503);
            assert.equal(changed, true);
            assert.equal(Buffer.isBuffer(response.body), false);
          } finally {
            f.profile.profiles.avatarPublicTarget = target;
            assert.equal(
              (
                await f.pool.query(
                  'UPDATE whaleu_profile.profiles SET account_id=$2 WHERE account_id=$1',
                  [next.accountId, empty.accountId],
                )
              ).rowCount,
              1,
            );
          }
          const original = (
            await f.pool.query(
              'SELECT to_jsonb(p) value FROM whaleu_profile.profiles p WHERE account_id=$1',
              [empty.accountId],
            )
          ).rows[0]!.value;
          const current = f.profile.repository.current.bind(
            f.profile.repository,
          );
          let replaced = false;
          f.profile.repository.current = async (account, tx) => {
            const value = await current(account, tx);
            if (account === empty.accountId && !replaced) {
              replaced = true;
              await inTransaction(
                f.pool,
                async (writer) => {
                  assert.equal(
                    (
                      await writer.query(
                        'DELETE FROM whaleu_profile.profiles WHERE account_id=$1',
                        [empty.accountId],
                      )
                    ).rowCount,
                    1,
                  );
                  await writer.query(
                    'INSERT INTO whaleu_profile.profiles SELECT * FROM jsonb_populate_record(NULL::whaleu_profile.profiles,$1::jsonb)',
                    [JSON.stringify(original)],
                  );
                },
                { isolationLevel: 'read committed' },
              );
            }
            return value;
          };
          try {
            const response = await request(http).get(emptyPath);
            assert.equal(response.status, 503);
            assert.equal(replaced, true);
            assert.equal(Buffer.isBuffer(response.body), false);
          } finally {
            f.profile.repository.current = current;
          }
          const available = await request(http).get(emptyPath);
          profileOk(available);
          assert.equal(available.body.avatar.state, 'none');
          assert.equal(
            (
              await request(http).get(
                `/v1/profiles/${randomUUID()}/avatar/${selected.current.avatar.appearanceId}/thumb-v1`,
              )
            ).status,
            503,
          );
        },
      );
      await t.test(
        'HTTP avatar first authorization cannot escape a raw source write during deferred finalization',
        async () => {
          const actor = await f.actor(),
            selected = await selectProfileAvatar(
              f,
              actor,
              command(0, {
                kind: 'catalog',
                catalogVersion: catalog.catalogVersion,
                itemId: catalog.itemId,
              }),
            ),
            image = `/v1/profiles/${selected.current.profileId}/avatar/${selected.current.avatar.appearanceId}/thumb-v1`;
          await f.pool.query(
            `CREATE TABLE whaleu_profile.synthetic_avatar_http_deferred(value integer);CREATE FUNCTION whaleu_profile.synthetic_avatar_http_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(8079,8082);RETURN NEW;END $$;CREATE CONSTRAINT TRIGGER synthetic_avatar_http_wait AFTER INSERT ON whaleu_profile.synthetic_avatar_http_deferred DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.synthetic_avatar_http_wait()`,
          );
          const blocker = await f.pool.connect();
          await blocker.query('SELECT pg_advisory_lock(8079,8082)');
          const current = f.profile.repository.current.bind(
            f.profile.repository,
          );
          let inserted = false;
          f.profile.repository.current = async (account, tx) => {
            const value = await current(account, tx);
            if (account === actor.accountId && !inserted) {
              inserted = true;
              await tx.query(
                'INSERT INTO whaleu_profile.synthetic_avatar_http_deferred(value) VALUES(1)',
              );
            }
            return value;
          };
          try {
            const reading = request(http)
              .get(image)
              .then((value) => value);
            await f.waitForLock('SET CONSTRAINTS ALL IMMEDIATE');
            await f.pool.query(
              'UPDATE whaleu_profile.profiles SET nickname=nickname WHERE account_id=$1',
              [actor.accountId],
            );
            await blocker.query('SELECT pg_advisory_unlock(8079,8082)');
            const response = await reading;
            assert.equal(response.status, 503);
            assert.equal(Buffer.isBuffer(response.body), false);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_profile.synthetic_avatar_http_deferred',
                )
              ).rowCount,
              0,
            );
          } finally {
            f.profile.repository.current = current;
            await blocker.query('SELECT pg_advisory_unlock(8079,8082)');
            blocker.release();
            await f.pool.query(
              'DROP TABLE whaleu_profile.synthetic_avatar_http_deferred;DROP FUNCTION whaleu_profile.synthetic_avatar_http_wait()',
            );
          }
        },
      );
      await t.test(
        'raw absent insert, delete/reinsert and actor-key move invalidate exact per-actor owner facts',
        async () => {
          const actor = await f.actor(),
            next = await f.actor();
          const afterCapture = async (
            readActors: readonly string[],
            write: () => Promise<unknown>,
          ) => {
            let captured!: () => void, release!: () => void;
            const reached = new Promise<void>((resolve) => {
                captured = resolve;
              }),
              continueRead = new Promise<void>((resolve) => {
                release = resolve;
              });
            const reading = inTransaction(
              f.pool,
              async (tx) => {
                for (const account of readActors)
                  await requireAvatarCurrent(account, tx);
                captured();
                await continueRead;
                return 'stale';
              },
              { isolationLevel: 'read committed' },
            );
            const rejected = assert.rejects(
              reading,
              codeIs('MEDIA_UNAVAILABLE'),
            );
            await reached;
            try {
              await write();
            } finally {
              release();
            }
            await rejected;
          };
          await afterCapture([actor.accountId], () =>
            f.pool.query(
              'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1)',
              [actor.accountId],
            ),
          );
          const original = (
            await f.pool.query(
              'SELECT to_jsonb(p) value FROM whaleu_profile.profiles p WHERE account_id=$1',
              [actor.accountId],
            )
          ).rows[0]!.value;
          await afterCapture([actor.accountId], () =>
            inTransaction(
              f.pool,
              async (tx) => {
                await tx.query(
                  'DELETE FROM whaleu_profile.profiles WHERE account_id=$1',
                  [actor.accountId],
                );
                await tx.query(
                  'INSERT INTO whaleu_profile.profiles SELECT * FROM jsonb_populate_record(NULL::whaleu_profile.profiles,$1::jsonb)',
                  [JSON.stringify(original)],
                );
              },
              { isolationLevel: 'read committed' },
            ),
          );
          await afterCapture([actor.accountId, next.accountId], () =>
            f.pool.query(
              'UPDATE whaleu_profile.profiles SET account_id=$2 WHERE account_id=$1',
              [actor.accountId, next.accountId],
            ),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.profiles WHERE account_id=$1',
                [actor.accountId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.profiles WHERE account_id=$1',
                [next.accountId],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'writer-first owner conflict fails bounded NOWAIT while unrelated actors remain readable',
        async () => {
          const actor = await f.actor(),
            unrelated = await f.actor(),
            writer = await f.pool.connect();
          try {
            await writer.query('BEGIN');
            await writer.query(
              'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1)',
              [actor.accountId],
            );
            const started = performance.now();
            await assert.rejects(
              inTransaction(
                f.pool,
                (tx) => requireAvatarCurrent(actor.accountId, tx),
                { isolationLevel: 'read committed' },
              ),
              codeIs('MEDIA_UNAVAILABLE'),
            );
            assert.ok(
              performance.now() - started < 1000,
              'mandatory owner fence must not wait for a long writer transaction',
            );
            await inTransaction(
              f.pool,
              (tx) => requireAvatarCurrent(unrelated.accountId, tx),
              { isolationLevel: 'read committed' },
            );
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
      await t.test(
        'reader-first final shared actor fence lets the read commit before a raw writer',
        async () => {
          const actor = await f.actor();
          await f.pool.query(
            'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1)',
            [actor.accountId],
          );
          let captured!: () => void, release!: () => void;
          const fenced = new Promise<void>((resolve) => {
              captured = resolve;
            }),
            resume = new Promise<void>((resolve) => {
              release = resolve;
            });
          const reading = inTransaction(
            f.pool,
            async (tx) => {
              await requireAvatarCurrent(actor.accountId, tx);
              await checkTransactionDeadlines(tx);
              captured();
              await resume;
              return 'current';
            },
            { isolationLevel: 'read committed' },
          );
          await fenced;
          const writing = f.pool.query(
            "UPDATE whaleu_profile.profiles SET nickname='after_reader',revision=revision+1 WHERE account_id=$1",
            [actor.accountId],
          );
          try {
            await f.waitForLock('UPDATE whaleu_profile.profiles');
          } finally {
            release();
          }
          assert.equal(await reading, 'current');
          assert.equal((await writing).rowCount, 1);
        },
      );
      await t.test(
        'multiple raw writers cannot hide changes behind a multi-actor read proof',
        async () => {
          const actors: ProfileActor[] = [];
          for (let index = 0; index < 4; index++) actors.push(await f.actor());
          let captured!: () => void, release!: () => void;
          const ready = new Promise<void>((resolve) => {
              captured = resolve;
            }),
            resume = new Promise<void>((resolve) => {
              release = resolve;
            });
          const reading = inTransaction(
            f.pool,
            async (tx) => {
              for (const actor of [...actors].reverse())
                await requireAvatarCurrent(actor.accountId, tx);
              captured();
              await resume;
            },
            { isolationLevel: 'read committed' },
          );
          const rejected = assert.rejects(reading, codeIs('MEDIA_UNAVAILABLE'));
          await ready;
          try {
            await Promise.all(
              actors.map((actor) =>
                f.pool.query(
                  'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1)',
                  [actor.accountId],
                ),
              ),
            );
          } finally {
            release();
          }
          await rejected;
        },
      );
      await t.test(
        'raw owner writer during a real deferred constraint wait invalidates mandatory post-wait Profile proof',
        async () => {
          const actor = await f.actor(),
            auth = `Bearer ${actor.accessToken}`;
          profileOk(
            await request(http)
              .patch('/v1/me/profile')
              .set('Authorization', auth)
              .send({ expectedRevision: 0, nickname: 'before_proof' }),
          );
          await f.pool.query(
            `CREATE TABLE whaleu_profile.synthetic_avatar_deferred(value integer);CREATE FUNCTION whaleu_profile.synthetic_avatar_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(8079,8080);RETURN NEW;END $$;CREATE CONSTRAINT TRIGGER synthetic_avatar_wait AFTER INSERT ON whaleu_profile.synthetic_avatar_deferred DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_profile.synthetic_avatar_wait()`,
          );
          const blocker = await f.pool.connect();
          await blocker.query('SELECT pg_advisory_lock(8079,8080)');
          try {
            const read = inTransaction(
              f.pool,
              async (tx) => {
                await requireAvatarCurrent(actor.accountId, tx);
                await tx.query(
                  'INSERT INTO whaleu_profile.synthetic_avatar_deferred(value) VALUES(1)',
                );
                return 'must not escape';
              },
              { isolationLevel: 'read committed' },
            );
            const outcome = assert.rejects(read, codeIs('MEDIA_UNAVAILABLE'));
            await f.waitForLock('SET CONSTRAINTS ALL IMMEDIATE');
            await f.pool.query(
              "UPDATE whaleu_profile.profiles SET nickname='raw_changed',revision=revision+1 WHERE account_id=$1",
              [actor.accountId],
            );
            await blocker.query('SELECT pg_advisory_unlock(8079,8080)');
            await outcome;
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_profile.synthetic_avatar_deferred',
                )
              ).rowCount,
              0,
              'tentative result and deferred insert roll back',
            );
          } finally {
            await blocker.query('SELECT pg_advisory_unlock(8079,8080)');
            blocker.release();
            await f.pool.query(
              'DROP TABLE whaleu_profile.synthetic_avatar_deferred;DROP FUNCTION whaleu_profile.synthetic_avatar_wait()',
            );
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
