import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { PendingAdminPostRemovalStore } from '../src/admin-post-removal/pending';
import { PendingAdminDiscussionRemovalStore } from '../src/admin-discussion-removal/pending';
import { PendingProfileModerationStore } from '../src/profile-moderation/pending';
import { PendingProfileAvatarModerationStore } from '../src/profile-avatar-moderation/pending';
import { PendingModerationStore } from '../src/account-moderation/pending';
import {
  decodeReceipt,
  type Command,
  type PunishmentView,
} from '../src/account-moderation/contract';
import type { ModerationGateway } from '../src/account-moderation/gateway';
import type { FeedbackNoticesGateway } from '../src/community/feedback-notices-gateway';
import {
  StudentVerificationController,
  type StudentEvidenceRuntime,
} from '../src/verification/student-controller';
import { StudentCommandJournal } from '../src/verification/student-pending';
import type { StudentApplication } from '../src/verification/student-contract';
import type { HttpStudentVerificationGateway } from '../src/verification/student-gateway';
import type { ProfileGateway } from '../src/profile/gateway';
import type { VerificationEvidenceReadView } from '../src/verification/evidence-runtime';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  setup,
  post,
  postId,
  otherId,
  requestId,
  spaceId,
  createdAt,
} from './community-helpers';
import { flush as shortFlush } from './helpers';
import { wireCredentials } from './identity-helpers';
const nativeRequire = createRequire(__filename);
const root = path.resolve(__dirname, '..');
interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
}
interface Capture {
  press(): boolean;
  detach(): void;
}
interface Bridge {
  capture(handler: string, dataset?: Record<string, unknown>): Capture;
  find(handler: string, dataset?: Record<string, unknown>): unknown;
  lifecycle(name: string): void;
  emissions: Array<{ currentTarget: { dataset: Record<string, unknown> } }>;
}
const { createNativePressBridge } = nativeRequire(
  './native-press-emitted-harness.mjs',
) as {
  createNativePressBridge(options: {
    page: Owner;
    pageFile: string;
    dist: string;
    extension: 'ts';
  }): Bridge;
};
const invoke = (p: Owner, handler: string, event?: unknown) =>
  (p[handler] as (e?: unknown) => unknown).call(p, event);
