import { extendLiveFixture } from '../live-fixture.js';
/** Explicit disposable Profile test DI. This fixture does not activate any
 * production provider, catalogue asset pack, device adapter or Review issuer. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from './runtime-fixture.js';
import {
  PROFILE_COVER_RUNTIME,
  ProfileCoverService,
} from '../../../src/profile/cover/service.js';
import { coverAppearanceId } from '../../../src/profile/cover/repository.js';
import {
  coverCommandSchema,
  coverReviewDigest,
} from '../../../src/profile/cover/contracts.js';
import type {
  CoverCommand,
  CoverReviewEnvelope,
  CoverSelectedSource,
} from '../../../src/profile/cover/contracts.js';
import {
  profileCoverMediaStatusSchema,
  profileCoverMediaGrantSchema,
  profileCoverMediaUploadObservedSchema,
} from '../../../src/media/contracts-profile-cover.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
import { seedReviewPolicy } from '../community-approval-fixtures.js';
import type { ApprovalFixtureOptions } from '../community-approval-fixtures.js';
import { withCommunityScopeWriter } from '../community-scope-fixtures.js';

export async function syntheticProfileCoverRuntimeFixture(
  fixtures: readonly {
    sha256: string;
    verdict: 'allow' | 'held' | 'revoked';
  }[],
  maximumMigration?: number,
) {
  const base = await syntheticMediaRuntimeFixture(fixtures, {
    ...(maximumMigration === undefined ? {} : { maximumMigration }),
    configureTestModule(builder, { storage, ingressStorage }) {
      builder.overrideProvider(PROFILE_COVER_RUNTIME).useValue({
        planning: ingressStorage,
        storage,
        ingressStorage,
      });
    },
  });
  try {
    await seedReviewPolicy(base.pool);
    return extendLiveFixture(base, {
      get profile() {
        return base.app.get(ProfileCoverService);
      },
    });
  } catch (error) {
    await base.close();
    throw error;
  }
}
export type ProfileCoverFixture = Awaited<
  ReturnType<typeof syntheticProfileCoverRuntimeFixture>
>;
export type ProfileCoverActor = Awaited<
  ReturnType<ProfileCoverFixture['actor']>
>;
export function profileCoverOk(
  response: { status: number; body: unknown },
  status = 200,
): void {
  assert.equal(response.status, status, JSON.stringify(response.body));
}
export async function profileCoverCommandEnvelope(
  f: ProfileCoverFixture,
  actor: ProfileCoverActor,
  raw: unknown,
): Promise<CoverReviewEnvelope> {
  const command = coverCommandSchema.parse(raw);
  const previous = (
    await f.pool.query<{ appearance_id: string }>(
      'SELECT appearance_id FROM whaleu_profile.cover_current WHERE actor_id=$1',
      [actor.accountId],
    )
  ).rows[0];
  let source: CoverSelectedSource;
  if (command.source.kind === 'clear') source = { kind: 'clear' };
  else {
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
    purpose: 'select_profile_cover',
    accountId: actor.accountId,
    clientRequestId: command.clientRequestId,
    expectedRevision: command.expectedRevision,
    appearanceId: coverAppearanceId(actor.accountId, command.clientRequestId),
    previousAppearanceId: previous?.appearance_id ?? null,
    slot: 'cover',
    source,
  };
}
export async function approveProfileCover(
  pool: Pool,
  envelope: CoverReviewEnvelope,
  options: ApprovalFixtureOptions = {},
) {
  const digest = coverReviewDigest(envelope);
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
      `INSERT INTO whaleu_community.profile_cover_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until) VALUES($1,$2,'select_profile_cover',1,$3,$4::jsonb,$5,$6,$7,$8,'synthetic-profile-review','synthetic-profile-exact-envelope',$9,$10,$11,$12)`,
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
      `INSERT INTO whaleu_community.profile_cover_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,$3,'complete','accepted','synthetic-profile-review','synthetic-profile-initial-state',$4)`,
      [event, id, options.state ?? 'allow', evaluated],
    );
    await tx.query(
      'INSERT INTO whaleu_community.profile_cover_approval_heads(decision_id,event_id) VALUES($1,$2)',
      [id, event],
    );
    return { decisionId: id, digest, envelope };
  });
}
export async function setProfileCoverReview(
  pool: Pool,
  decisionId: string,
  state: 'allow' | 'held' | 'revoked',
) {
  await withCommunityScopeWriter(pool, async (tx) => {
    const event = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.profile_cover_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,$3,'complete','accepted','synthetic-profile-review','synthetic-profile-current-state',clock_timestamp())`,
      [event, decisionId, state],
    );
    assert.equal(
      (
        await tx.query(
          'UPDATE whaleu_community.profile_cover_approval_heads SET event_id=$1 WHERE decision_id=$2',
          [event, decisionId],
        )
      ).rowCount,
      1,
    );
  });
}
export async function currentProfileCover(
  f: ProfileCoverFixture,
  actor: ProfileCoverActor,
) {
  const result = await request(f.app.getHttpServer())
    .get('/v1/me/profile/cover')
    .set('Authorization', `Bearer ${actor.accessToken}`);
  profileCoverOk(result);
  return result.body as {
    profileId: string | null;
    revision: number;
    cover: {
      state: string;
      appearanceId?: string;
      source?: { kind: string; bindingId?: string };
    };
  };
}
export async function readyProfileCover(
  f: ProfileCoverFixture,
  actor: ProfileCoverActor,
  bytes: Buffer,
  mime: 'image/png' | 'image/jpeg' = 'image/png',
  worker: Pick<ProfileCoverFixture['worker'], 'runOne'> = f.worker,
) {
  const current = await currentProfileCover(f, actor),
    http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`;
  const input = {
    protocol: 'profile-cover-v1' as const,
    clientRequestId: randomUUID(),
    expectedRevision: current.revision,
    slot: 'cover' as const,
    declaration: { mime, bytes: bytes.length, sha256: sha256(bytes) },
  };
  const prepared = await request(http)
    .post('/v1/me/profile/cover-edits')
    .set('Authorization', auth)
    .send(input);
  profileCoverOk(prepared);
  const status = profileCoverMediaStatusSchema.parse(prepared.body);
  const grantResult = await request(http)
    .post(`/v1/me/profile/cover-edits/${status.editId}/grant`)
    .set('Authorization', auth)
    .send({});
  profileCoverOk(grantResult);
  const grant = profileCoverMediaGrantSchema.parse(grantResult.body);
  const uploaded = await request(http)
    .post(
      `/v1/me/profile/cover-edits/${status.editId}/uploads/${grant.grantId}`,
    )
    .set('Authorization', auth)
    .attach('file', bytes, { filename: 'ignored-cover', contentType: mime });
  profileCoverOk(uploaded);
  const observed = profileCoverMediaUploadObservedSchema.parse(uploaded.body);
  assert.equal(observed.sha256, input.declaration.sha256);
  assert.equal(observed.bytes, bytes.length);
  profileCoverOk(
    await request(http)
      .post(`/v1/me/profile/cover-edits/${status.editId}/finalize`)
      .set('Authorization', auth)
      .send({}),
  );
  for (const stage of ['seal', 'process', 'review'] as const)
    assert.equal(await worker.runOne(stage), true);
  const result = await request(http)
    .get(`/v1/me/profile/cover-edits/${status.editId}`)
    .set('Authorization', auth);
  profileCoverOk(result);
  const ready = profileCoverMediaStatusSchema.parse(result.body);
  assert.equal(ready.status, 'ready_unbound');
  if (ready.status !== 'ready_unbound')
    throw new Error('Profile media did not reach exact ready state');
  return { input, status: ready };
}
export async function selectProfileCover(
  f: ProfileCoverFixture,
  actor: ProfileCoverActor,
  command: CoverCommand,
) {
  const approved = await approveProfileCover(
    f.pool,
    await profileCoverCommandEnvelope(f, actor, command),
  );
  const response = await request(f.app.getHttpServer())
    .post('/v1/me/profile/cover-commands')
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(command);
  profileCoverOk(response);
  return {
    approved,
    receipt: response.body,
    current: await currentProfileCover(f, actor),
  };
}
