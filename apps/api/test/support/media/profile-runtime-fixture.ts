/** Explicit disposable Profile test DI. This fixture does not activate any
 * production provider, catalogue asset pack, device adapter or Review issuer. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool, PoolClient, QueryResult } from 'pg';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from './runtime-fixture.js';
import {
  PROFILE_AVATAR_RUNTIME,
  ProfileAvatarService,
} from '../../../src/profile/avatar/service.js';
import { ProfileAvatarCatalog } from '../../../src/profile/avatar/catalog.js';
import { avatarAppearanceId } from '../../../src/profile/avatar/repository.js';
import {
  avatarCommandSchema,
  avatarReviewDigest,
} from '../../../src/profile/avatar/contracts.js';
import type {
  AvatarCommand,
  AvatarReviewEnvelope,
  AvatarSelectedSource,
} from '../../../src/profile/avatar/contracts.js';
import {
  profileMediaStatusSchema,
  profileMediaGrantSchema,
  profileMediaUploadObservedSchema,
} from '../../../src/media/contracts-profile.js';
import {
  MEDIA_POLICY_VERSION,
  MEDIA_TRANSFORM_VERSION,
} from '../../../src/media/contracts.js';
import { sealManifest } from '../../../src/media/manifest.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
import { seedReviewPolicy } from '../community-approval-fixtures.js';
import type { ApprovalFixtureOptions } from '../community-approval-fixtures.js';
import { withCommunityScopeWriter } from '../community-scope-fixtures.js';

export const SYNTHETIC_AVATAR_CATALOG = 'synthetic-profile-catalog-v1';
export async function syntheticProfileRuntimeFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
) {
  const base = await syntheticMediaRuntimeFixture(fixtures, {
    configureTestModule(builder, { storage, ingressStorage }) {
      builder.overrideProvider(PROFILE_AVATAR_RUNTIME).useValue({
        planning: ingressStorage,
        storage,
        ingressStorage,
        catalog: new ProfileAvatarCatalog(SYNTHETIC_AVATAR_CATALOG),
      });
    },
  });
  try {
    await seedReviewPolicy(base.pool);
    return { ...base, profile: base.app.get(ProfileAvatarService) };
  } catch (error) {
    await base.close();
    throw error;
  }
}
export type ProfileFixture = Awaited<
  ReturnType<typeof syntheticProfileRuntimeFixture>
>;
export type ProfileActor = Awaited<ReturnType<ProfileFixture['actor']>>;
export function profileOk(
  response: { status: number; body: unknown },
  status = 200,
): void {
  assert.equal(response.status, status, JSON.stringify(response.body));
}
export async function seedSyntheticAvatarCatalog(
  f: ProfileFixture,
  bytes: Buffer,
  mime: 'image/png' | 'image/jpeg',
  width: number,
  height: number,
  itemId = 'sample',
) {
  assert.ok(
    width <= 400 && height <= 400,
    'Synthetic catalog bytes must already satisfy both fixed variant dimensions',
  );
  const original = await f.storage.upload(bytes),
    thumb = await f.storage.upload(bytes),
    display = await f.storage.upload(bytes);
  const image = (value: typeof original) => ({ ...value, mime, width, height });
  const sealed = sealManifest({
    version: 1,
    policyVersion: MEDIA_POLICY_VERSION,
    transformVersion: MEDIA_TRANSFORM_VERSION,
    original: image(original),
    variants: [
      { ...image(thumb), name: 'thumb-v1' },
      { ...image(display), name: 'display-v1' },
    ],
  });
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      `INSERT INTO whaleu_profile.avatar_catalog_items(catalog_version,item_id,label,content_hash,manifest,available) VALUES($1,$2,'Synthetic test avatar',$3,$4::jsonb,true)`,
      [
        SYNTHETIC_AVATAR_CATALOG,
        itemId,
        sealed.digest,
        JSON.stringify(sealed.manifest),
      ],
    ),
  );
  return {
    catalogVersion: SYNTHETIC_AVATAR_CATALOG,
    itemId,
    contentHash: sealed.digest,
    manifest: sealed.manifest,
  };
}
export async function profileCommandEnvelope(
  f: ProfileFixture,
  actor: ProfileActor,
  raw: unknown,
): Promise<AvatarReviewEnvelope> {
  const command = avatarCommandSchema.parse(raw);
  const previous = (
    await f.pool.query<{ appearance_id: string }>(
      'SELECT appearance_id FROM whaleu_profile.avatar_current WHERE actor_id=$1',
      [actor.accountId],
    )
  ).rows[0];
  let source: AvatarSelectedSource;
  if (command.source.kind === 'clear') source = { kind: 'clear' };
  else if (command.source.kind === 'catalog') {
    const row = (
      await f.pool.query<{ content_hash: string }>(
        'SELECT content_hash FROM whaleu_profile.avatar_catalog_items WHERE catalog_version=$1 AND item_id=$2',
        [command.source.catalogVersion, command.source.itemId],
      )
    ).rows[0];
    assert.ok(row);
    source = { ...command.source, contentHash: row.content_hash };
  } else {
    const row = (
      await f.pool.query<{ manifest_digest: string }>(
        'SELECT manifest_digest FROM whaleu_media.assets WHERE id=$1 AND actor_id=$2',
        [command.source.assetId, actor.accountId],
      )
    ).rows[0];
    assert.ok(row);
    source = { ...command.source, manifestDigest: row.manifest_digest };
  }
  return {
    version: 1,
    purpose: 'select_profile_avatar',
    accountId: actor.accountId,
    clientRequestId: command.clientRequestId,
    expectedRevision: command.expectedRevision,
    appearanceId: avatarAppearanceId(actor.accountId, command.clientRequestId),
    previousAppearanceId: previous?.appearance_id ?? null,
    slot: 'avatar',
    source,
  };
}
export async function approveProfileAvatar(
  pool: Pool,
  envelope: AvatarReviewEnvelope,
  options: ApprovalFixtureOptions = {},
) {
  const digest = avatarReviewDigest(envelope);
  return withCommunityScopeWriter(pool, async (tx) => {
    const policy =
      options.policyRevisionId ??
      (
        await tx.query<{ id: string }>(
          `SELECT id FROM whaleu_community.content_approval_policies WHERE coverage='complete' AND provenance='accepted' ORDER BY valid_from DESC,id DESC LIMIT 1`,
        )
      ).rows[0]?.id;
    assert.ok(policy);
    const id = randomUUID(),
      event = randomUUID(),
      evaluated = options.evaluatedAt ?? new Date(Date.now() - 1000),
      visible = options.visibilityUntil ?? null;
    await tx.query(
      `INSERT INTO whaleu_community.profile_avatar_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until) VALUES($1,$2,'select_profile_avatar',1,$3,$4::jsonb,$5,$6,$7,$8,'synthetic-profile-review','synthetic-profile-exact-envelope',$9,$10,$11,$12)`,
      [
        id,
        envelope.accountId,
        digest,
        JSON.stringify(envelope),
        policy,
        options.result ?? 'allow',
        options.coverage ?? 'complete',
        options.provenance ?? 'accepted',
        evaluated,
        options.consumeUntil ?? new Date(Date.now() + 3600000),
        visible === null ? 'durable' : 'until',
        visible,
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_community.profile_avatar_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,$3,'complete','accepted','synthetic-profile-review','synthetic-profile-initial-state',$4)`,
      [event, id, options.state ?? 'allow', evaluated],
    );
    await tx.query(
      'INSERT INTO whaleu_community.profile_avatar_approval_heads(decision_id,event_id) VALUES($1,$2)',
      [id, event],
    );
    return { decisionId: id, digest, envelope };
  });
}
export async function setProfileAvatarReview(
  pool: Pool,
  decisionId: string,
  state: 'allow' | 'held' | 'revoked',
) {
  await withCommunityScopeWriter(pool, async (tx) => {
    const event = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.profile_avatar_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,$3,'complete','accepted','synthetic-profile-review','synthetic-profile-current-state',clock_timestamp())`,
      [event, decisionId, state],
    );
    assert.equal(
      (
        await tx.query(
          'UPDATE whaleu_community.profile_avatar_approval_heads SET event_id=$1 WHERE decision_id=$2',
          [event, decisionId],
        )
      ).rowCount,
      1,
    );
  });
}
export async function currentProfileAvatar(
  f: ProfileFixture,
  actor: ProfileActor,
) {
  const result = await request(f.app.getHttpServer())
    .get('/v1/me/profile/avatar')
    .set('Authorization', `Bearer ${actor.accessToken}`);
  profileOk(result);
  return result.body as {
    profileId: string | null;
    revision: number;
    avatar: {
      state: string;
      appearanceId?: string;
      source?: { kind: string; bindingId?: string };
    };
  };
}
export async function readyProfileAvatar(
  f: ProfileFixture,
  actor: ProfileActor,
  bytes: Buffer,
  mime: 'image/png' | 'image/jpeg' = 'image/png',
  worker: Pick<ProfileFixture['worker'], 'runOne'> = f.worker,
) {
  const current = await currentProfileAvatar(f, actor),
    http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`;
  const input = {
    protocol: 'profile-media-v1' as const,
    clientRequestId: randomUUID(),
    expectedRevision: current.revision,
    slot: 'avatar' as const,
    declaration: { mime, bytes: bytes.length, sha256: sha256(bytes) },
  };
  const prepared = await request(http)
    .post('/v1/me/profile/avatar-edits')
    .set('Authorization', auth)
    .send(input);
  profileOk(prepared);
  const status = profileMediaStatusSchema.parse(prepared.body);
  const grantResult = await request(http)
    .post(`/v1/me/profile/avatar-edits/${status.editId}/grant`)
    .set('Authorization', auth)
    .send({});
  profileOk(grantResult);
  const grant = profileMediaGrantSchema.parse(grantResult.body);
  const uploaded = await request(http)
    .post(
      `/v1/me/profile/avatar-edits/${status.editId}/uploads/${grant.grantId}`,
    )
    .set('Authorization', auth)
    .attach('file', bytes, { filename: 'ignored-avatar', contentType: mime });
  profileOk(uploaded);
  const observed = profileMediaUploadObservedSchema.parse(uploaded.body);
  assert.equal(observed.sha256, input.declaration.sha256);
  assert.equal(observed.bytes, bytes.length);
  profileOk(
    await request(http)
      .post(`/v1/me/profile/avatar-edits/${status.editId}/finalize`)
      .set('Authorization', auth)
      .send({}),
  );
  for (const stage of ['seal', 'process', 'review'] as const)
    assert.equal(await worker.runOne(stage), true);
  const result = await request(http)
    .get(`/v1/me/profile/avatar-edits/${status.editId}`)
    .set('Authorization', auth);
  profileOk(result);
  const ready = profileMediaStatusSchema.parse(result.body);
  assert.equal(ready.status, 'ready_unbound');
  if (ready.status !== 'ready_unbound')
    throw new Error('Profile media did not reach exact ready state');
  return { input, status: ready };
}
export async function selectProfileAvatar(
  f: ProfileFixture,
  actor: ProfileActor,
  command: AvatarCommand,
) {
  const approved = await approveProfileAvatar(
    f.pool,
    await profileCommandEnvelope(f, actor, command),
  );
  const response = await request(f.app.getHttpServer())
    .post('/v1/me/profile/avatar-commands')
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(command);
  profileOk(response);
  return {
    approved,
    receipt: response.body,
    current: await currentProfileAvatar(f, actor),
  };
}

/** Initial INSERT timestamp fixture only. It supplies a historical immutable
 * retention snapshot while leaving the actual bytes/worker/Review and every
 * trigger intact. No persisted timestamp is rewritten, no clock is mocked. */
