import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { directoryRuntimeFixture } from './directory-runtime-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { approveErrand } from './errand-review-fixtures.js';
import { ErrandAccessService } from '../../src/errands/access.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { publishErrandSchema } from '../../src/errands/contracts.js';
import type { PublishErrand } from '../../src/errands/contracts.js';
import type { ErrandContentEnvelope } from '../../src/community/content-review/errand-contracts.js';
export async function seedErrandFeature(
  pool: Pool,
  accountId: string,
  restrictions: unknown[] = [],
  options: { coverage?: string; validUntil?: Date } = {},
) {
  return withCommunityScopeWriter(pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_safety.errand_feature_snapshots(id,account_id,coverage,provenance,source_reference,policy_reference,effective_at,valid_until,restrictions) VALUES($1,$2,$3,'accepted','synthetic-errand-feature','synthetic-feature-policy',clock_timestamp(),$4,$5)`,
      [
        id,
        accountId,
        options.coverage ?? 'complete',
        options.validUntil ?? null,
        JSON.stringify(restrictions),
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_safety.errand_feature_heads(account_id,snapshot_id) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id',
      [accountId, id],
    );
    return id;
  });
}
export function syntheticErrandRestriction(
  action: 'publish' | 'accept' | 'all',
  options: { endsAt?: Date; releasedAt?: Date } = {},
) {
  return {
    id: randomUUID(),
    action,
    reason: 'Synthetic fixture restriction',
    startsAt: new Date(Date.now() - 10000).toISOString(),
    endsAt: options.endsAt?.toISOString() ?? null,
    releasedAt: options.releasedAt?.toISOString() ?? null,
    provenance: 'accepted',
    issuer: 'synthetic-owner',
    sourceReference: 'synthetic-source',
    policyReference: 'synthetic-policy',
  };
}
export async function seedTemporaryErrandBase(
  pool: Pool,
  accountId: string,
  options: {
    state?: 'verified' | 'unverified' | 'revoked';
    validUntil?: Date;
    coverage?: string;
  } = {},
) {
  return withCommunityScopeWriter(pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_verification.errand_base_assertions(id,account_id,state,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until) VALUES($1,$2,$3,$4,'accepted','synthetic-owner','synthetic-source','synthetic-policy',clock_timestamp(),$5)`,
      [
        id,
        accountId,
        options.state ?? 'verified',
        options.coverage ?? 'complete',
        options.validUntil ?? new Date(Date.now() + 3600000),
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_verification.errand_base_heads(account_id,assertion_id) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET assertion_id=EXCLUDED.assertion_id',
      [accountId, id],
    );
    return id;
  });
}
export async function errandRuntimeFixture() {
  const f = await directoryRuntimeFixture(),
    http = f.app.getHttpServer();
  const actor = async (options: Parameters<typeof f.actor>[0] = {}) => {
    const a = await f.actor(options);
    await seedErrandFeature(f.pool, a.accountId);
    return a;
  };
  type Actor = Awaited<ReturnType<typeof actor>>;
  const auth = (r: request.Test, a: Actor) =>
    r.set('Authorization', `Bearer ${a.accessToken}`);
  const body = (
    regionId = f.scope.home.regionId,
    patch: Partial<PublishErrand> = {},
  ): PublishErrand =>
    publishErrandSchema.parse({
      clientRequestId: randomUUID(),
      targetRegionId: regionId,
      title: 'Synthetic ' + randomUUID().slice(0, 8),
      publicText: 'Collect a synthetic parcel',
      privateText: 'Synthetic private pickup instructions',
      expectedTimeText: 'Tomorrow after lunch',
      reward: '12.34567890123456789',
      publisherContacts: { wechat: 'fixture_publisher', phone: '12345678901' },
      publicAssetIds: [],
      privateAssetIds: [],
      ...patch,
    });
  const envelope = async (
    a: Actor,
    input: PublishErrand,
  ): Promise<ErrandContentEnvelope> =>
    inTransaction(f.pool, async (tx) => {
      await lockSafetyPolicy(tx);
      const scope = await f.app
        .get(ErrandAccessService)
        .scope(a.accountId, input.targetRegionId, tx);
      return {
        version: 1,
        accountId: a.accountId,
        purpose: 'publish_errand',
        title: input.title,
        publicText: input.publicText,
        privateText: input.privateText,
        expectedTimeText: input.expectedTimeText,
        reward: input.reward,
        publisherContacts: input.publisherContacts,
        publicAssetIds: [],
        privateAssetIds: [],
        scope,
      };
    });
  const publish = async (a: Actor, input = body()) => {
    const approval = await approveErrand(f.pool, await envelope(a, input));
    const response = await auth(request(http).post('/v1/errands'), a).send(
      input,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'applied',
      JSON.stringify(response.body),
    );
    return {
      id: response.body.orderId as string,
      revision: response.body.revision as string,
      receipt: response.body,
      body: input,
      approval,
    };
  };
  const command = (
    a: Actor,
    id: string,
    revision: string,
    op: 'accept' | 'cancel' | 'complete' | 'delete',
    extra: Record<string, unknown> = {},
  ) =>
    auth(request(http).post(`/v1/errands/${id}/${op}`), a).send({
      clientRequestId: randomUUID(),
      expectedRevision: revision,
      ...(op === 'accept'
        ? { contacts: { wechat: 'fixture_runner', phone: '' } }
        : {}),
      ...extra,
    });
  const detail = (a: Actor, id: string) =>
    auth(request(http).get(`/v1/errands/${id}`), a);
  const list = (a: Actor, query: Record<string, unknown> = {}) =>
    auth(
      request(http)
        .get('/v1/errands')
        .query({ regionId: f.scope.home.regionId, ...query }),
      a,
    );
  const own = (
    a: Actor,
    relation = 'published',
    query: Record<string, unknown> = {},
  ) =>
    auth(
      request(http)
        .get('/v1/me/errands')
        .query({ relation, ...query }),
      a,
    );
  return {
    ...f,
    actor,
    auth,
    http,
    body,
    envelope,
    publish,
    command,
    detail,
    list,
    own,
  };
}