async function flush() {
  for (let i = 0; i < 20; i++) await shortFlush();
}
function mount(
  name: string,
  runtime: CommunityRuntime,
  query: unknown = {},
  show = true,
) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Page: globals.Page,
    getApp: globals.getApp,
    wx: globals.wx,
  };
  const navigation: string[] = [];
  globals.wx = {
    navigateTo: ({ url, success }: { url: string; success: () => void }) => {
      navigation.push(url);
      success();
    },
  };
  globals.getApp = () => ({ community: runtime });
  let definition: Owner | undefined;
  globals.Page = (value: Owner) => {
    definition = value;
  };
  const file = nativeRequire.resolve(
    path.join(root, `src/pages/${name}/${name}.ts`),
  );
  try {
    delete nativeRequire.cache[file];
    nativeRequire(file);
  } finally {
    globals.Page = previous.Page;
  }
  assert.ok(definition);
  const page: Owner = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      callback?.();
    },
  };
  if (typeof page.onLoad === 'function') invoke(page, 'onLoad', query);
  if (show && typeof page.onShow === 'function') invoke(page, 'onShow');
  const bridge = createNativePressBridge({
    page,
    pageFile: path.join(root, `src/pages/${name}/${name}`),
    dist: path.join(root, 'src'),
    extension: 'ts',
  });
  return {
    page,
    bridge,
    navigation,
    press(handler: string, dataset: Record<string, unknown> = {}) {
      const c = bridge.capture(handler, dataset);
      const result = c.press();
      c.detach();
      return result;
    },
    hide() {
      bridge.lifecycle('hide');
      invoke(page, 'onHide');
    },
    close() {
      bridge.lifecycle('detach');
      invoke(page, 'onUnload');
      Object.assign(globals, previous);
    },
  };
}
const removalCases = [
  {
    page: 'admin-post-removal',
    gateway: 'adminPostRemoval',
    pending: 'pendingAdminPostRemoval',
    Store: PendingAdminPostRemovalStore,
    entry: 'onRemovePost',
    kind: 'post',
    action: 'remove_post',
    cancel: 'ADMIN_POST_REMOVAL_CANCELLED',
  },
  {
    page: 'admin-discussion-removal',
    gateway: 'adminDiscussionRemoval',
    pending: 'pendingAdminDiscussionRemoval',
    Store: PendingAdminDiscussionRemovalStore,
    entry: 'onRemoveDiscussion',
    kind: 'reply',
    action: 'remove_discussion',
    cancel: 'ADMIN_DISCUSSION_REMOVAL_CANCELLED',
  },
  {
    page: 'profile-moderation',
    gateway: 'profileModeration',
    pending: 'pendingProfileModeration',
    Store: PendingProfileModerationStore,
    entry: 'onResetNickname',
    kind: 'post',
    action: 'reset_nickname',
    cancel: 'PROFILE_MODERATION_CANCELLED',
  },
  {
    page: 'profile-avatar-moderation',
    gateway: 'profileAvatarModeration',
    pending: 'pendingProfileAvatarModeration',
    Store: PendingProfileAvatarModerationStore,
    entry: 'onClearCustomAvatar',
    kind: 'post',
    action: 'clear_custom_avatar',
    cancel: 'PROFILE_AVATAR_MODERATION_CANCELLED',
  },
] as const;
for (const spec of removalCases)
  test(`actual Button → ${spec.page} Page/controller: recheck, confirmation, stale/busy suppression, original-key recovery and authority loss`, async () => {
    const s = setup(),
      store = new spec.Store(s.storage, 'synthetic-moderation-origin');
    const target = { kind: spec.kind, id: postId };
    let denied = false,
      lose = true,
      reads = 0;
    const sent: Array<{ command: Record<string, unknown>; cancel: boolean }> =
      [];
    const management = () =>
      spec.action.startsWith('remove_')
        ? {
            target,
            targetVersion: 'a'.repeat(64),
            canRemove: true,
            version: 3,
            viewSpaceId: spaceId,
          }
        : {
            target,
            displayName: '合成公开资料',
            revision: 0,
            ...(spec.action === 'reset_nickname'
              ? { canReset: true }
              : { canClearCustomAvatar: true, expectedAppearanceId: otherId }),
          };
    const gateway = {
      management: async (
        _target: unknown,
        _cancel: unknown,
        scope?: string,
      ) => {
        if (spec.action.startsWith('remove_')) assert.equal(scope, spaceId);
        reads++;
        if (denied) throw new ClientError('forbidden', 'synthetic revoked');
        return management();
      },
      submit: async (
        command: Record<string, unknown>,
        _cancel: unknown,
        cancel = false,
      ) => {
        sent.push({ command, cancel });
        assert.deepEqual(store.load(s.accountId)?.command, command);
        if (lose) throw new ClientError('timeout', 'synthetic lost response');
        const { clientRequestId, ...body } = command;
        return {
          ...body,
          requestId: clientRequestId,
          ...(cancel
            ? { outcome: 'rejected', code: spec.cancel }
            : {
                outcome: 'applied',
                eventId: otherId,
                recordedAt: createdAt,
                ...(spec.action.startsWith('remove_') ? {} : { revision: 1 }),
              }),
        };
      },
      receipt: async () => ({ state: 'not_recorded' }),
    };
    const runtime = {
      ...s.runtime,
      [spec.gateway]: gateway,
      [spec.pending]: store,
    };
    let m = mount(spec.page, runtime, {
      kind: spec.kind,
      id: postId,
      ...(spec.action.startsWith('remove_') ? { viewSpaceId: spaceId } : {}),
    });
    try {
      await flush();
      assert.equal(m.page.data.busy, false);
      assert.equal(m.bridge.find('onSubmit'), undefined);
      assert.equal(m.press(spec.entry), true);
      await flush();
      assert.ok(reads >= 2, 'Entry rechecks current authority');
      assert.equal(m.press('onClose'), true);
      assert.equal(sent.length, 0);
      m.press(spec.entry);
      await flush();
      const stale = m.bridge.capture('onSubmit');
      assert.equal(m.press('onSubmit'), true);
      assert.equal(stale.press(), false);
      assert.equal(m.press('onSubmit'), false);
      await flush();
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.command.action, spec.action);
      assert.deepEqual(sent[0]!.command.target, target);
      if (spec.action.startsWith('remove_')) {
        assert.equal(sent[0]!.command.version, 3);
        assert.equal(sent[0]!.command.viewSpaceId, spaceId);
        assert.equal(sent[0]!.command.expectedTargetVersion, 'a'.repeat(64));
        assert.equal(sent[0]!.command.punishment, undefined);
      } else {
        assert.equal(sent[0]!.command.expectedProfileRevision, 0);
        if (spec.action === 'clear_custom_avatar')
          assert.equal(sent[0]!.command.expectedAppearanceId, otherId);
      }
      assert.equal(m.page.data.frozen, true);
      const original = store.load(s.accountId)!;
      assert.ok(original);
      assert.equal(m.bridge.find(spec.entry), undefined);
      m.press('onRecover');
      await flush();
      assert.deepEqual(
        store.load(s.accountId),
        original,
        'Not-recorded does not create a fresh command',
      );
      m.close();
      m = mount(spec.page, runtime);
      await flush();
      assert.equal(m.page.data.frozen, true);
      assert.equal(m.bridge.find(spec.entry), undefined);
      assert.equal(m.press('onCancelRequest'), true);
      assert.equal(m.press('onClose'), true);
      assert.equal(sent.length, 1);
      lose = false;
      assert.equal(m.press('onRetry'), true);
      await flush();
      assert.equal(sent.length, 2);
      assert.deepEqual(sent[1]!.command, original.command);
      assert.equal(store.load(s.accountId), null);
      m.close();
      m = mount(spec.page, runtime, {
        kind: spec.kind,
        id: postId,
        ...(spec.action.startsWith('remove_') ? { viewSpaceId: spaceId } : {}),
      });
      await flush();
      lose = true;
      m.press(spec.entry);
      await flush();
      m.press('onSubmit');
      await flush();
      const cancelling = store.load(s.accountId)!;
      assert.ok(cancelling);
      lose = false;
      m.press('onCancelRequest');
      assert.equal(m.press('onConfirmCancel'), true);
      await flush();
      assert.equal(sent.length, 4);
      assert.deepEqual(sent[3]!.command, cancelling.command);
      assert.equal(sent[3]!.cancel, true);
      assert.equal(store.load(s.accountId), null);
      m.press('onReload');
      await flush();
      denied = true;
      assert.equal(m.press(spec.entry), true);
      await flush();
      assert.equal(m.bridge.find('onSubmit'), undefined);
      assert.equal(sent.length, 4);
      const hidden = m.bridge.capture('onReload');
      m.hide();
      assert.equal(hidden.press(), false);
      s.sessions.logout();
      assert.equal(store.load(s.accountId), null);
    } finally {
      m.close();
    }
  });
