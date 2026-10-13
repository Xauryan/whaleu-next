import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import {
  decodeCapabilities,
  decodePost,
  decodePostIntent,
  decodeFeed,
  decodeCommentIntent,
  decodeCommentCapabilities,
} from '../src/community/contract';
import type { PostIntent } from '../src/community/contract';
import { HttpCommunityGateway } from '../src/community/gateway';
import {
  PendingAttemptStore,
  type PendingAttempt,
} from '../src/community/pending-attempt';
import {
  supportsTextReview,
  matchReviewCancellation,
} from '../src/community/review-contract';
import { decodeHotPage } from '../src/community/hot-contract';
import {
  searchTargetPath,
  decodeSearchHit,
  decodeSearchPage,
} from '../src/community/search-contract';
import { batchPublicationReference } from '../src/media/batch-publication';
import { mediaPublicationReference } from '../src/media/upload-runtime';
import {
  ComposeController,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import {
  DetailController,
  type DetailView,
} from '../src/pages/community-detail/controller';
import {
  ThreadController,
  type ThreadView,
} from '../src/pages/community-thread/controller';
import { HttpSchoolPostingPolicyGateway } from '../src/school-posting-policy/gateway';
import { Cancellation } from '../src/platform/contracts';
import {
  decodePostingPolicyCommand,
  decodePostingPolicyView,
  postingPolicyCommandHash,
} from '../src/school-posting-policy/contract';
import { PostingPolicyJournal } from '../src/school-posting-policy/pending';
import {
  capabilities,
  commentCapabilities,
  commentId,
  comment,
  reply,
  intent,
  otherId,
  post,
  postId,
  requestId,
  setup,
  spaceId,
} from './community-helpers';
import { searchHit, searchPage } from './search-helpers';
import { MemoryStorage, ScriptedTransport, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  postingCommand,
  postingHarness,
  postingPolicy,
  postingReceipt,
  postingRegion,
  postingRevisionId,
  postingView,
} from './school-posting-policy-helpers';

const destination = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor = wireCredentials().accountId;
const attempt = (
  payload: PostIntent = intent(),
): Extract<PendingAttempt, { operation: 'publish_post' }> => ({
  version: 1,
  accountId: actor,
  operation: 'publish_post',
  payload,
});
function legacyHash(body: PostIntent): string {
  const original = {
    spaceId: body.spaceId,
    category: body.category,
    text: body.text,
    imageAssetIds: body.imageAssetIds,
    authorMode: body.authorMode,
    commentsPolicy: body.commentsPolicy,
    ...(body.allowAnonymousDm === undefined
      ? {}
      : { allowAnonymousDm: body.allowAnonymousDm }),
  };
  return createHash('sha256')
    .update(JSON.stringify({ operation: 'publish_post', intent: original }))
    .digest('hex');
}

test('sync intent keeps every old DM/component hash and appends true after DM in both native media producers', () => {
  for (const dm of [undefined, false, true])
    for (const component of [undefined, { kind: 'none' as const }]) {
      const body = intent({
        authorMode: 'named',
        ...(dm === undefined ? {} : { allowAnonymousDm: dm }),
        ...(component ? { component } : {}),
      });
      const absent = attempt(body),
        off = attempt({ ...body, syncToRelatedCampuses: false }),
        on = attempt({ ...body, syncToRelatedCampuses: true });
      assert.equal(
        mediaPublicationReference(absent).intentHash,
        legacyHash(body),
      );
      assert.deepEqual(
        mediaPublicationReference(absent),
        mediaPublicationReference(off),
      );
      assert.deepEqual(
        decodePostIntent(off.payload),
        decodePostIntent(absent.payload),
      );
      const oldIntent = {
        spaceId: body.spaceId,
        category: body.category,
        text: body.text,
        imageAssetIds: body.imageAssetIds,
        authorMode: body.authorMode,
        commentsPolicy: body.commentsPolicy,
        ...(dm === undefined ? {} : { allowAnonymousDm: dm }),
        syncToRelatedCampuses: true,
      };
      const expected = createHash('sha256')
        .update(
          JSON.stringify({ operation: 'publish_post', intent: oldIntent }),
        )
        .digest('hex');
      assert.equal(mediaPublicationReference(on).intentHash, expected);
      assert.equal(batchPublicationReference(on).intentHash, expected);
      assert.notEqual(expected, legacyHash(body));
    }
  assert.throws(() =>
    decodePostIntent({ ...intent(), syncToRelatedCampuses: 'true' }),
  );
  assert.throws(() =>
    decodePostIntent({
      ...intent(),
      category: 'trading',
      syncToRelatedCampuses: true,
    }),
  );
  assert.throws(() =>
    decodeCommentIntent({
      clientRequestId: requestId,
      text: 'child',
      imageAssetIds: [],
      authorMode: 'named',
      syncToRelatedCampuses: true,
    }),
  );
});

test('display and coverage are optional for legacy fixtures and strict/private-field rejecting for new projections', () => {
  assert.deepEqual(decodePost(post()), post());
  const remote = {
    ...post(),
    isRelatedCampusSync: true,
    sourceRegion: { id: otherId, name: '原学校 A' },
  };
  assert.equal(decodePost(remote).space.id, spaceId);
  assert.equal(
    decodePost({ ...post(), isRelatedCampusSync: false }).sourceRegion,
    undefined,
  );
  for (const invalid of [
    { ...remote, isRelatedCampusSync: false },
    { ...post(), isRelatedCampusSync: true },
    {
      ...remote,
      sourceRegion: { ...remote.sourceRegion, identityCampusId: otherId },
    },
    { ...remote, topologySnapshotId: otherId },
  ])
    assert.throws(() => decodePost(invalid));
  for (const marker of ['complete', 'unavailable'] as const) {
    const page = {
      items: [remote],
      nextCursor: null,
      continuation: 'end',
      relatedCampusDistribution: marker,
    };
    assert.equal(decodeFeed(page).relatedCampusDistribution, marker);
    assert.equal(decodeHotPage(page).relatedCampusDistribution, marker);
  }
  assert.throws(() =>
    decodeFeed({
      items: [],
      nextCursor: null,
      continuation: 'end',
      relatedCampusDistribution: 'unknown',
    }),
  );
  const hit = searchHit({
    isRelatedCampusSync: true,
    sourceRegion: remote.sourceRegion,
  });
  const decoded = decodeSearchHit(hit);
  assert.equal(decoded.isRelatedCampusSync, true);
  assert.deepEqual(decoded.snippet.segments, hit.snippet.segments);
  assert.deepEqual(Object.keys(decoded.snippet.segments[0]!).sort(), [
    'matched',
    'text',
  ]);
  assert.equal(
    decodeSearchPage(
      searchPage({ items: [hit], relatedCampusDistribution: 'unavailable' }),
    ).relatedCampusDistribution,
    'unavailable',
  );
  assert.equal(
    decodeCommentCapabilities(
      commentCapabilities({ inheritsRelatedCampusSync: true }),
    ).inheritsRelatedCampusSync,
    true,
  );
  assert.throws(() =>
    decodeCommentCapabilities({
      ...commentCapabilities(),
      inheritsRelatedCampusSync: 'true',
    }),
  );
  assert.equal(decodeCapabilities(capabilities()).relatedCampusSync, undefined);
  assert.equal(
    decodeCapabilities(
      capabilities({
        relatedCampusSync: { availability: 'allowed', reason: null },
      }),
    ).relatedCampusSync?.availability,
    'allowed',
  );
  assert.throws(() =>
    decodeCapabilities({
      ...capabilities(),
      relatedCampusSync: {
        availability: 'allowed',
        reason: 'COMMUNITY_UNAVAILABLE',
      },
    }),
  );
});

test('frozen sync and original destination survive reload without changing old stored attempts', () => {
  const storage = new MemoryStorage(),
    journal = new PendingAttemptStore(storage, 'sync');
  const old = journal.freeze(attempt());
  assert.equal(
    JSON.stringify(old),
    JSON.stringify(attempt(decodePostIntent(intent()))),
  );
  journal.settleCancelled(
    old,
    {
      requestId,
      operation: 'publish_post',
      outcome: 'cancelled',
      intentHash: batchPublicationReference(old).intentHash,
    },
    batchPublicationReference(old).intentHash,
  );
  const original = journal.freeze({
    ...attempt({ ...intent(), syncToRelatedCampuses: true }),
    viewSpaceId: destination,
  });
  assert.equal(original.operation, 'publish_post');
  if (original.operation !== 'publish_post')
    throw new Error('Expected root intent');
  assert.deepEqual(
    new PendingAttemptStore(storage, 'sync').load(actor),
    original,
  );
  assert.equal(journal.load(otherId), null);
  assert.throws(() => journal.freeze({ ...original, viewSpaceId: spaceId }));
  assert.throws(() =>
    journal.freeze({
      ...original,
      payload: { ...original.payload, syncToRelatedCampuses: false },
    }),
  );
  assert.throws(() =>
    matchReviewCancellation(original, {
      requestId,
      operation: 'publish_post',
      outcome: 'cancelled',
      intentHash: batchPublicationReference(attempt()).intentHash,
    }),
  );
});

function composer() {
  const s = setup();
  let view: ComposeView;
  s.gateway.capabilitiesImpl = async () =>
    capabilities({
      relatedCampusSync: { availability: 'allowed', reason: null },
    });
  const create = () =>
    new ComposeController(
      s.runtime,
      {
        operation: 'publish_post',
        spaceId,
        category: 'discussion',
        viewSpaceId: destination,
      },
      (value) => {
        view = value;
      },
    );
  return { ...s, create, view: () => view };
}
test('explicit opt-in resets unfrozen on reload and interruption; absent capability cannot create a hidden opt-in', async () => {
  const s = composer(),
    c = s.create();
  await c.load();
  assert.equal(s.view().syncToRelatedCampuses, false);
  c.setText('test');
  c.setRelatedCampusSync(true);
  assert.equal(s.view().syncToRelatedCampuses, true);
  c.cancel();
  assert.equal(s.view().syncToRelatedCampuses, false);
  c.setRelatedCampusSync(true);
  await c.load();
  assert.equal(s.view().syncToRelatedCampuses, false);
  c.setRelatedCampusSync(true);
  s.gateway.capabilitiesImpl = async () => capabilities();
  await c.load();
  c.setRelatedCampusSync(true);
  assert.equal(s.view().canChooseRelatedCampusSync, false);
  assert.equal(s.view().syncToRelatedCampuses, false);
  c.dispose();
});
test('lost response freezes exact sync and destination across Close/reopen; account switch clears projection', async () => {
  const s = composer(),
    c = s.create();
  await c.load();
  c.setText('one canonical post');
  c.setRelatedCampusSync(true);
  s.gateway.publishPostImpl = async () => {
    throw new ClientError('timeout', 'lost');
  };
  await c.submit();
  const saved = s.runtime.pending.load(actor)!;
  assert.equal(
    saved.operation === 'publish_post' && saved.payload.syncToRelatedCampuses,
    true,
  );
  assert.equal(saved.viewSpaceId, destination);
  assert.equal(s.view().frozen, true);
  c.dispose();
  const reopened = s.create();
  await reopened.load();
  assert.equal(s.view().syncToRelatedCampuses, true);
  assert.equal(s.view().viewSpaceId, destination);
  reopened.setRelatedCampusSync(false);
  assert.deepEqual(s.runtime.pending.load(actor), saved);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  assert.equal(s.view().syncToRelatedCampuses, false);
  assert.equal(s.view().text, '');
  assert.deepEqual(s.runtime.pending.load(actor), saved);
  reopened.dispose();
});
test('a late capability callback after account replacement cannot restore sync selection', async () => {
  const s = composer(),
    c = s.create(),
    gate = deferred<ReturnType<typeof capabilities>>();
  s.gateway.capabilitiesImpl = () => gate.promise;
  const loading = c.load();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  gate.resolve(
    capabilities({
      relatedCampusSync: { availability: 'allowed', reason: null },
    }),
  );
  await loading;
  assert.equal(s.view().canChooseRelatedCampusSync, false);
  assert.equal(s.view().syncToRelatedCampuses, false);
  c.dispose();
});
test('sync review accepts exact anonymous/component/media inputs without extending legacy named-text gate', () => {
  const body = intent({
    syncToRelatedCampuses: true,
    imageAssetIds: [otherId],
  });
  assert.equal(supportsTextReview(attempt(body)), true);
  assert.equal(
    supportsTextReview(attempt({ ...body, syncToRelatedCampuses: false })),
    false,
  );
});
test('HTTP remote feed and detail preserve canonical A space while carrying explicit B view selector', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  const gateway = new HttpCommunityGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  const remote = {
    ...post(),
    isRelatedCampusSync: true,
    sourceRegion: { id: otherId, name: 'A' },
  };
  transport.reply({
    items: [remote],
    nextCursor: null,
    continuation: 'end',
    relatedCampusDistribution: 'complete',
  });
  const page = await gateway.feed({ spaceId: destination }, new Cancellation());
  assert.equal(page.items[0]?.space.id, spaceId);
  transport.reply(remote);
  await gateway.post(postId, new Cancellation(), destination);
  assert.match(
    transport.requests[1]!.url,
    new RegExp(`viewSpaceId=${destination}`),
  );
  assert.equal(
    searchTargetPath({ kind: 'post', postId }, destination),
    `/pages/community-detail/community-detail?postId=${postId}&viewSpaceId=${destination}`,
  );
});
test('detail refresh, not a display badge, revalidates destination before exposing discussion', async () => {
  const s = setup();
  let view: DetailView;
  const c = new DetailController(
    s.runtime,
    postId,
    (value) => {
      view = value;
    },
    undefined,
    null,
    destination,
  );
  await c.load();
  assert.equal(
    s.gateway.calls.find((call) => call.method === 'post')?.args[2],
    destination,
  );
  s.gateway.postImpl = async () => {
    throw new ClientError('business', 'withdrawn');
  };
  await c.load();
  assert.equal(view!.post, null);
  assert.equal(view!.comments.length, 0);
  c.dispose();
});
test('school v2 requires explicit flag; v1 hashes and original journal recovery remain unchanged', () => {
  const old = postingCommand(),
    command = decodePostingPolicyCommand({
      ...old,
      version: 2,
      policy: { ...old.policy, relatedSyncEnabled: true },
    });
  assert.notEqual(
    postingPolicyCommandHash(actor, postingRegion, old),
    postingPolicyCommandHash(actor, postingRegion, command),
  );
  assert.throws(() => decodePostingPolicyCommand({ ...old, version: 2 }));
  assert.throws(() =>
    decodePostingPolicyCommand({
      ...old,
      policy: { ...old.policy, relatedSyncEnabled: false },
    }),
  );
  assert.equal(
    decodePostingPolicyView(
      postingView({
        revision: 1,
        revisionId: postingRevisionId,
        state: 'active',
        policy: {
          ...postingPolicy(),
          relatedSyncEnabled: true,
          effectiveAt: '2026-01-01T00:00:00Z',
        },
      }),
    ).editable,
    true,
  );
  const storage = new MemoryStorage(),
    journal = new PostingPolicyJournal(storage, 'https://policy.invalid');
  const frozen = journal.write(actor, postingRegion, command);
  assert.deepEqual(
    new PostingPolicyJournal(storage, 'https://policy.invalid').read(actor),
    frozen,
  );
});
test('existing school form makes a strict v2 sync command and preserves the flag in uncertain recovery', async () => {
  const s = postingHarness(),
    c = s.create();
  await c.load();
  c.setSwitch('relatedSyncEnabled', true);
  c.setExpiryKind('policy_exempt');
  s.gateway.save = async (_region, command) => {
    s.calls.saves.push(command);
    throw new ClientError('timeout', 'lost');
  };
  await c.save();
  assert.equal(s.calls.saves[0]?.version, 2);
  assert.equal(s.calls.saves[0]?.policy.relatedSyncEnabled, true);
  c.setSwitch('relatedSyncEnabled', false);
  assert.equal(s.journal.read(actor)?.command.policy.relatedSyncEnabled, true);
  c.dispose();
});

