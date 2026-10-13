/** Explicit disposable synthetic admission only. No runtime provisioning. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { inTransaction } from '../../src/database/database.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { directoryRuntimeFixture } from './directory-runtime-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { CommunityDistributionService } from '../../src/community/related-sync/service.js';
import { PublicationService } from '../../src/community/publication.service.js';
import { ReplyPublicationService } from '../../src/community/discussion/publication.service.js';
import { FeedService } from '../../src/community/feed.service.js';
import { SearchService } from '../../src/community/search/service.js';
import { SearchRepository } from '../../src/community/search/repository.js';
import { HotFeedService } from '../../src/community/hot/service.js';
import { HotRepository } from '../../src/community/hot/repository.js';
import { SchoolPostingPolicyService } from '../../src/school-posting-policy/service.js';
import { PostPinsService } from '../../src/community/post-pins/service.js';

/** Test-only structural inspection: optional compatibility ports may not silently
 * disappear from actual AppModule consumers. No production fallback is installed. */
export function assertRelatedSyncRuntimeWiring(app: INestApplication): void {
  const owner = app.get(CommunityDistributionService);
  assert.equal(
    Object.getPrototypeOf(owner),
    CommunityDistributionService.prototype,
  );
  const consumers = [
    ['PublicationService', app.get(PublicationService)],
    ['TextReviewRuntime', app.get(TextReviewRuntime)],
    ['FeedService', app.get(FeedService)],
    ['SearchService', app.get(SearchService)],
    ['SearchRepository', app.get(SearchRepository)],
    ['HotFeedService', app.get(HotFeedService)],
    ['HotRepository', app.get(HotRepository)],
    ['SchoolPostingPolicyService', app.get(SchoolPostingPolicyService)],
    ['PostPinsService', app.get(PostPinsService)],
  ] as const;
  for (const [name, consumer] of consumers) {
    const injected = Reflect.getOwnPropertyDescriptor(consumer, 'distribution');
    assert.ok(injected, `${name} must retain an injected distribution slot`);
    assert.equal(
      injected.value,
      owner,
      `${name} must use the AppModule owner singleton`,
    );
  }
  assert.equal(
    Reflect.get(app.get(ReplyPublicationService), 'approval'),
    app.get(PublicationService),
    'Reply publication must delegate inherited admission to the wired publication singleton',
  );
}

export async function acceptRelatedSyncPolicy(
  pool: Pool,
  regionId: string,
  options: {
    reviewPolicyId?: string;
    issuer?: string;
    categories?: string[];
    authorModes?: string[];
    componentKinds?: string[];
    imagesAllowed?: boolean;
    anonymousDmAllowed?: boolean;
    validUntil?: Date;
  } = {},
) {
  const id = randomUUID(),
    reviewPolicyId = options.reviewPolicyId ?? randomUUID();
  const issuer = options.issuer ?? 'synthetic:related-sync:acceptance';
  await withCommunityScopeWriter(pool, async (tx) => {
    if (!options.reviewPolicyId)
      await tx.query(
        `INSERT INTO whaleu_community.content_approval_policies
        (id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from)
        VALUES($1,'local-related-v1',1,'complete','accepted',$2,'Explicit disposable synthetic Review acceptance',clock_timestamp())`,
        [reviewPolicyId, issuer],
      );
    await tx.query(
      'INSERT INTO whaleu_community.related_sync_policy_heads(operating_region_id) VALUES($1) ON CONFLICT DO NOTHING',
      [regionId],
    );
    const head = (
      await tx.query<{ revision: number }>(
        'SELECT revision FROM whaleu_community.related_sync_policy_heads WHERE operating_region_id=$1 FOR UPDATE',
        [regionId],
      )
    ).rows[0]!;
    await tx.query(
      `INSERT INTO whaleu_community.related_sync_policies
      (id,policy_key,version,operating_region_id,categories,author_modes,component_kinds,images_allowed,anonymous_dm_allowed,review_policy_revision_id,coverage,provenance,issuer,provenance_ref,valid_from,valid_until)
      VALUES($1,'ordinary-related-v1',$2,$3,$4,$5,$6,$7,$8,$9,'complete','accepted',$10,'Explicit disposable synthetic applicability acceptance',clock_timestamp(),$11)`,
      [
        id,
        head.revision + 1,
        regionId,
        [...(options.categories ?? ['discussion'])].sort(),
        [...(options.authorModes ?? ['anonymous', 'named'])].sort(),
        [...(options.componentKinds ?? ['formation', 'none', 'poll'])].sort(),
        options.imagesAllowed ?? true,
        options.anonymousDmAllowed ?? true,
        reviewPolicyId,
        issuer,
        options.validUntil ?? null,
      ],
    );
    await tx.query(
      'UPDATE whaleu_community.related_sync_policy_heads SET revision=$2,policy_id=$3 WHERE operating_region_id=$1',
      [regionId, head.revision + 1, id],
    );
  });
  return { policyId: id, reviewPolicyId, issuer };
}

