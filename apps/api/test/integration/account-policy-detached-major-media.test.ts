import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { MajorDiscussionMediaOwner } from '../../src/majors/discussion/media-owner.js';
import {
  MAJOR_DISCUSSION_V2,
  type MajorRootPublishV2,
} from '../../src/majors/discussion/contracts-v2.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import {
  accountPolicyAction,
  currentAccountPolicyAction,
} from '../../src/safety/account-policy/context.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import type { MajorDiscussionReference } from '../../src/media/contracts-major-discussion.js';
import {
  majorDiscussionMediaFixture,
  readyMajorDiscussionImage,
  reviewMajorDiscussionV2,
  majorMediaOk as ok,
} from '../support/major-discussion-media-fixture.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

test(
  'detached actual Major media owner permits mute and rejects suspension without ambient HTTP policy',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 20, height: 12, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const f = await majorDiscussionMediaFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const author = await f.actor(),
      viewer = await f.actor(),
      admin = await f.actor();
    const http = f.app.getHttpServer();
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',NULL,$2,'synthetic:detached-major-read')`,
        [randomUUID(), admin.accountId],
      );
    });
    await seedReviewPolicy(f.pool);
    const sourcePost = async () => {
      const body = publishPostSchema.parse({
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: 'discussion',
        text: 'Synthetic detached read sanction cause',
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
      });
      await approveEnvelope(
        f.pool,
        await postApprovalEnvelope(f.app, f.pool, viewer.accountId, body),
      );
      const response = await request(http)
        .post('/v1/community/posts')
        .set('Authorization', `Bearer ${viewer.accessToken}`)
        .send(body);
      ok(response, 201);
      assert.equal(response.body.outcome, 'created');
      return { kind: 'post' as const, id: response.body.resourceId as string };
    };
    const muteSource = await sourcePost(),
      suspensionSource = await sourcePost();
    const major = f.add(),
      catalog = await f.accept([major]);
    await f.acceptDiscussion([major.id]);
    const command: MajorRootPublishV2 = {
      protocol: MAJOR_DISCUSSION_V2,
      clientRequestId: randomUUID(),
      expectedCatalogRevision: catalog,
      expectedMajorRevision: major.revision,
      body: 'Real detached owner image',
      images: [],
    };
    const ready = await readyMajorDiscussionImage(
      f,
      author,
      {
        publicationRequestId: command.clientRequestId,
        majorId: major.id,
        catalogRevision: catalog,
        majorRevision: major.revision,
        rootId: null,
        replyToReplyId: null,
        ordinal: 0,
      },
      bytes,
    );
    command.images = [ready.fact];
    await reviewMajorDiscussionV2(f.pool, author.accountId, major.id, command);
    const published = await request(http)
      .post(`/v2/majors/${major.id}/discussion`)
      .set('Authorization', `Bearer ${author.accessToken}`)
      .send(command);
    ok(published);
    assert.ok(published.body.commentId);
    const page = await request(http)
      .get(`/v2/majors/${major.id}/discussion`)
      .set('Authorization', `Bearer ${viewer.accessToken}`);
    ok(page);
    const item = page.body.items.find(
      (row: { id: string }) => row.id === published.body.commentId,
    );
    assert.equal(item.images.length, 1);
    const image = item.images[0] as MajorDiscussionReference;
    const reference: MajorDiscussionReference = {
      majorId: image.majorId,
      commentId: image.commentId,
      bindingId: image.bindingId,
      ordinal: image.ordinal,
    };
    const owner = f.app.get(MajorDiscussionMediaOwner),
      database = f.app.get(DatabaseService);
    const direct = () => {
      assert.equal(
        accountPolicyAction.getStore(),
        undefined,
        'No route or open-method policy may leak into the direct invocation',
      );
      assert.equal(currentAccountPolicyAction('interaction'), 'interaction');
      return database.transaction(
        (tx) => owner.authorizeRead(viewer.accessToken, reference, tx),
        { isolationLevel: 'read committed' },
      );
    };
    const clear = await direct();
    assert.equal(clear.accountId, viewer.accountId);
    assert.equal(clear.actorAccountId, author.accountId);
    const issue = async (
      target: typeof muteSource,
      kind: 'interaction_mute' | 'access_suspension',
    ) => {
      const management = await request(http)
        .get('/v1/community/admin-post-removal/management')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .query({ ...target, version: '2' });
      ok(management);
      const result = await request(http)
        .post('/v1/community/admin-post-removal/commands')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          clientRequestId: randomUUID(),
          version: 2,
          target,
          expectedTargetVersion: management.body.targetVersion,
          action: 'remove_post',
          punishment: {
            kind,
            duration: { kind: 'finite', unit: 'hours', value: 2 },
            reason: 'Synthetic detached Major media reader',
            expectedRevision: '0',
          },
        });
      ok(result);
      assert.equal(result.body.outcome, 'applied', JSON.stringify(result.body));
    };
    await issue(muteSource, 'interaction_mute');
    const muted = await direct();
    assert.equal(muted.accountId, clear.accountId);
    assert.deepEqual(muted.images, clear.images);
    await issue(suspensionSource, 'access_suspension');
    await assert.rejects(
      direct(),
      (error: unknown) =>
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'SAFETY_ACCESS_SUSPENDED',
    );
    assert.equal(
      accountPolicyAction.getStore(),
      undefined,
      'Terminal owner boundary is restored after success and rejection',
    );
  },
);
