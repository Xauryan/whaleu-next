import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CommunityDmEntryFacade } from '../src/community/dm-entry.facade.js';
import type { DmResolvedEntry } from '../src/community/dm-entry.facade.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type {
  CommunityRepository,
  StoredPost,
  StoredComment,
  StoredReply,
} from '../src/community/community.repository.js';
import type { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import type { PublicProfileFacade } from '../src/profile/public-profile.facade.js';
import type { ProfileVisibilityFacade } from '../src/safety/profile-visibility.facade.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'DM_ENTRY_UNAVAILABLE';
function fixture() {
  const post: StoredPost = {
    id: id(3),
    account_id: id(2),
    space_id: id(9),
    category: 'discussion',
    text: 'Synthetic post',
    author_mode: 'anonymous',
    comments_policy: 'open',
    visibility: 'approved',
    deleted_at: null,
    published_at: new Date(),
    publication_envelope_version: 1,
    allow_anonymous_dm: null,
  };
  const root: StoredComment = {
    id: id(4),
    account_id: id(2),
    post_id: post.id,
    text: 'Synthetic root',
    author_mode: 'anonymous',
    visibility: 'approved',
    deleted_at: null,
    created_at: new Date(),
  };
  const reply: StoredReply = {
    ...root,
    id: id(5),
    root_comment_id: root.id,
    target_reply_id: null,
    sequence: '2',
  };
  const target: StoredReply = { ...reply, id: id(6), sequence: '1' };
  const state = {
    epoch: '0',
    accessError: null as ApplicationError | null,
    profileAvailable: true,
    targetVisible: true,
    reviewVersion: 1 as 1 | 2,
    reviewOptIn: false,
  };
  const profileReads: string[] = [],
    personas: { post: string; account: string }[] = [],
    subjects: string[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 118,
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('discovery_count_epochs'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: state.epoch,
          })),
        };
      if (sql.includes('pg_try_advisory_xact_lock_shared'))
        return { rows: Array.from({ length: 128 }, () => ({ locked: true })) };
      if (sql.includes('pg_try_advisory_xact_lock('))
        return { rows: [{ locked: true }] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      if (sql.includes('FROM whaleu_community.thread_personas'))
        return {
          rows: [
            {
              id: values[1] === id(1) ? id(11) : id(12),
              display_name: values[1] === id(1) ? '匿名蓝鲸' : '匿名白鲸',
            },
          ],
        };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const access = {
    accessiblePost: async () => {
      if (state.accessError) throw state.accessError;
      return { post };
    },
    accessibleComment: async () => ({ post, comment: root }),
    accessibleReply: async () => ({ post, comment: root, reply }),
    visible: async () => state.targetVisible,
  } as unknown as CommunityAccessService;
  const records = {
    persona: async (p: string, a: string) => {
      personas.push({ post: p, account: a });
    },
    reply: async () => target,
  } as unknown as CommunityRepository;
  const approvals = {
    binding: async (kind: string, contentId: string) => {
      subjects.push(`${kind}:${contentId}`);
      const content =
        contentId === post.id
          ? post
          : contentId === root.id
            ? root
            : contentId === reply.id
              ? reply
              : target;
      return {
        content_kind: kind,
        content_id: contentId,
        content_version: 1,
        account_id: content.account_id,
        decision_id: id(8),
        digest: 'a'.repeat(64),
        envelope_version: kind === 'post' ? state.reviewVersion : 1,
        envelope: {
          version: kind === 'post' ? state.reviewVersion : 1,
          purpose:
            kind === 'post'
              ? 'publish_post'
              : kind === 'comment'
                ? 'publish_comment'
                : 'publish_reply',
          authorMode: content.author_mode,
          allowAnonymousDm: state.reviewOptIn,
        },
      };
    },
    current: async (b: { envelope: unknown }) => ({
      kind: 'allow',
      value: { envelope: b.envelope },
    }),
  } as unknown as ApprovalRepository;
  const profiles = {
    ownReference: async (account: string) => {
      profileReads.push(account);
      return account === id(1) ? id(21) : id(22);
    },
    dmFind: async (profile: string) => ({
      accountId: profile === id(21) ? id(1) : id(2),
      profileId: profile,
      displayName: 'Named display',
    }),
    find: async (profile: string) => ({
      accountId: profile === id(21) ? id(1) : id(2),
      profileId: profile,
      displayName: 'Named display',
    }),
  } as unknown as PublicProfileFacade;
  const visibility = {
    read: async () => ({
      status: state.profileAvailable ? 'available' : 'unavailable',
    }),
  } as unknown as ProfileVisibilityFacade;
  const identity = {
    dmActiveAccount: async () => true,
  } as unknown as IdentityService;
  return {
    facade: new CommunityDmEntryFacade(
      access,
      records,
      approvals,
      profiles,
      visibility,
      identity,
    ),
    tx,
    state,
    post,
    root,
    reply,
    target,
    personas,
    profileReads,
    subjects,
  };
}
test('DM anonymous entry resolves exact same-post personas without reading hidden profiles', async () => {
  const f = fixture();
  const entry = await f.facade.resolve(
    id(1),
    {
      kind: 'reply',
      postId: f.post.id,
      rootCommentId: f.root.id,
      replyId: f.reply.id,
    },
    'anonymous',
    f.tx,
  );
  assert.equal(entry.peerAccountId, id(2));
  assert.equal(entry.actorMode, 'anonymous');
  assert.equal(entry.peerMode, 'anonymous');
  assert.deepEqual(f.personas, []);
  assert.deepEqual(f.profileReads, []);
  const ready = await f.facade.materialize(entry, f.tx);
  assert.deepEqual(f.personas, [
    { post: f.post.id, account: id(1) },
    { post: f.post.id, account: id(2) },
  ]);
  assert.equal(ready.actorDisplay.displayName, '匿名蓝鲸');
  assert.equal(ready.peerDisplay.displayName, '匿名白鲸');
  assert.equal(ready.actorDisplay.profileId, null);
  assert.equal(ready.peerDisplay.profileId, null);
  assert.deepEqual(f.profileReads, []);
  assert.ok(Object.isFrozen(ready.provenance));
  await checkTransactionDeadlines(f.tx);
});
test('DM reply rejects substituted post/root and mismatching referenced target ancestry', async () => {
  for (const altered of [
    { postId: id(99), rootCommentId: id(4) },
    { postId: id(3), rootCommentId: id(99) },
  ]) {
    const f = fixture();
    await assert.rejects(
      () =>
        f.facade.resolve(
          id(1),
          { kind: 'reply', replyId: f.reply.id, ...altered },
          'anonymous',
          f.tx,
        ),
      unavailable,
    );
    assert.deepEqual(f.personas, []);
  }
  const f = fixture();
  f.reply.target_reply_id = f.target.id;
  f.target.root_comment_id = id(99);
  await assert.rejects(
    () =>
      f.facade.resolve(
        id(1),
        {
          kind: 'reply',
          postId: f.post.id,
          rootCommentId: f.root.id,
          replyId: f.reply.id,
        },
        'anonymous',
        f.tx,
      ),
    unavailable,
  );
});
test('DM exact referenced reply receives its own current Review provenance', async () => {
  const f = fixture();
  f.reply.target_reply_id = f.target.id;
  const result = await f.facade.resolve(
    id(1),
    {
      kind: 'reply',
      postId: f.post.id,
      rootCommentId: f.root.id,
      replyId: f.reply.id,
    },
    'anonymous',
    f.tx,
  );
  assert.ok(f.subjects.includes(`reply:${f.target.id}`));
  assert.equal(result.provenance['targetReplyId'], f.target.id);
});
test('DM never silently converts named initiation into hidden anonymous peer context', async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.facade.resolve(
        id(1),
        { kind: 'post', postId: f.post.id },
        'named',
        f.tx,
      ),
    unavailable,
  );
  assert.deepEqual(f.profileReads, []);
  assert.deepEqual(f.personas, []);
});
test('DM mixed initiation requires exact named-post reviewed v2 opt-in, never comment inheritance', async () => {
  const f = fixture();
  f.post.author_mode = 'named';
  f.post.publication_envelope_version = 2;
  f.post.allow_anonymous_dm = true;
  f.state.reviewVersion = 2;
  f.state.reviewOptIn = true;
  const result = await f.facade.resolve(
    id(1),
    { kind: 'post', postId: f.post.id },
    'anonymous',
    f.tx,
  );
  assert.equal(result.actorMode, 'anonymous');
  assert.equal(result.peerMode, 'named');
  assert.deepEqual(f.profileReads, [id(2)]);
  for (const kind of ['legacy', 'false', 'binding'] as const) {
    const bad = fixture();
    bad.post.author_mode = 'named';
    bad.post.publication_envelope_version = kind === 'legacy' ? 1 : 2;
    bad.post.allow_anonymous_dm = kind === 'false' ? false : true;
    bad.state.reviewVersion = kind === 'binding' ? 1 : 2;
    bad.state.reviewOptIn = true;
    await assert.rejects(
      () =>
        bad.facade.resolve(
          id(1),
          { kind: 'post', postId: bad.post.id },
          'anonymous',
          bad.tx,
        ),
      unavailable,
    );
  }
  f.root.author_mode = 'named';
  await assert.rejects(
    () =>
      f.facade.resolve(
        id(1),
        { kind: 'comment', postId: f.post.id, commentId: f.root.id },
        'anonymous',
        f.tx,
      ),
    unavailable,
  );
});
test('DM profile entry is named-only and uses current public-profile visibility', async () => {
  const f = fixture();
  const result = await f.facade.resolve(
    id(1),
    { kind: 'profile', profileId: id(22) },
    'named',
    f.tx,
  );
  assert.equal(result.sourceScopeKey, 'profile-direct');
  assert.equal(result.sourcePostId, null);
  assert.equal(result.peerDisplay.profileId, id(22));
  await assert.rejects(
    () =>
      f.facade.resolve(
        id(1),
        { kind: 'profile', profileId: id(22) },
        'anonymous',
        f.tx,
      ),
    unavailable,
  );
  f.state.profileAvailable = false;
  await assert.rejects(
    () =>
      f.facade.resolve(
        id(1),
        { kind: 'profile', profileId: id(22) },
        'named',
        f.tx,
      ),
    unavailable,
  );
});
test('DM materialization rejects copied handles, other transactions, and restored read epochs', async () => {
  const f = fixture(),
    entry = await f.facade.resolve(
      id(1),
      { kind: 'post', postId: f.post.id },
      'anonymous',
      f.tx,
    );
  await assert.rejects(() =>
    f.facade.materialize({ ...entry } as DmResolvedEntry, f.tx),
  );
  await assert.rejects(() => f.facade.materialize(entry, fixture().tx));
  const checkpoint = checkpointTransactionDeadlines(f.tx);
  restoreTransactionDeadlines(f.tx, checkpoint);
  await assert.rejects(() => f.facade.materialize(entry, f.tx));
  assert.deepEqual(f.personas, []);
});
test('DM current source unavailable differs from authoritative absence and final changes fail closed', async () => {
  const f = fixture();
  f.state.accessError = new ApplicationError('POST_NOT_FOUND');
  assert.equal(await f.facade.sourceAvailable(id(1), f.post.id, f.tx), false);
  f.state.accessError = new ApplicationError('COMMUNITY_UNAVAILABLE');
  await assert.rejects(() => f.facade.sourceAvailable(id(1), f.post.id, f.tx));
  const changed = fixture();
  await changed.facade.resolve(
    id(1),
    { kind: 'post', postId: changed.post.id },
    'anonymous',
    changed.tx,
  );
  changed.state.epoch = '1';
  await assert.rejects(() => checkTransactionDeadlines(changed.tx));
});
