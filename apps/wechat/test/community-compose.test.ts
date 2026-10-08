import { publicExperienceDisplay } from './community-helpers';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  ComposeController,
  commentIdentity,
  type ComposeTarget,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import type { Receipt } from '../src/community/contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  capabilities,
  commentCapabilities,
  intent,
  otherId,
  post,
  postId,
  receipt,
  requestId,
  setup,
  spaceId,
} from './community-helpers';
const postTarget: ComposeTarget = {
  operation: 'publish_post',
  spaceId,
  category: 'discussion',
};
function composer(target: ComposeTarget | null = postTarget) {
  const s = setup(),
    views: ComposeView[] = [];
  const controller = new ComposeController(s.runtime, target, (view) =>
    views.push(view),
  );
  return { ...s, controller, views, view: () => views[views.length - 1]! };
}
test('composer durably freezes exact normalized intent before dispatch and never changes key after response loss', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setAuthorMode('anonymous');
  s.controller.setText('  原文\r\n🐳  ');
  s.gateway.publishPostImpl = async (payload) => {
    assert.deepEqual(s.runtime.pending.load(s.accountId)?.payload, payload);
    assert.equal(payload.text, '  原文\n🐳  ');
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.submit();
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().canSubmit, false);
  s.controller.setText('different');
  s.controller.setAuthorMode('named');
  await s.controller.submit();
  assert.equal(s.view().text, '  原文\n🐳  ');
  const saved = s.runtime.pending.load(s.accountId);
  assert.equal(saved?.payload.authorMode, 'anonymous');
  s.gateway.receiptImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'REQUEST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await s.controller.recover();
  assert.equal(s.view().frozen, true);
  assert.ok(s.runtime.pending.load(s.accountId));
  s.gateway.publishPostImpl = async (payload) =>
    receipt({ requestId: payload.clientRequestId });
  await s.controller.recover(true);
  const sends = s.gateway.calls.filter((call) => call.method === 'publishPost');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0]!.args[0], sends[1]!.args[0]);
  assert.equal(s.view().receiptStatus, '发布已确认');
  assert.equal(s.runtime.pending.load(s.accountId), null);
});
test('plain business/auth errors and malformed/mismatched receipts never clear a prior uncertain attempt', async () => {
  for (const failure of [
    new ClientError('business', 'safe', {
      serverCode: 'CONTENT_REJECTED',
      httpStatus: 422,
    }),
    new ClientError('http', 'safe', {
      serverCode: 'COMMUNITY_UNAVAILABLE',
      httpStatus: 503,
    }),
    new ClientError('protocol', 'safe'),
  ]) {
    const s = composer();
    await s.controller.load();
    s.controller.setText('waiting');
    s.gateway.publishPostImpl = async () => {
      throw failure;
    };
    await s.controller.submit();
    assert.equal(s.view().frozen, true);
    s.gateway.receiptImpl = async () =>
      receipt({ operation: 'publish_comment' });
    await s.controller.recover();
    assert.ok(s.runtime.pending.load(s.accountId));
    assert.equal(s.view().frozen, true);
  }
  const s = composer();
  await s.controller.load();
  s.controller.setText('waiting');
  s.gateway.publishPostImpl = async () => {
    throw new ClientError('auth-required', 'safe', {
      serverCode: 'SESSION_REVOKED',
      httpStatus: 401,
    });
  };
  await s.controller.submit();
  assert.equal(s.sessions.snapshot().credentials, null);
  assert.equal(s.view().text, '');
  assert.ok(s.runtime.pending.load(s.accountId));
});
test('terminal rejected receipt unlocks only after successful persistence settlement', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setText('needs revision');
  s.gateway.publishPostImpl = async () => ({
    requestId,
    operation: 'publish_post',
    outcome: 'rejected',
    code: 'CONTENT_REJECTED',
  });
  s.storage.failRemove = true;
  await s.controller.submit();
  assert.equal(s.view().frozen, true);
  assert.ok(s.runtime.pending.load(s.accountId));
  s.storage.failRemove = false;
  s.gateway.receiptImpl = async () => ({
    requestId,
    operation: 'publish_post',
    outcome: 'rejected',
    code: 'CONTENT_REJECTED',
  });
  await s.controller.recover();
  assert.equal(s.view().frozen, false);
  assert.equal(s.runtime.pending.load(s.accountId), null);
  assert.equal(s.view().canSubmit, false);
  await s.controller.load();
  assert.equal(s.view().text, 'needs revision');
});
test('draft/pending storage failure prevents first dispatch and does not silently replace a corrupt attempt', async () => {
  const s = composer();
  await s.controller.load();
  s.storage.failWrite = true;
  s.controller.setText('private draft');
  await s.controller.submit();
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'publishPost'),
    false,
  );
  s.storage.failWrite = false;
  s.controller.setText('private draft');
  const key = `whaleu.community.pending.v1:synthetic:${s.accountId}`;
  s.storage.data.set(key, { version: 0 });
  await s.controller.submit();
  assert.equal(s.view().frozen, true);
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'publishPost'),
    false,
  );
  assert.deepEqual(s.storage.data.get(key), { version: 0 });
});
test('account changes clear private UI synchronously but pending survives page closure and same-account re-login', async () => {
  const s = composer(),
    late = deferred<Receipt>();
  await s.controller.load();
  s.controller.setText('original private content');
  s.gateway.publishPostImpl = () => late.promise;
  const pending = s.controller.submit();
  await flush();
  assert.ok(s.runtime.pending.load(s.accountId));
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  assert.equal(s.view().text, '');
  assert.equal(s.view().effectiveIdentity, '');
  await pending;
  s.controller.dispose();
  late.resolve(receipt());
  await flush();
  assert.ok(s.runtime.pending.load(s.accountId));
  const views: ComposeView[] = [];
  const recovery = new ComposeController(s.runtime, null, (view) =>
    views.push(view),
  );
  await recovery.load();
  assert.equal(views[views.length - 1]!.frozen, false);
  assert.equal(views[views.length - 1]!.text, '');
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
  await recovery.load();
  assert.equal(views[views.length - 1]!.text, 'original private content');
  assert.equal(views[views.length - 1]!.frozen, true);
  await recovery.recover();
  assert.equal(s.runtime.pending.load(s.accountId), null);
});
test('same-tick cancellation and account change prevent new-key dispatch; cancellation after persistence stays frozen', async () => {
  const s = composer();
  await s.controller.load();
  s.controller.setText('private');
  let pending = s.controller.submit();
  s.controller.cancel();
  await pending;
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'publishPost'),
    false,
  );
  assert.equal(s.runtime.pending.load(s.accountId), null);
  const late = deferred<Receipt>();
  s.gateway.publishPostImpl = () => late.promise;
  pending = s.controller.submit();
  await flush();
  s.controller.cancel();
  await pending;
  assert.equal(s.view().frozen, true);
  assert.ok(s.runtime.pending.load(s.accountId));
  late.resolve(receipt());
  await flush();
  assert.ok(s.runtime.pending.load(s.accountId));
});
test('two composers cannot create overlapping intents, duplicate taps dispatch once', async () => {
  const s = composer(),
    views: ComposeView[] = [];
  const other = new ComposeController(s.runtime, postTarget, (view) =>
    views.push(view),
  );
  await s.controller.load();
  await other.load();
  s.controller.setText('one');
  other.setText('two');
  const late = deferred<Receipt>();
  s.gateway.publishPostImpl = () => late.promise;
  const pending = s.controller.submit();
  await flush();
  await s.controller.submit();
  other.setText('replace');
  await other.submit();
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'publishPost').length,
    1,
  );
  assert.equal(views[views.length - 1]!.frozen, true);
  assert.equal(views[views.length - 1]!.text, 'one');
  late.resolve(receipt());
  await pending;
});
test('anonymous preference is intent only; disallowed anonymity never silently becomes named', async () => {
  const s = composer();
  s.profiles.current = {
    ...s.profiles.current,
    preferences: {
      ...s.profiles.current.preferences,
      defaultAnonymousEnabled: true,
    },
  };
  s.gateway.capabilitiesImpl = async () =>
    capabilities({ authorModes: ['named'] });
  await s.controller.load();
  s.controller.setText('private');
  assert.equal(s.view().authorMode, 'anonymous');
  assert.equal(s.view().canSubmit, false);
  await s.controller.submit();
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'publishPost'),
    false,
  );
  s.controller.setAuthorMode('named');
  assert.equal(s.view().canSubmit, true);
});
test('comment own-anonymous forcing wins over named defaults, uses independent comment permission', async () => {
  const s = composer({ operation: 'publish_comment', postId });
  s.profiles.current = {
    ...s.profiles.current,
    preferences: {
      ...s.profiles.current.preferences,
      defaultCommentNonAnonymousEnabled: true,
    },
  };
  s.gateway.capabilitiesImpl = async () =>
    capabilities({
      publish: {
        availability: 'denied',
        reason: 'STUDENT_VERIFICATION_REQUIRED',
      },
      authorModes: [],
    });
  await s.controller.load();
  assert.equal(s.view().authorMode, 'anonymous');
  assert.equal(s.view().identityForced, true);
  s.controller.setAuthorMode('named');
  assert.equal(s.view().authorMode, 'anonymous');
  s.controller.setText('根评论');
  assert.equal(s.view().canSubmit, true);
  await s.controller.submit();
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'capabilities'),
    false,
  );
  assert.equal(
    (
      s.gateway.calls.find((call) => call.method === 'publishComment')!
        .args[1] as { authorMode: string }
    ).authorMode,
    'anonymous',
  );
  assert.deepEqual(
    commentIdentity(false, null, {
      defaultCommentAnonymousEnabled: true,
      defaultCommentNonAnonymousEnabled: true,
    }),
    { mode: 'anonymous', conflict: true },
  );
  assert.deepEqual(
    commentIdentity(true, 'named', {
      defaultCommentAnonymousEnabled: true,
      defaultCommentNonAnonymousEnabled: true,
    }),
    { mode: 'anonymous', conflict: false },
  );
});
test('unverified named comments and denied/unavailable policy have honest effective identity without fabricated verification', async () => {
  const s = composer({ operation: 'publish_comment', postId });
  s.gateway.postImpl = async () =>
    post({
      author: {
        kind: 'named',
        experienceDisplay: publicExperienceDisplay(),
        profileId: otherId,
        displayName: '合成昵称',
        avatar: null,
      },
      viewer: {
        isSelf: false,
        isLiked: false,
        canDelete: false,
        canComment: true,
        isSaved: false,
        canSave: true,
        canSetUpdatePreference: true,
      },
    });
  s.gateway.commentCapabilitiesImpl = async () =>
    commentCapabilities({ authorModes: ['named'], forcedAuthorMode: null });
  await s.controller.load();
  s.controller.setText('named comment');
  assert.equal(s.view().authorMode, 'named');
  assert.equal(s.view().canSubmit, true);
  const blocked = composer();
  blocked.gateway.capabilitiesImpl = async () =>
    capabilities({
      publish: { availability: 'unavailable', reason: 'COMMUNITY_UNAVAILABLE' },
      authorModes: [],
    });
  await blocked.controller.load();
  blocked.controller.setText('cannot publish');
  assert.equal(blocked.view().canSubmit, false);
  assert.match(blocked.view().blocker, /服务端状态暂不能确认/);
});
test('frozen intent survives recovery from another target without creating or editing a new draft', async () => {
  const s = composer({ operation: 'publish_comment', postId });
  s.runtime.pending.freeze({
    version: 1,
    accountId: s.accountId,
    operation: 'publish_post',
    payload: intent(),
  });
  await s.controller.load();
  assert.equal(s.view().recoveryOperation, '帖子');
  assert.equal(s.view().text, '原始文字');
  await s.controller.recover(true);
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'publishComment'),
    false,
  );
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'publishPost').length,
    1,
  );
});