test('actual school HTTP save retains the strict version-2 discriminator and flag', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  const gateway = new HttpSchoolPostingPolicyGateway(
    new ApiClient('https://policy.invalid', transport, sessions, {
      refresh: async () => {
        throw new Error('No auth replay');
      },
    }),
  );
  const old = postingCommand(),
    command = decodePostingPolicyCommand({
      ...old,
      version: 2,
      policy: { ...old.policy, relatedSyncEnabled: true },
    });
  transport.reply(postingReceipt(command));
  await gateway.save(postingRegion, command, new Cancellation());
  assert.deepEqual(transport.requests[0]!.body, command);
});
test('thread continuation clears B content when the current B projection is withdrawn', async () => {
  const s = setup();
  let view: ThreadView;
  s.gateway.repliesImpl = async () => ({
    items: [reply()],
    nextCursor: 'next',
  });
  const controller = new ThreadController(
    s.runtime,
    postId,
    commentId,
    null,
    (next) => {
      view = next;
    },
    destination,
  );
  await controller.load();
  assert.equal(view!.canLoadMore, true);
  const oldReads = s.gateway.calls.filter(
    (call) => call.method === 'replies',
  ).length;
  s.gateway.postImpl = async () => {
    throw new ClientError('business', 'B withdrawn');
  };
  await controller.more();
  assert.equal(view!.post, null);
  assert.deepEqual(view!.replies, []);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'replies').length,
    oldReads,
  );
  controller.dispose();
});

