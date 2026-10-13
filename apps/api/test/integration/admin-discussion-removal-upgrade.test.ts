/** Historical source is created under the real 0030 prefix, before the comment
 * component exists. Upgrading never forges enrollment, sources or Review. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { CommunitySubscriptionEnrollment } from '../../src/community/subscription-component/enrollment.js';
import { CommunityLikeEnrollment } from '../../src/community/like-component/enrollment.js';
import { CommunityViewEnrollment } from '../../src/community/view-component/enrollment.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import type { EffectiveContentEnvelopeV1 } from '../../src/community/content-review/contracts.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

test(
  'real 0030 source-backed historical roots and replies remain removable without fabricated 0031 baseline or contribution history',
  { timeout: 180000 },
  async (t) => {
    const f = await directoryRuntimeFixture(30);
    t.after(() => f.close());
    const owner = await f.actor(),
      author = await f.actor(),
      admin = await f.actor();
    await seedReviewPolicy(f.pool);
    const grant = randomUUID();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic:historical-discussion-removal')",
        [grant, admin.accountId, f.scope.home.regionId],
      ),
    );
    const oldPost = randomUUID();
    const create = async (
      kind: 'post' | 'comment' | 'reply',
      id: string,
      postId: string | null,
      rootId: string | null,
    ) => {
      const actor = kind === 'post' ? owner : author,
        requestId = randomUUID();
      const envelope: EffectiveContentEnvelopeV1 = {
        version: 1,
        accountId: actor.accountId,
        purpose:
          kind === 'post'
            ? 'publish_post'
            : kind === 'comment'
              ? 'publish_comment'
              : 'publish_reply',
        spaceId: f.scope.home.spaceId,
        category: 'discussion',
        authorMode: 'anonymous',
        commentsPolicy: 'open',
        postId,
        rootCommentId: rootId,
        targetReplyId: null,
        text: `Historical ${kind}`,
        images: [],
        component: { kind: 'none' },
        trading: null,
        scope: {
          originalSpaceId: f.scope.home.spaceId,
          originalRegionId: f.scope.home.regionId,
          authorOriginRegionId: f.scope.home.regionId,
          identityRegionId: f.scope.home.regionId,
          topologySnapshotId: f.scope.topologySnapshotId,
          sync: 'none',
        },
      };
      const approval = await approveEnvelope(f.pool, envelope);
      await withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          'INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation,receipt) VALUES($1,$2,$3,$4,$5)',
          [
            actor.accountId,
            requestId,
            'a'.repeat(64),
            envelope.purpose,
            {
              requestId,
              operation: envelope.purpose,
              outcome: 'created',
              resourceId: id,
              createdAt: new Date().toISOString(),
            },
          ],
        );
        if (kind === 'post')
          await tx.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion',$4,'anonymous','open')",
            [id, f.scope.home.spaceId, actor.accountId, envelope.text],
          );
        else if (kind === 'comment')
          await tx.query(
            "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,'anonymous')",
            [id, postId, actor.accountId, envelope.text],
          );
        else
          await tx.query(
            "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,$5,'anonymous')",
            [id, postId, rootId, actor.accountId, envelope.text],
          );
        await f.app
          .get(CommunityRepository)
          .persona(postId ?? id, actor.accountId, tx);
        await tx.query(
          "INSERT INTO whaleu_community.report_origins(kind,target_id,owner_account_id,source_request_id,provenance) VALUES($1,$2,$3,$4,'native_publication')",
          [kind, id, actor.accountId, requestId],
        );
        if (kind === 'post') {
          const canonical = {
            postId: id,
            ownerId: actor.accountId,
            publicationRequestId: requestId,
          };
          for (const owner of [
            new CommunitySubscriptionEnrollment(),
            new CommunityLikeEnrollment(),
            new CommunityViewEnrollment(),
          ])
            await owner.enrollPublishedPost(canonical, tx);
        }
        await tx.query(
          `INSERT INTO whaleu_community.content_approval_bindings(content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES($1,$2,1,$3,$4,$5,1,$6,$7,$8)`,
          [
            kind,
            id,
            approval.decisionId,
            actor.accountId,
            envelope.purpose,
            approval.digest,
            approval.envelope,
            approval.envelope.scope,
          ],
        );
      });
    };
    await create('post', oldPost, null, null);
    const root = randomUUID(),
      reply = randomUUID(),
      sibling = randomUUID();
    await create('comment', root, oldPost, null);
    await create('reply', reply, oldPost, root);
    await create('comment', sibling, oldPost, null);
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    );
    await runMigrations(f.pool, migrations, { mode: 'up' });
    const auth = `Bearer ${admin.accessToken}`;
    for (const [collection, id] of [
      ['comments', root],
      ['replies', reply],
      ['comments', sibling],
    ]) {
      profileOk(
        await request(f.app.getHttpServer())
          .get(`/v1/community/${collection}/${id}`)
          .set('Authorization', auth),
      );
    }
    for (const target of [
      { kind: 'reply', id: reply },
      { kind: 'comment', id: root },
    ]) {
      const management = await request(f.app.getHttpServer())
        .get('/v1/community/admin-discussion-removal/management')
        .set('Authorization', auth)
        .query(target);
      profileOk(management);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_post_hotness.comment_baselines WHERE post_id=$1',
            [oldPost],
          )
        ).rowCount,
        0,
      );
      const response = await request(f.app.getHttpServer())
        .post('/v1/community/admin-discussion-removal/commands')
        .set('Authorization', auth)
        .send({
          clientRequestId: randomUUID(),
          target,
          expectedTargetVersion: management.body.targetVersion,
          action: 'remove_discussion',
        });
      profileOk(response);
      assert.equal(response.body.outcome, 'applied');
    }
    for (const table of [
      'comment_baselines',
      'comment_sources',
      'comment_states',
      'comment_receipts',
    ])
      assert.equal(
        (
          await f.pool.query(
            `SELECT 1 FROM whaleu_post_hotness.${table} WHERE post_id=$1`,
            [oldPost],
          )
        ).rowCount,
        0,
        table,
      );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_community.admin_discussion_removal_components',
        )
      ).rowCount,
      0,
    );
    profileOk(
      await request(f.app.getHttpServer())
        .get(`/v1/community/comments/${sibling}`)
        .set('Authorization', auth),
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'INSERT INTO whaleu_post_hotness.comment_baselines(post_id,owner_id,source_request_id) SELECT post_id,$2,gen_random_uuid() FROM whaleu_community.root_comments WHERE id=$1',
          [sibling, owner.accountId],
        ),
      ),
      /fresh exact native publication/,
    );
  },
);
