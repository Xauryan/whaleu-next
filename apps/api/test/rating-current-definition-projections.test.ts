import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { RatingDiscussionProjection } from '../src/ratings/discussion-projection.js';
import { RatingUpdatesProjectionFacade } from '../src/ratings/updates-source/projection.js';
import { RatingSubscriptionUpdatesProjectionFacade } from '../src/ratings/updates-source/subscription-projection.js';
import { RatingUpdatesReadService } from '../src/notifications/ratings/read.service.js';
import { RatingLikeUpdatesReadService } from '../src/notifications/ratings/like-read.service.js';
import { RatingSubscriptionUpdatesReadService } from '../src/notifications/ratings/subscription-read.service.js';
import { RatingLikeSubjectFacade } from '../src/ratings/likes/subject.facade.js';
import { RatingSubscriptionTargetFacade } from '../src/ratings/subscriptions/target.facade.js';
import { currentRatingTargetRow } from '../src/ratings/target-definition.repository.js';
import type { CommentRow } from '../src/ratings/repository.js';
import type { ReplyRow } from '../src/ratings/discussion-repository.js';
import { ApplicationError } from '../src/http/application-error.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const instant = '2026-10-09T10:00:00.000000Z';

function fixture() {
  const shared = {
    accountId: id(2),
    clientRequestId: id(3),
    targetId: id(1),
    targetRevision: id(4),
    categoryId: id(5),
    categoryRevision: id(6),
    catalogRevision: id(7),
    scope: { regionId: null },
    assetIds: [],
  };
  const row = currentRatingTargetRow({
    id: id(1),
    revision: id(8),
    category_id: id(5),
    creator_id: id(2),
    region_id: null,
    active: true,
    name: 'Current edited title',
    description: '',
    envelope: {
      ...shared,
      version: 3,
      purpose: 'edit_rating_target',
      previousTargetRevision: id(9),
      previousDefinitionRevision: id(10),
      definitionRevision: id(11),
      contentVersion: 2,
      name: 'Current edited title',
      description: '',
    },
    content_version: 2,
    definition_revision: id(11),
    applied_target_revision: id(4),
    definition_target_id: id(1),
    lifecycle_target_revision: id(8),
    owner_deleted: false,
  });
  const root: CommentRow = {
    id: id(20),
    target_id: id(1),
    account_id: id(2),
    author_mode: 'anonymous',
    persona_id: id(21),
    persona_name: 'Historical persona',
    body: 'Historical root body',
    revision: id(22),
    ordinal: '1',
    created_at: instant,
    deleted_at: null,
    envelope: {
      ...shared,
      version: 1,
      purpose: 'publish_rating_comment',
      targetRevision: id(9),
      authorMode: 'anonymous',
      body: 'Historical root body',
    },
  };
  const reply: ReplyRow = {
    ...root,
    id: id(30),
    root_id: root.id,
    reply_to_id: null,
    body: 'Historical reply body',
    revision: id(31),
    envelope: {
      ...shared,
      version: 2,
      purpose: 'publish_rating_reply',
      targetRevision: id(9),
      rootId: root.id,
      rootRevision: root.revision,
      replyTo: null,
      authorMode: 'anonymous',
      body: 'Historical reply body',
    },
  };
  const state = { decision: 'allow', bodyReads: 0, definitionReads: 0 };
  type ProjectionDependencies = ConstructorParameters<
    typeof RatingDiscussionProjection
  >;
  const records = {
    enable: () => {},
    catalog: async () => ({ id: id(7), regionId: null }),
    target: async () => ({ row }),
    commentTarget: async () => row.id,
    comment: async () => {
      state.bodyReads++;
      return root;
    },
    retainComment: () => {},
    retainReply: () => {},
  } as unknown as ProjectionDependencies[0];
  const replies = {
    ancestry: async () => ({ root_id: root.id, target_id: row.id }),
    reply: async () => {
      state.bodyReads++;
      return reply;
    },
  } as unknown as ProjectionDependencies[1];
  const review = {
    currentTargetDefinition: async (definition: unknown) => {
      assert.equal(definition, row.definition);
      state.definitionReads++;
      return { kind: state.decision };
    },
    current: async (kind: string) => {
      assert.notEqual(kind, 'target');
      return { kind: 'allow' };
    },
  } as unknown as ProjectionDependencies[2];
  const safety = {
    named: async () => ({ kind: 'allow' }),
  } as unknown as ProjectionDependencies[3];
  const authors = {
    findRatingPublic: async () => ({
      profileId: id(40),
      displayName: 'Like actor',
    }),
  } as unknown as ProjectionDependencies[4];
  const projection = new RatingDiscussionProjection(
    records,
    replies,
    review,
    safety,
    authors,
  );
  type UpdatesDependencies = ConstructorParameters<
    typeof RatingUpdatesProjectionFacade
  >;
  const access = {
    resolveAccount: async () => {},
    resolve: async () => ({ session: { accountId: id(2) } }),
  } as unknown as UpdatesDependencies[0];
  const updates = new RatingUpdatesProjectionFacade(
    access,
    records,
    replies,
    projection,
    safety,
    authors,
  );
  const subscriptions = new RatingSubscriptionUpdatesProjectionFacade(
    access,
    records,
    replies,
    projection,
  );
  const likes = new RatingLikeSubjectFacade(
    access,
    records,
    replies,
    projection,
  );
  const subscriptionTarget = new RatingSubscriptionTargetFacade(
    access,
    records,
    projection,
  );
  const tx = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  const database = {
    transaction: async (fn: (read: PoolClient) => Promise<unknown>) => fn(tx),
  };
  const identity = {
    session: async () => ({ accountId: id(2), sessionId: id(41) }),
  };
  const storedBase = {
    id: id(50),
    event_id: id(51),
    recipient_account_id: id(2),
    region_id: null,
    target_id: row.id,
    root_id: root.id,
    reply_id: reply.id,
    ordinal: '1',
    created_at: instant,
    read_at: null,
  };
  const stored = [
    { ...storedBase, kind: 'reply', reason: 'direct_root' },
    {
      ...storedBase,
      kind: 'like',
      reason: 'like',
      like_actor_account_id: id(42),
      reply_id: null,
    },
    {
      ...storedBase,
      kind: 'subscription',
      reason: 'target_subscription',
      epoch_id: id(43),
      activity: 'reply',
    },
  ];
  const noticeRecords = (index: number) => ({
    page: async () => [stored[index]!],
    own: async () => stored[index]!,
    owner: async () => {},
    states: async () => new Map([[storedBase.id, storedBase.read_at]]),
    count: async () => 1,
  });
  type ReplyReadDependencies = ConstructorParameters<
    typeof RatingUpdatesReadService
  >;
  type LikeReadDependencies = ConstructorParameters<
    typeof RatingLikeUpdatesReadService
  >;
  type SubscriptionReadDependencies = ConstructorParameters<
    typeof RatingSubscriptionUpdatesReadService
  >;
  const readers = [
    new RatingUpdatesReadService(
      database as unknown as ReplyReadDependencies[0],
      identity as unknown as ReplyReadDependencies[1],
      noticeRecords(0) as unknown as ReplyReadDependencies[2],
      updates,
      {} as ReplyReadDependencies[4],
    ),
    new RatingLikeUpdatesReadService(
      database as unknown as LikeReadDependencies[0],
      identity as unknown as LikeReadDependencies[1],
      noticeRecords(1) as unknown as LikeReadDependencies[2],
      updates,
      {} as LikeReadDependencies[4],
    ),
    new RatingSubscriptionUpdatesReadService(
      database as unknown as SubscriptionReadDependencies[0],
      identity as unknown as SubscriptionReadDependencies[1],
      noticeRecords(2) as unknown as SubscriptionReadDependencies[2],
      subscriptions,
      {} as SubscriptionReadDependencies[4],
    ),
  ];
  return {
    row,
    root,
    reply,
    state,
    stored,
    readers,
    likes,
    subscriptionTarget,
    tx,
  };
}

