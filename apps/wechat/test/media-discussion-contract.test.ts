import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as v3 from '../src/media/batch-contracts';
import * as v4 from '../src/media/discussion-batch-contracts';
import { decodeUploadStatus } from '../src/media/upload-contracts';
import { batchPublicationReference } from '../src/media/batch-publication';
import {
  identity,
  ids,
  memberPrepare,
  readyBatch,
  attempt,
  uuid,
} from './support/media-discussion-fixtures';
const hash = (domain: string, value: unknown) =>
  createHash('sha256')
    .update(`${domain}\n${JSON.stringify(value)}`)
    .digest('hex');

test('v4 identity target/purpose and three-member boundary are strict; old v3 and v2 remain strict', () => {
  assert.equal(
    v4.batchRequestHash(ids.actor, identity),
    hash('whaleu-media-batch:v2', { actorAccountId: ids.actor, identity }),
  );
  const m = memberPrepare(2);
  assert.equal(
    v4.memberRequestHash(ids.actor, identity, m),
    hash('whaleu-media-member:v4', {
      version: 4,
      actorAccountId: ids.actor,
      batchRequestHash: v4.batchRequestHash(ids.actor, identity),
      clientRequestId: m.clientRequestId,
      memberId: m.memberId,
      sourceSlot: 2,
      declaration: m.declaration,
    }),
  );
  assert.throws(() => v3.decodeBatchIdentity(identity));
  assert.throws(() => v3.decodeBatchStatus(readyBatch()));
  assert.throws(() => decodeUploadStatus(readyBatch().members[0]!.observation));
  assert.throws(() =>
    v4.decodeBatchIdentity({ ...identity, purpose: 'community-post-images' }),
  );
  assert.throws(() =>
    v4.decodeBatchIdentity({
      ...identity,
      target: { kind: 'reply', rootCommentId: uuid(51), targetReplyId: null },
    }),
  );
  assert.throws(() =>
    v4.decodeBatchIdentity({
      ...identity,
      target: { ...identity.target, extra: true },
    }),
  );
  assert.throws(() => v4.decodeMemberPrepare({ ...m, sourceSlot: 3 }));
  assert.throws(() => readyBatch(4));
});
test('discussion hash preserves original request intent including pure-image text and nullable exact reply target', () => {
  const comment = attempt(),
    ref = batchPublicationReference(comment);
  assert.equal(
    ref.intentHash,
    createHash('sha256')
      .update(
        JSON.stringify({
          operation: 'publish_comment',
          intent: {
            postId: uuid(50),
            text: '',
            imageAssetIds: comment.payload.imageAssetIds,
            authorMode: 'anonymous',
          },
        }),
      )
      .digest('hex'),
  );
  const replyIdentity: v4.BatchIdentity = {
    ...identity,
    purpose: 'community-reply-images',
    target: { kind: 'reply', rootCommentId: uuid(51), targetReplyId: null },
  };
  const reply = attempt(readyBatch(3, replyIdentity));
  assert.equal(
    batchPublicationReference(reply).intentHash,
    createHash('sha256')
      .update(
        JSON.stringify({
          operation: 'publish_reply',
          intent: {
            rootCommentId: uuid(51),
            targetReplyId: null,
            text: '',
            imageAssetIds: reply.payload.imageAssetIds,
            authorMode: 'anonymous',
          },
        }),
      )
      .digest('hex'),
  );
  assert.notEqual(
    batchPublicationReference(reply).intentHash,
    batchPublicationReference(
      attempt(
        readyBatch(3, {
          ...replyIdentity,
          target: { ...replyIdentity.target, targetReplyId: uuid(52) },
        }),
      ),
    ).intentHash,
  );
});
test('v4 seal and commands have independent hash domains, and no member omission is accepted', () => {
  const status = readyBatch(),
    assets = status.orderedAssets;
  assert.equal(
    v4.attachmentPlanDigest(uuid(2), '5', assets),
    hash('whaleu-media-attachment-plan:v2', {
      version: 2,
      batchId: uuid(2),
      revision: '5',
      orderedAssets: assets,
    }),
  );
  assert.notEqual(
    v4.attachmentPlanDigest(uuid(2), '5', assets),
    v3.attachmentPlanDigest(uuid(2), '5', assets),
  );
  const command = {
    kind: 'layout' as const,
    payload: {
      commandId: uuid(80),
      expectedRevision: '4',
      orderedMemberIds: status.orderedMemberIds,
      removeMemberIds: [],
    },
  };
  assert.equal(
    v4.batchCommandHash(uuid(2), command),
    hash('whaleu-media-batch-command:v2', {
      version: 2,
      batchId: uuid(2),
      kind: 'layout',
      command: command.payload,
    }),
  );
  for (const patch of [
    { members: status.members.slice(1) },
    { orderedAssets: assets.slice(1) },
    { retiring: [status.members[0]] },
  ])
    assert.throws(() => v4.decodeBatchStatus({ ...status, ...patch }));
});

test('v4 status requires durable server post ancestry; pre-prepare cancel has no invented ancestry', () => {
  const status = readyBatch();
  const { resolvedPostId, ...missing } = status;
  assert.equal(resolvedPostId, uuid(50));
  assert.throws(() => v4.decodeBatchStatus(missing));
  assert.throws(() =>
    v4.decodeBatchStatus({ ...status, resolvedPostId: null }),
  );
  assert.throws(() =>
    v4.decodeBatchStatus({ ...status, resolvedPostId: uuid(999) }),
  );
  const terminal = {
    version: 4,
    batchIdentity: null,
    resolvedPostId: null,
    batchRequestId: identity.batchRequestId,
    batchRequestHash: v4.batchRequestHash(ids.actor, identity),
    batchId: null,
    revision: '1',
    serverNow: 1000,
    orderedMemberIds: [],
    members: [],
    retiring: [],
    status: 'terminal',
    reason: 'cancelled',
    cleanup: 'confirmed',
  };
  assert.equal(v4.decodeBatchStatus(terminal).resolvedPostId, null);
  assert.throws(() =>
    v4.decodeBatchStatus({ ...terminal, resolvedPostId: uuid(50) }),
  );
});
