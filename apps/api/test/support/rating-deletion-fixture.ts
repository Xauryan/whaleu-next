/** Synthetic disposable deletion authority. No production role/source ingress. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ratingDiscussionFixture } from './rating-discussion-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { ratingAdminDeletionContextSchema } from '../../src/ratings/deletion/contracts.js';
import type { RatingAdminDeletionContext } from '../../src/ratings/deletion/contracts.js';
export async function ratingDeletionFixture() {
  const f = await ratingDiscussionFixture();
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const grant = async (
    actor: Actor,
    role: 'super_admin' | 'developer' | 'school_admin',
    regionId: string | null = null,
    expiresAt: Date | null = null,
  ) => {
    const id = randomUUID();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,$3,$4,$2,'synthetic-rating-deletion-only',$5)",
        [id, actor.accountId, role, regionId, expiresAt],
      ),
    );
    return id;
  };
  const origin = async (
    targetId: string,
    state: 'known_school' | 'schoolless' | 'unknown',
    campusId: string | null = null,
    options: { effectiveAt?: Date; validUntil?: Date; revoked?: boolean } = {},
  ) =>
    withCommunityScopeWriter(f.pool, async (tx) => {
      const previous = (
        await tx.query<{ revision: number }>(
          'SELECT revision FROM whaleu_ratings.target_origin_heads WHERE target_id=$1',
          [targetId],
        )
      ).rows[0];
      const id = randomUUID(),
        revision = (previous?.revision ?? 0) + 1;
      await tx.query(
        "INSERT INTO whaleu_ratings.target_origin_sources(id,target_id,revision,state,origin_campus_id,revoked,coverage_state,provenance_state,source_reference,policy_reference,source_version,effective_at,expiry_kind,valid_until) VALUES($1,$2,$3,$4,$5,$6,'complete','accepted','synthetic-deletion-origin','synthetic-deletion-origin-policy',1,coalesce($7,clock_timestamp()),$8,$9)",
        [
          id,
          targetId,
          revision,
          state,
          campusId,
          options.revoked ?? false,
          options.effectiveAt ?? null,
          options.validUntil ? 'at' : 'policy_exempt',
          options.validUntil ?? null,
        ],
      );
      await tx.query(
        'INSERT INTO whaleu_ratings.target_origin_heads(target_id,source_id,revision) VALUES($1,$2,$3) ON CONFLICT(target_id) DO UPDATE SET source_id=EXCLUDED.source_id,revision=EXCLUDED.revision',
        [targetId, id, revision],
      );
      return { id, revision };
    });
  const path = (kind: 'comment' | 'reply', id: string) =>
    `/v1/ratings/admin/${kind === 'comment' ? 'comments' : 'replies'}/${id}`;
  const context = async (
    actor: Actor,
    kind: 'comment' | 'reply',
    id: string,
  ) => {
    const response = await f.auth(
      request(f.http).get(`${path(kind, id)}/deletion-context`),
      actor,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return ratingAdminDeletionContextSchema.parse(response.body);
  };
  const command = (context: RatingAdminDeletionContext) => ({
    clientRequestId: randomUUID(),
    targetId: context.targetId,
    expectedTargetRevision: context.targetRevision,
    expectedRevision: context.revision,
    expectedContextRevision: context.contextRevision,
    ...(context.subjectKind === 'reply'
      ? { rootId: context.rootId, expectedRootRevision: context.rootRevision }
      : {}),
  });
  const remove = (
    actor: Actor,
    kind: 'comment' | 'reply',
    id: string,
    input: Record<string, unknown>,
  ) => f.auth(request(f.http).delete(path(kind, id)), actor).send(input);
  return { ...f, grant, origin, path, context, command, remove };
}