test('related-only reviewer hints support anonymous and comment-control without enabling the old none gate', async () => {
  const s = composer();
  s.gateway.capabilitiesImpl = async () =>
    capabilities({
      publish: {
        availability: 'unavailable',
        reason: 'CONTENT_REVIEW_UNAVAILABLE',
      },
      authorModes: ['named'],
      canDisableComments: false,
      relatedCampusSync: {
        availability: 'allowed',
        reason: null,
        authorModes: ['named', 'anonymous'],
        canDisableComments: true,
      },
    });
  const controller = s.create();
  await controller.load();
  controller.setText('related-only policy');
  controller.setAuthorMode('anonymous');
  assert.equal(s.view().canSubmit, false);
  controller.setRelatedCampusSync(true);
  assert.equal(s.view().canSubmit, true);
  assert.equal(s.view().canDisableComments, true);
  controller.setRestricted(true);
  assert.equal(s.view().commentsPolicy, 'restricted');
  assert.equal(s.view().canSubmit, true);
  controller.setRelatedCampusSync(false);
  assert.equal(s.view().canSubmit, false);
  assert.equal(s.view().canDisableComments, false);
  controller.setRestricted(false);
  assert.equal(s.view().commentsPolicy, 'open');
  controller.dispose();
});
test('detail reply-preview continuation rechecks the original B context after withdrawal', async () => {
  const s = setup();
  let view: DetailView;
  s.gateway.commentsImpl = async () => ({
    items: [comment({ replyPreview: { items: [], nextCursor: 'next' } })],
    nextCursor: null,
  });
  const controller = new DetailController(
    s.runtime,
    postId,
    (next) => {
      view = next;
    },
    undefined,
    null,
    destination,
  );
  await controller.load();
  s.gateway.postImpl = async () => {
    throw new ClientError('business', 'B withdrawn');
  };
  await controller.moreReplies(commentId);
  assert.equal(view!.post, null);
  assert.deepEqual(view!.comments, []);
  controller.dispose();
});