const punishment = (): PunishmentView => ({
  punishmentId: postId,
  kind: 'interaction_mute',
  revision: '1',
  reason: '合成处罚',
  startsAt: createdAt,
  endsAt: null,
  recordedAt: createdAt,
  state: 'active',
  terminal: null,
  canAppeal: true,
  openAppealId: null,
});
for (const mode of ['appeal', 'punishment'] as const)
  test(`actual Button → safety-${mode}-management: exact selection, decision/CAS, frozen retry, cancellation and session cleanup`, async () => {
    const s = setup(),
      store = new PendingModerationStore(
        s.storage,
        'synthetic-moderation-origin',
      );
    const sent: Array<{ command: Command; cancel: boolean }> = [];
    let lose = true,
      capable = true;
    const selectedPunishment = () => ({
      ...punishment(),
      stateVersion: 'a'.repeat(64),
      canRelease: capable,
    });
    const selectedAppeal = () => ({
      appealId: otherId,
      punishment: punishment(),
      text: '合成申诉',
      submittedAt: createdAt,
      state: 'pending' as const,
      decision: null,
      stateVersion: 'b'.repeat(64),
      canDecide: capable,
    });
    const forbidden = async (): Promise<never> => {
      throw Error('Unexpected consumer access from admin test');
    };
    const gateway: ModerationGateway = {
      status: forbidden,
      ownPunishment: forbidden,
      history: forbidden,
      appeals: forbidden,
      appeal: forbidden,
      punishments: async () => ({
        items: [selectedPunishment()],
        nextCursor: null,
      }),
      punishment: async () => selectedPunishment(),
      punishmentHistory: async () => ({
        items: [punishment()],
        nextCursor: null,
      }),
      appealQueue: async () => ({
        items: [selectedAppeal()],
        nextCursor: null,
      }),
      appealManagement: async () => selectedAppeal(),
      submit: async (command, _cancel, cancel = false) => {
        sent.push({ command, cancel });
        assert.deepEqual(store.load(s.accountId)?.command, command);
        if (lose) throw new ClientError('timeout', 'synthetic lost result');
        return decodeReceipt({
          requestId: command.clientRequestId,
          action: command.action,
          ...(command.action === 'decide_appeal'
            ? { appealId: command.appealId }
            : { punishment: command.punishment }),
          ...(cancel
            ? { outcome: 'rejected', code: 'SAFETY_MODERATION_CANCELLED' }
            : {
                outcome: 'applied',
                recordedAt: createdAt,
                eventId: otherId,
                ...(command.action === 'decide_appeal'
                  ? { decision: command.decision }
                  : {}),
              }),
        });
      },
      receipt: async () => ({ state: 'not_recorded' }),
    };
    const runtime = {
      ...s.runtime,
      accountModeration: gateway,
      pendingAccountModeration: store,
    };
    const name = `safety-${mode}-management`,
      select = mode === 'appeal' ? 'onSelectAppeal' : 'onSelectPunishment',
      entry = mode === 'appeal' ? 'onRequestDecision' : 'onRequestRelease',
      id = mode === 'appeal' ? otherId : postId;
    let m = mount(name, runtime);
    try {
      await flush();
      assert.equal(m.press(select, { id }), true);
      await flush();
      assert.deepEqual(
        m.bridge.emissions[m.bridge.emissions.length - 1]?.currentTarget
          .dataset,
        {
          id,
        },
      );
      assert.equal(
        m.press(entry, {
          ...(mode === 'appeal' ? { decision: 'released' } : {}),
        }),
        false,
        'A reason is mandatory',
      );
      invoke(m.page, 'onReason', { detail: { value: '合成处理理由' } });
      assert.equal(
        m.press(entry, mode === 'appeal' ? { decision: 'released' } : {}),
        true,
      );
      m.press('onClose');
      assert.equal(sent.length, 0);
      m.press(entry, mode === 'appeal' ? { decision: 'released' } : {});
      const stale = m.bridge.capture('onSubmit');
      m.press('onSubmit');
      assert.equal(stale.press(), false);
      assert.equal(m.press('onSubmit'), false);
      await flush();
      assert.equal(sent.length, 1);
      const original = store.load(s.accountId)!;
      assert.ok(original);
      assert.equal(
        original.command.action,
        mode === 'appeal' ? 'decide_appeal' : 'release',
      );
      if (original.command.action === 'decide_appeal') {
        assert.equal(original.command.appealId, otherId);
        assert.equal(original.command.decision, 'released');
        assert.equal(original.command.expectedStateVersion, 'b'.repeat(64));
      } else if (original.command.action === 'release') {
        assert.equal(original.command.punishment.punishmentId, postId);
        assert.equal(original.command.expectedStateVersion, 'a'.repeat(64));
      }
      assert.equal(m.page.data.frozen, true);
      assert.equal(m.page.data.selectedAppeal, null);
      assert.equal(m.page.data.selectedPunishment, null);
      m.close();
      m = mount(name, runtime);
      await flush();
      capable = false;
      m.press('onRecover');
      await flush();
      assert.deepEqual(store.load(s.accountId), original);
      m.press('onCancelRequest');
      m.press('onClose');
      assert.equal(sent.length, 1);
      lose = false;
      m.press('onRetry');
      await flush();
      assert.deepEqual(sent[1]!.command, original.command);
      assert.equal(store.load(s.accountId), null);
      capable = true;
      m.press('onReload');
      await flush();
      m.press(select, { id });
      await flush();
      invoke(m.page, 'onReason', { detail: { value: '合成取消演练' } });
      m.press(entry, mode === 'appeal' ? { decision: 'upheld' } : {});
      lose = true;
      m.press('onSubmit');
      await flush();
      const cancelling = store.load(s.accountId)!;
      assert.ok(cancelling);
      lose = false;
      m.press('onCancelRequest');
      assert.equal(m.press('onConfirmCancel'), true);
      await flush();
      assert.deepEqual(sent[3]!.command, cancelling.command);
      assert.equal(sent[3]!.cancel, true);
      assert.equal(store.load(s.accountId), null);
      capable = false;
      m.press('onReload');
      await flush();
      m.press(select, { id });
      await flush();
      invoke(m.page, 'onReason', { detail: { value: '仍无权限' } });
      assert.equal(m.bridge.find(entry), undefined);
      assert.equal(sent.length, 4);
      const hidden = m.bridge.capture('onReload');
      m.hide();
      assert.equal(hidden.press(), false);
      assert.equal(m.page.data.reason, '');
      s.sessions.logout();
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: otherId,
      });
      assert.equal(store.load(otherId), null);
    } finally {
      m.close();
    }
  });