test('already materialized reply, like and subscription notice reads/navigation requalify the current definition', async () => {
  const f = fixture();
  const snapshot = JSON.stringify({
    stored: f.stored,
    root: f.root,
    reply: f.reply,
  });
  for (const reader of f.readers) {
    const page = await reader.list('token', { limit: 20 });
    assert.equal(page.items[0]!.status, 'available');
    assert.equal((await reader.target('token', id(50))).status, 'available');
  }
  for (const decision of ['deny', 'unavailable']) {
    f.state.decision = decision;
    const bodyReads = f.state.bodyReads;
    for (const reader of f.readers) {
      const page = await reader.list('token', { limit: 20 });
      assert.deepEqual(page.items, [
        {
          noticeId: id(50),
          createdAt: instant,
          readAt: null,
          status: 'unavailable',
        },
      ]);
      assert.equal(page.unreadCount, 1);
      assert.deepEqual(await reader.target('token', id(50)), {
        noticeId: id(50),
        status: 'unavailable',
      });
    }
    assert.equal(f.state.bodyReads, bodyReads);
  }
  assert.equal(f.state.definitionReads, 18);
  assert.equal(
    JSON.stringify({ stored: f.stored, root: f.root, reply: f.reply }),
    snapshot,
  );
});

test('like and subscription subject reads/writes share the current-definition gate without changing historical memberships', async () => {
  const f = fixture();
  for (const write of [false, true]) {
    await f.likes.resolve('token', 'comment', f.root.id, null, f.tx, write);
    await f.subscriptionTarget.resolve('token', f.row.id, null, f.tx, write);
  }
  f.state.decision = 'deny';
  const bodyReads = f.state.bodyReads;
  for (const write of [false, true]) {
    await assert.rejects(
      f.likes.resolve('token', 'comment', f.root.id, null, f.tx, write),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === 'RATING_NOT_FOUND',
    );
    await assert.rejects(
      f.subscriptionTarget.resolve('token', f.row.id, null, f.tx, write),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === 'RATING_NOT_FOUND',
    );
  }
  assert.equal(f.state.bodyReads, bodyReads);
});