export async function relatedSyncRuntimeFixture(
  configOverrides: Partial<RuntimeConfig> = {},
) {
  let patch: Partial<RuntimeConfig> = { ...configOverrides };
  const f = await directoryRuntimeFixture(undefined, {
    createApp: async (config, configurePolicy) => {
      const builder = Test.createTestingModule({
        imports: [AppModule.register(Object.freeze({ ...config, ...patch }))],
      });
      await configurePolicy(builder);
      return (await builder.compile()).createNestApplication({ logger: false });
    },
  });
  try {
    const legacyReviewPolicyId = randomUUID(),
      relatedReviewPolicyId = randomUUID();
    const issuer = 'synthetic:related-sync:operator';
    patch = {
      ...configOverrides,
      COMMUNITY_TEXT_REVIEW: 'local_manual',
      COMMUNITY_TEXT_REVIEW_SPACE_ID: f.scope.home.spaceId,
      COMMUNITY_TEXT_REVIEW_REGION_ID: f.scope.home.regionId,
      COMMUNITY_TEXT_REVIEW_POLICY_ID: legacyReviewPolicyId,
      COMMUNITY_RELATED_REVIEW_POLICY_ID: relatedReviewPolicyId,
      COMMUNITY_TEXT_REVIEW_OPERATOR: issuer,
    };
    await f.restartApp();
    assertRelatedSyncRuntimeWiring(f.app);
    const operator = new TextReviewOperator(
      f.app.get(TextReviewRuntime),
      issuer,
    );
    await inTransaction(f.pool, async (tx) => {
      await operator.run(
        {
          command: 'init-policy',
          basis: 'Explicit disposable legacy Review acceptance',
        },
        tx,
      );
      await operator.run(
        {
          command: 'init-related-policy',
          basis: 'Explicit disposable related Review acceptance',
        },
        tx,
      );
    });
    const applicability = await acceptRelatedSyncPolicy(
      f.pool,
      f.scope.home.regionId,
      { reviewPolicyId: relatedReviewPolicyId, issuer },
    );
    const decide = async (
      accountId: string,
      requestId: string,
      decision: 'allow' | 'reject' = 'allow',
    ) => {
      const row = (
        await f.pool.query<{ digest: string }>(
          'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [accountId, requestId],
        )
      ).rows[0];
      if (!row) throw new Error('Expected exact queued Review snapshot');
      return inTransaction(f.pool, (tx) =>
        operator.run(
          {
            command: 'decide',
            accountId,
            requestId,
            digest: row.digest,
            decision,
            basis: 'Explicit synthetic exact-envelope test decision',
          },
          tx,
        ),
      );
    };
    return Object.assign(f, {
      operator,
      decide,
      applicability,
      relatedReviewPolicyId,
      legacyReviewPolicyId,
    });
  } catch (error) {
    await f.close();
    throw error;
  }
}
