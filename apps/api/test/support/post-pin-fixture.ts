import { effectiveContentEnvelopeSchema } from '../../src/community/content-review/contracts.js';
/** Only disposable synthetic owner facts. Ordinary AppModule and real Review. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { directoryRuntimeFixture } from './directory-runtime-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
  type ApprovalFixtureOptions,
} from './community-approval-fixtures.js';
import { postApprovalEnvelope } from './community-runtime-fixtures.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import type { Category } from '../../src/community/contracts.js';
export async function postPinFixture() {
  const f = await directoryRuntimeFixture();
  await seedReviewPolicy(f.pool);
  const bind = async (
    spaceId: string,
    kind: 'regional' | 'university_city' | 'feedback',
    regionId: string | null,
    coverage = 'accepted_empty',
    until = new Date(Date.now() + 3600000),
  ) =>
    withCommunityScopeWriter(f.pool, async (tx) => {
      const id = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_community.post_pin_scopes(id,space_id,kind,operating_region_id,source_reference,provenance,accepted_at,valid_until) VALUES($1,$2,$3,$4,'synthetic:explicit-pin-topic-region','accepted',clock_timestamp()-interval '1 minute',$5)`,
        [id, spaceId, kind, regionId, until],
      );
      await tx.query(
        `INSERT INTO whaleu_community.post_pin_history(scope_id,coverage,source_reference,accepted_at,valid_until) VALUES($1,$2,'synthetic:independent-empty-pin-history',clock_timestamp()-interval '1 minute',$3)`,
        [id, coverage, until],
      );
      return id;
    });
  const grant = async (
    actor: string,
    role: 'school_admin' | 'super_admin' | 'developer',
    region: string | null = null,
    until: Date | null = null,
  ) =>
    withCommunityScopeWriter(f.pool, async (tx) => {
      const id = randomUUID();
      await tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,$3,$4,$2,'synthetic:pin-only',$5)",
        [id, actor, role, region, until],
      );
      return id;
    });
  const publish = async (
    actor: Awaited<ReturnType<typeof f.actor>>,
    spaceId = f.scope.home.spaceId,
    category: Category = 'discussion',
    options: ApprovalFixtureOptions = {},
  ) => {
    const input = publishPostSchema.parse({
      clientRequestId: randomUUID(),
      spaceId,
      category,
      text: 'Synthetic pin ' + randomUUID(),
      authorMode: 'named',
      imageAssetIds: [],
      commentsPolicy: 'open',
      ...(category === 'feedback'
        ? { feedback: { contacts: { wechat: '', qq: '', phone: '' } } }
        : {}),
      ...(category === 'trading'
        ? {
            trading: {
              subtype: 'shuma',
              price: '12.50',
              urgency: 'urgent',
              location: 'Synthetic pickup',
              contacts: { wechat: 'synthetic-contact', qq: '', phone: '' },
            },
          }
        : {}),
    });
    const base = await postApprovalEnvelope(
      f.app,
      f.pool,
      actor.accountId,
      input,
    );
    const envelope = effectiveContentEnvelopeSchema.parse(
      input.feedback
        ? {
            ...base,
            version: 3,
            category: 'feedback',
            purpose: 'publish_post',
            commentsPolicy: 'open',
            feedback: input.feedback,
          }
        : base,
    );
    const approval = await approveEnvelope(f.pool, envelope, options);
    const response = await request(f.app.getHttpServer())
      .post('/v1/community/posts')
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(input);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'created',
      JSON.stringify(response.body),
    );
    return { id: response.body.resourceId as string, approval, input };
  };
  return { ...f, bind, grant, publish };
}