export function profileAssetRetentionBoundaryPool(
  pool: Pool,
  windowMs = 15000,
): Pool {
  assert.ok(
    Number.isSafeInteger(windowMs) && windowMs > 0 && windowMs <= 60000,
  );
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'connect')
        return Reflect.get(target, property, receiver);
      return async () => {
        const tx = await target.connect(),
          original = tx.query,
          release = tx.release;
        const query = original.bind(tx) as (
          sql: string,
          values?: unknown[],
        ) => Promise<QueryResult>;
        tx.query = (async (sql: string, values?: unknown[]) => {
          if (!sql.includes('INSERT INTO whaleu_media.assets('))
            return query(sql, values);
          assert.ok(sql.includes('manifest_digest,manifest)'));
          assert.ok(sql.includes('$5::jsonb FROM'));
          assert.ok(values);
          assert.equal(values.length, 5);
          const rewritten = sql
            .replace(
              'manifest_digest,manifest)',
              'manifest_digest,manifest,created_at)',
            )
            .replace(
              '$5::jsonb FROM',
              "$5::jsonb,statement_timestamp()-interval '24 hours'+$6::double precision*interval '1 millisecond' FROM",
            );
          return query(rewritten, [...values, windowMs]);
        }) as PoolClient['query'];
        tx.release = (error?: Error | boolean) => {
          tx.query = original;
          tx.release = release;
          release.call(tx, error);
        };
        return tx;
      };
    },
  });
}

/** Observe a real persisted deadline with short PG reads and Node waits. Never
 * hold one pg_sleep across the database's fixed statement budget or edit clocks. */
export async function waitForProfileDeadline(
  pool: Pool,
  deadline: Date | number,
): Promise<void> {
  const until = typeof deadline === 'number' ? new Date(deadline) : deadline;
  assert.ok(Number.isFinite(until.getTime()));
  for (;;) {
    const remaining = (
      await pool.query<{ milliseconds: number }>(
        'SELECT (extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::double precision AS milliseconds',
        [until],
      )
    ).rows[0]!.milliseconds;
    assert.ok(Number.isFinite(remaining));
    // PG timestamps may contain a sub-millisecond fraction discarded by pg's
    // Date decoder; a real five-millisecond margin passes that exact cutoff.
    if (remaining < -5) return;
    await sleep(Math.max(1, Math.min(1000, remaining + 10)));
  }
}
