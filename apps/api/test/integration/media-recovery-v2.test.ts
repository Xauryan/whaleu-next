import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
import { MEDIA_UPLOAD_APPLICATION_V2 } from '../../src/media/application-v2.js';
import type { MediaUploadApplicationV2 } from '../../src/media/application-v2.js';
import { mediaRequestHash } from '../../src/media/contracts-v2.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { DatabaseService } from '../../src/database/database.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { CommunityMediaOwner } from '../../src/community/media/owner.js';
import { MediaPrepareScopes } from '../../src/media/prepare-scope.js';
import { MediaIngressRepository } from '../../src/media/ingress-repository.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';

const rejectedWith = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
/** Backend protocol tests complement the real HTTP/parser suite. Direct admit
 * calls here intentionally exercise CAS and transaction boundaries, not HTTP. */
test(
  'original actor recovery and durable writer fencing retain uncertainty',
  { timeout: 180000 },
  async (t) => {
    const bytes = Buffer.from('backend protocol fixture bytes');
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    try {
      const media = f.app.get<MediaUploadApplicationV2>(
        MEDIA_UPLOAD_APPLICATION_V2,
      );
      const input = () => ({
        clientRequestId: randomUUID(),
        purpose: 'community-post-image',
        draftId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        slot: 'images',
        ordinal: 0,
        declaration: {
          mime: 'image/png',
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      });
      await t.test(
        'prepare response loss recovers one key and hash conflict never replaces bytes',
        async () => {
          const actor = await f.actor(),
            value = input();
          const [a, b] = await Promise.all([
            media.prepareV2(actor.accessToken, value),
            media.prepareV2(actor.accessToken, value),
          ]);
          assert.equal(a.intentId, b.intentId);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.quota_reservations WHERE intent_id=$1',
                [a.intentId],
              )
            ).rowCount,
            1,
          );
          await assert.rejects(
            media.prepareV2(actor.accessToken, {
              ...value,
              declaration: { ...value.declaration, sha256: 'f'.repeat(64) },
            }),
            rejectedWith('MEDIA_REQUEST_CONFLICT'),
          );
          await f.certify(actor.accountId, {
            affiliation: 'unavailable',
            identity: false,
          });
          assert.equal(
            (
              await media.recoverRequest(
                actor.accessToken,
                value.clientRequestId,
              )
            ).state,
            'active',
          );
          assert.equal(
            (await media.prepareV2(actor.accessToken, value)).intentId,
            a.intentId,
          );
          await assert.rejects(media.grant(actor.accessToken, a.intentId));
          assert.equal(
            (
              await media.cancelRequest(
                actor.accessToken,
                value.clientRequestId,
                { requestHash: mediaRequestHash(actor.accountId, value) },
              )
            ).state,
            'terminal',
          );
          const other = await f.actor();
          assert.equal(
            (
              await media.recoverRequest(
                other.accessToken,
                value.clientRequestId,
              )
            ).state,
            'not_recorded',
          );
        },
      );
      await t.test(
        'new session revokes a claimed writer; refresh preserves the session',
        async () => {
          const actor = await f.actor(),
            value = input();
          const prepared = await media.prepareV2(actor.accessToken, value);
          const grant = await media.grant(actor.accessToken, prepared.intentId);
          const refreshed = await f.app
            .get(IdentityService)
            .refresh(actor.refreshToken);
          assert.equal(refreshed.sessionId, actor.sessionId);
          assert.equal(
            (await media.grant(refreshed.accessToken, prepared.intentId))
              .grantId,
            grant.grantId,
          );
          const claim = await media.admit(
            refreshed.accessToken,
            prepared.intentId,
            grant.grantId,
          );
          await assert.rejects(
            media.admit(
              refreshed.accessToken,
              prepared.intentId,
              grant.grantId,
            ),
            rejectedWith('MEDIA_UPLOAD_IN_FLIGHT'),
          );
          const provider = (
            await f.pool.query<{ app_id: string; subject: string }>(
              'SELECT app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
              [actor.accountId],
            )
          ).rows[0]!;
          const accessToken = mintToken('access'),
            refreshToken = mintToken('refresh');
          const newSession = await f.app.get(IdentityRepository).createSession(
            {
              provider: 'wechat',
              appId: provider.app_id,
              subject: provider.subject,
            },
            {
              access: hashToken(accessToken),
              refresh: hashToken(refreshToken),
            },
          );
          assert.notEqual(newSession.sessionId, claim.sessionId);
          await assert.rejects(
            media.grant(accessToken, prepared.intentId),
            rejectedWith('MEDIA_UPLOAD_IN_FLIGHT'),
          );
          assert.equal(
            (
              await f.pool.query<{ writer_state: string }>(
                'SELECT writer_state FROM whaleu_media.upload_ingress WHERE intent_id=$1',
                [prepared.intentId],
              )
            ).rows[0]!.writer_state,
            'retiring',
          );
          const measured = await f.ingressStorage.write(
            claim,
            Readable.from([bytes]),
            new AbortController().signal,
          );
          await assert.rejects(
            media.observe(refreshed.accessToken, claim, measured),
          );
          const proof = await f.ingressStorage.quiesce(claim);
          await f.ingressStorage.removeScratch(claim);
          await media.retire(claim, proof, bytes.length);
          const retry = await media.grant(accessToken, prepared.intentId);
          assert.notEqual(retry.grantId, grant.grantId);
          const retried = await media.admit(
            accessToken,
            prepared.intentId,
            retry.grantId,
          );
          assert.deepEqual(retried.staging, claim.staging);
          const nextMeasured = await f.ingressStorage.write(
            retried,
            Readable.from([bytes]),
            new AbortController().signal,
          );
          await media.observe(accessToken, retried, nextMeasured);
          await media.retire(
            retried,
            await f.ingressStorage.quiesce(retried),
            bytes.length,
          );
          assert.equal(
            (await media.statusV2(accessToken, prepared.intentId)).status,
            'uploaded',
          );
        },
      );
      await t.test(
        'cancel defeats late observe; absence without durable writer retirement remains retained',
        async () => {
          const actor = await f.actor(),
            value = input();
          const prepared = await media.prepareV2(actor.accessToken, value);
          const grant = await media.grant(actor.accessToken, prepared.intentId);
          const claim = await media.admit(
            actor.accessToken,
            prepared.intentId,
            grant.grantId,
          );
          const measurement = await f.ingressStorage.write(
            claim,
            Readable.from([bytes]),
            new AbortController().signal,
          );
          const cancel = await media.cancelV2(
            actor.accessToken,
            prepared.intentId,
          );
          assert.equal(cancel.status.status, 'terminal');
          if (cancel.status.status === 'terminal')
            assert.equal(cancel.status.cleanup, 'retained');
          await assert.rejects(
            media.observe(actor.accessToken, claim, measurement),
          );
          assert.equal(
            (await media.finalizeV2(actor.accessToken, prepared.intentId))
              .status,
            'terminal',
          );
          const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
          assert.equal(await cleanup.runOne(), 'retained');
          await media.retire(claim, undefined, bytes.length);
          assert.equal(
            (
              await f.pool.query<{ state: string }>(
                'SELECT state FROM whaleu_media.upload_ingress_writers WHERE writer_token=$1',
                [claim.writerToken],
              )
            ).rows[0]!.state,
            'unknown',
          );
          const next = await media.prepareV2(actor.accessToken, input());
          const nextGrant = await media.grant(actor.accessToken, next.intentId);
          await assert.rejects(
            media.admit(actor.accessToken, next.intentId, nextGrant.grantId),
            rejectedWith('MEDIA_UPLOAD_IN_FLIGHT'),
          );
          await media.retire(
            claim,
            await f.ingressStorage.quiesce(claim),
            bytes.length,
          );
          const terminal = await media.statusV2(
            actor.accessToken,
            prepared.intentId,
          );
          assert.equal(terminal.status, 'terminal');
          if (terminal.status === 'terminal')
            assert.notEqual(terminal.cleanup, 'confirmed');
        },
      );
      await t.test(
        'explicit server logout revokes the writer bearer and cannot be repaired by late bytes',
        async () => {
          const actor = await f.actor(),
            value = input();
          const prepared = await media.prepareV2(actor.accessToken, value);
          const grant = await media.grant(actor.accessToken, prepared.intentId);
          const claim = await media.admit(
            actor.accessToken,
            prepared.intentId,
            grant.grantId,
          );
          const measurement = await f.ingressStorage.write(
            claim,
            Readable.from([bytes]),
            new AbortController().signal,
          );
          await f.app.get(IdentityService).logout(actor.accessToken);
          await assert.rejects(
            media.observe(actor.accessToken, claim, measurement),
          );
          await assert.rejects(
            media.recoverRequest(actor.accessToken, value.clientRequestId),
          );
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_media.object_attempts WHERE intent_id=$1 AND state='observed'",
                [prepared.intentId],
              )
            ).rowCount,
            0,
          );
          // Cleanup is an internal exact-writer operation, not an expired bearer retry.
          await media.retire(
            claim,
            await f.ingressStorage.quiesce(claim),
            bytes.length,
          );
          assert.equal(
            (
              await f.pool.query<{ state: string }>(
                'SELECT state FROM whaleu_media.upload_ingress_writers WHERE writer_token=$1',
                [claim.writerToken],
              )
            ).rows[0]!.state,
            'retired',
          );
        },
      );
      await t.test(
        'grant lifetime is enforced and current Identity deadline rolls admission back at commit',
        async () => {
          const actor = await f.actor(),
            value = input();
          const prepared = await media.prepareV2(actor.accessToken, value);
          const grant = await media.grant(actor.accessToken, prepared.intentId);
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_media.upload_ingress SET grant_expires_at=clock_timestamp()-interval '1 second' WHERE intent_id=$1",
              [prepared.intentId],
            ),
          );
          await assert.rejects(
            media.admit(actor.accessToken, prepared.intentId, grant.grantId),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.object_attempts a ON a.id=w.object_attempt_id WHERE a.intent_id=$1',
                [prepared.intentId],
              )
            ).rowCount,
            0,
          );
          const second = await media.prepareV2(actor.accessToken, input());
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1",
              [hashToken(actor.accessToken)],
            ),
          );
          const access = f.app.get(CommunityAccessService);
          const scopes = new MediaPrepareScopes(
            new CommunityMediaOwner(access, f.app.get(CommunityRepository)),
          );
          const ingress = new MediaIngressRepository(f.ingressStorage);
          let grantedBeforeDeadline = false;
          await assert.rejects(
            f.app.get(DatabaseService).transaction(
              async (tx) => {
                await lockSafetyPolicy(tx, true);
                const session = await access.mediaSession(
                  actor.accessToken,
                  tx,
                );
                await ingress.grant(
                  session,
                  second.intentId,
                  await scopes.authorizeV2(
                    session.accountId,
                    await ingress.originalInput(
                      session.accountId,
                      second.intentId,
                      tx,
                    ),
                    tx,
                  ),
                  scopes,
                  tx,
                );
                grantedBeforeDeadline = true;
                await sleep(1100);
              },
              { isolationLevel: 'read committed' },
            ),
            rejectedWith('ACCESS_TOKEN_EXPIRED'),
          );
          assert.equal(grantedBeforeDeadline, true);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.object_attempts WHERE intent_id=$1',
                [second.intentId],
              )
            ).rowCount,
            0,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