test('restricted inherited comments and replies require both server authority hints before exact Review', async () => {
  for (const operation of ['publish_comment', 'publish_reply'] as const)
    for (const allowed of [true, false]) {
      const s = setup();
      let view: ComposeView;
      const submissions: PendingAttempt[] = [];
      s.gateway.postImpl = async () =>
        post({
          commentsPolicy: 'restricted',
          viewer: { ...post().viewer, canComment: allowed },
        });
      s.gateway.commentCapabilitiesImpl = async () =>
        commentCapabilities({
          inheritsRelatedCampusSync: true,
          availability: allowed ? 'allowed' : 'denied',
          reason: allowed ? null : 'COMMENTS_DISABLED',
          authorModes: allowed ? ['named', 'anonymous'] : [],
        });
      Object.assign(s.gateway, {
        submitReview: async (attempt: PendingAttempt) => {
          submissions.push(attempt);
          return {
            requestId: attempt.payload.clientRequestId,
            operation,
            status: 'pending',
          };
        },
        reviewStatus: async (attempt: PendingAttempt) => ({
          requestId: attempt.payload.clientRequestId,
          operation,
          status: 'pending',
        }),
      });
      const controller = new ComposeController(
        s.runtime,
        operation === 'publish_comment'
          ? { operation, postId, viewSpaceId: destination }
          : {
              operation,
              postId,
              rootCommentId: commentId,
              targetReplyId: null,
              viewSpaceId: destination,
            },
        (next) => {
          view = next;
        },
      );
      await controller.load();
      controller.setText('Restricted inherited exact discussion');
      assert.equal(view!.canSubmit, allowed);
      await controller.submit();
      assert.equal(submissions.length, allowed ? 1 : 0);
      if (allowed) {
        assert.equal(view!.reviewStatus, 'pending');
        assert.equal(submissions[0]!.operation, operation);
        assert.equal(submissions[0]!.viewSpaceId, destination);
      }
      controller.dispose();
    }
});