test('actual Button → feedback-notices: exact notice datasets, explicit reads, per-open checks, unavailable rows and cursor continuation', async () => {
  const s = setup(),
    calls: string[] = [],
    cursors: Array<string | null> = [];
  let unavailable = false;
  const notice = {
    noticeId: requestId,
    kind: 'feedback_created' as const,
    createdAt,
    readAt: null,
  };
  const gateway: FeedbackNoticesGateway = {
    list: async (cursor) => {
      cursors.push(cursor);
      return {
        items: [notice],
        nextCursor: cursor ? null : 'next',
        unreadCount: 1,
      };
    },
    unread: async () => ({ unreadCount: 1 }),
    target: async (id) => {
      calls.push(`target:${id}`);
      return unavailable
        ? { noticeId: id, status: 'unavailable' }
        : { noticeId: id, status: 'available', postId };
    },
    read: async (id) => {
      calls.push(`read:${id}`);
      return { noticeId: id, readAt: createdAt, unreadCount: 0 };
    },
  };
  s.gateway.postImpl = async () => {
    calls.push('post');
    return post({ category: 'feedback' });
  };
  const m = mount('feedback-notices', {
    ...s.runtime,
    feedbackNotices: gateway,
  });
  try {
    await flush();
    assert.deepEqual(calls, []);
    const old = m.bridge.capture('onMore');
    assert.equal(m.press('onMore'), true);
    assert.equal(old.press(), false);
    await flush();
    assert.deepEqual(cursors, [null, 'next']);
    assert.equal(m.press('onOpen', { id: requestId }), true);
    await flush();
    assert.deepEqual(
      m.bridge.emissions[m.bridge.emissions.length - 1]?.currentTarget.dataset,
      {
        id: requestId,
      },
    );
    assert.equal(m.navigation.length, 1);
    assert.equal(calls.filter((c: string) => c.startsWith('read:')).length, 0);
    assert.equal(m.press('onRead', { id: requestId }), true);
    await flush();
    assert.equal(calls.filter((c: string) => c.startsWith('read:')).length, 1);
    m.press('onReload');
    await flush();
    unavailable = true;
    m.press('onOpen', { id: requestId });
    await flush();
    assert.equal(m.press('onOpen', { id: requestId }), false);
    assert.equal(m.press('onRead', { id: requestId }), false);
    assert.equal(m.navigation.length, 1);
    const hidden = m.bridge.capture('onReload');
    m.hide();
    assert.equal(hidden.press(), false);
    assert.deepEqual(m.page.data.items, []);
  } finally {
    m.close();
  }
});
test('actual Button → student review Page/controller: immutable queue IDs, evidence expiry/cleanup, explicit decision and original-request recovery', async () => {
  const s = setup(),
    privateViews = new PrivateViewLifecycle(),
    journal = new StudentCommandJournal(
      s.storage,
      'https://synthetic-student.example',
    );
  const app: StudentApplication = {
    id: postId,
    revision: 2,
    state: 'pending',
    campusId: otherId,
    campusName: '合成校区',
    institutionName: '合成学校',
    regionId: spaceId,
    profileId: otherId,
    submittedAt: createdAt,
    reason: null,
    evidenceRevision: 1,
    evidenceAvailable: true,
    evidenceExpiresAt: '2030-01-01T00:00:00.000Z',
  };
  const cursors: Array<string | null> = [],
    decisions: unknown[][] = [];
  let expired = false,
    clears = 0;
  const gateway = {
    capabilities: async () => ({
      management: 'fixed',
      region: { id: spaceId, name: '合成学校' },
    }),
    queue: async (
      _region: string,
      page: number,
      _cancel: unknown,
      cursor: string | null,
    ) => {
      cursors.push(cursor);
      return {
        items: [{ ...app }],
        page,
        hasNext: cursor === null,
        nextCursor: cursor === null ? postId : null,
      };
    },
    detail: async () =>
      expired ? { ...app, state: 'expired', evidenceAvailable: false } : app,
    decide: async (...args: unknown[]) => {
      decisions.push(args);
      throw new ClientError('timeout', 'synthetic lost decision');
    },
    recover: async (id: string) => ({
      requestId: id,
      state: 'not_recorded',
      receipt: null,
    }),
    cancelRequest: async (id: string, hash: string) => {
      assert.equal(journal.read(s.accountId)?.requestHash, hash);
      return { requestId: id, state: 'cancelled', receipt: null };
    },
  } as unknown as HttpStudentVerificationGateway;
  const media = {
    reconcile: async () => undefined,
    createUploader: () => ({
      clear() {},
      dispose() {},
      pick: async () => null,
      recover: async () => null,
    }),
    createReader: (render: (view: VerificationEvidenceReadView) => void) => ({
      clear() {
        clears++;
        render({ status: 'idle', src: '', message: '' });
      },
      dispose() {
        clears++;
      },
      load: async () => {
        render({
          status: 'ready',
          src: 'wxfile://tmp/fictional-review-material',
          message: '',
        });
      },
    }),
  } as unknown as StudentEvidenceRuntime;
  // Capture the actual Page registration. Supply its normal real controller with
  // synthetic gateway/media dependencies instead of invoking HTTP providers.
  const m = mount('student-verification-review', s.runtime, {}, false);
  const controller = new StudentVerificationController(
    {
      sessions: s.sessions,
      gateway,
      profiles: s.runtime.profiles as ProfileGateway,
      journal,
      newRequestId: async () => requestId,
      media,
      privateViews,
      render: (view) => m.page.setData({ ...view }),
    },
    'review',
  );
  m.page.controller = controller;
  try {
    await controller.load();
    assert.equal(m.press('onSelect', { id: postId }), true);
    await flush();
    assert.deepEqual(
      m.bridge.emissions[m.bridge.emissions.length - 1]?.currentTarget.dataset,
      {
        id: postId,
      },
    );
    assert.equal(m.press('onPreview'), true);
    await flush();
    assert.match(String(m.page.data.evidenceSrc), /fictional-review-material/);
    assert.equal(m.press('onClosePreview'), true);
    assert.equal(m.page.data.evidenceSrc, '');
    assert.ok(clears > 0);
    assert.equal(m.press('onNext'), true);
    await flush();
    assert.deepEqual(cursors, [null, postId]);
    assert.equal(m.press('onPrevious'), true);
    await flush();
    m.press('onSelect', { id: postId });
    await flush();
    assert.equal(m.press('onReject'), false);
    invoke(m.page, 'onReason', { detail: { value: '合成拒绝原因' } });
    m.press('onReject');
    assert.equal(m.page.data.confirmation, 'rejected');
    m.press('onDismiss');
    assert.equal(decisions.length, 0);
    m.press('onApprove');
    const stale = m.bridge.capture('onConfirm');
    assert.equal(m.press('onConfirm'), true);
    assert.equal(stale.press(), false);
    await flush();
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0]!.slice(0, 3), [
      spaceId,
      postId,
      { clientRequestId: requestId, expectedRevision: 2, decision: 'approved' },
    ]);
    assert.equal(m.page.data.pending, true);
    assert.ok(journal.read(s.accountId));
    assert.equal(m.bridge.find('onApprove'), undefined);
    const original = journal.read(s.accountId);
    m.press('onRecover');
    await flush();
    assert.deepEqual(journal.read(s.accountId), original);
    assert.equal(m.press('onCancelRequest'), true);
    await flush();
    assert.equal(journal.read(s.accountId), null);
    expired = true;
    await controller.load();
    m.press('onSelect', { id: postId });
    await flush();
    assert.equal(m.bridge.find('onPreview'), undefined);
    assert.equal(m.bridge.find('onApprove'), undefined);
    assert.equal(m.bridge.find('onReject'), undefined);
    const hidden = m.bridge.capture('onReload');
    m.hide();
    assert.equal(hidden.press(), false);
    assert.equal(m.page.data.evidenceSrc, '');
    assert.equal(m.page.data.application, null);
    assert.equal(m.page.data.reason, '');
  } finally {
    m.close();
  }
});
