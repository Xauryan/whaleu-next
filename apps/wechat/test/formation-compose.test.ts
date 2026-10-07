import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { decodePostIntent } from '../src/community/contract';
import {
  componentFormationDraft,
  decodeFormationDraft,
  emptyFormationDraft,
  formationDraftComponent,
} from '../src/community/formation-draft';
import {
  DraftStore,
  PendingAttemptStore,
  type Draft,
} from '../src/community/pending-attempt';
import { emptyPollDraft } from '../src/community/poll-draft';
import { emptyTradingDraft } from '../src/community/trading-draft';
import {
  ComposeController,
  type ComposeTarget,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  commentId,
  intent,
  otherId,
  postId,
  receipt,
  requestId,
  setup,
  spaceId,
} from './community-helpers';

const target: ComposeTarget = {
  operation: 'publish_post',
  spaceId,
  category: 'discussion',
};
const draftTarget = `post:${spaceId}:discussion`;
const validDraft = () => ({
  ...emptyFormationDraft(),
  enabled: true,
  theme: '合成活动',
  capacity: '2',
  wechat: 'synthetic-wechat',
  contactConsent: true,
});
function composer(destination: ComposeTarget | null = target) {
  const s = setup(),
    views: ComposeView[] = [];
  const controller = new ComposeController(s.runtime, destination, (view) =>
    views.push(view),
  );
  return { ...s, controller, view: () => views[views.length - 1]! };
}
async function ready() {
  const s = composer();
  await s.controller.load();
  s.controller.setText('一起参加合成活动');
  s.controller.setFormationEnabled(true);
  s.controller.setFormationField('theme', '合成活动');
  s.controller.setFormationField('capacity', '2');
  s.controller.setFormationField('wechat', 'synthetic-wechat');
  s.controller.setFormationConsent(true);
  return s;
}

test('formation draft normalizes only explicit fields and enforces capacity, Unicode theme, contact bytes and consent', () => {
  const draft = validDraft();
  assert.deepEqual(
    formationDraftComponent({
      ...draft,
      theme: '  🐳'.concat('🐳'.repeat(11), '  '),
      capacity: '1',
      wechat: ' synthetic-wechat ',
      qq: '  ',
    }),
    {
      kind: 'formation',
      theme: '🐳'.repeat(12),
      capacity: 1,
      contacts: { wechat: 'synthetic-wechat', qq: '', phone: '' },
      contactSharing: 'members_v1',
    },
  );
  assert.equal(
    formationDraftComponent({ ...draft, capacity: '20' }).capacity,
    20,
  );
  for (const capacity of [
    '',
    '0',
    '21',
    '1.5',
    '2e0',
    '2people',
    ' 2 ',
    '2\n',
    '2\r',
    '\n2',
    '02',
    '-1',
  ])
    assert.throws(() => formationDraftComponent({ ...draft, capacity }));
  for (const theme of ['', '  ', '🐳'.repeat(13), '\ud800', 'x\u0000'])
    assert.throws(() => formationDraftComponent({ ...draft, theme }));
  assert.throws(() => formationDraftComponent({ ...draft, enabled: false }));
  assert.throws(() =>
    formationDraftComponent({ ...draft, contactConsent: false }),
  );
  assert.throws(() =>
    formationDraftComponent({ ...draft, wechat: ' ', qq: '', phone: '' }),
  );
  for (const [field, maximum] of [
    ['wechat', 100],
    ['qq', 50],
    ['phone', 20],
  ] as const) {
    const contacts = {
      wechat: '',
      qq: '',
      phone: '',
      [field]: 'a'.repeat(maximum),
    };
    assert.equal(
      formationDraftComponent({ ...draft, ...contacts }).contacts[field],
      'a'.repeat(maximum),
    );
    assert.throws(() =>
      formationDraftComponent({
        ...draft,
        ...contacts,
        [field]: 'a'.repeat(maximum + 1),
      }),
    );
    assert.throws(() =>
      formationDraftComponent({
        ...draft,
        ...contacts,
        [field]: '鲸'.repeat(Math.floor(maximum / 3) + 1),
      }),
    );
  }
  assert.deepEqual(
    componentFormationDraft(formationDraftComponent(draft)),
    draft,
  );
  assert.throws(() => decodeFormationDraft({ ...draft, accountId: otherId }));
  assert.throws(() => decodeFormationDraft({ ...draft, capacity: 2 }));
  assert.throws(() =>
    decodeFormationDraft({ ...draft, contactConsent: 'true' }),
  );
});

test('creator contacts begin empty despite trading preferences; body and explicit consent are required', async () => {
  const s = composer();
  s.runtime.drafts.rememberTrading(s.accountId, '合成地点', {
    wechat: 'private-trading-wechat',
    qq: '',
    phone: 'private-phone',
  });
  await s.controller.load();
  assert.deepEqual(s.view().formationDraft, emptyFormationDraft());
  assert.equal(s.view().canAddFormation, true);
  s.controller.setFormationEnabled(true);
  s.controller.setFormationField('theme', '合成活动');
  s.controller.setFormationField('capacity', '1');
  s.controller.setFormationField('wechat', 'typed-by-creator');
  s.controller.setFormationConsent(true);
  assert.equal(s.view().canSubmit, false);
  s.controller.setText('合成正文');
  assert.equal(s.view().canSubmit, true);
  s.controller.setFormationConsent(false);
  assert.equal(s.view().canSubmit, false);
  assert.match(s.view().blocker, /组内成员/);
  s.controller.setFormationConsent(true);
  s.controller.setAuthorMode('anonymous');
  assert.equal(s.view().formationDraft.contactConsent, false);
  assert.match(s.view().effectiveIdentity, /联系方式仍可能识别你/);
  s.controller.setFormationConsent(true);
  s.controller.setFormationField('phone', 'typed-phone');
  assert.equal(s.view().formationDraft.contactConsent, false);
  s.controller.setFormationConsent(true);
  s.controller.setFormationEnabled(false);
  s.controller.setFormationEnabled(true);
  assert.equal(s.view().formationDraft.contactConsent, false);
  s.controller.setFormationConsent(true);
  await s.controller.submit();
  const sent = decodePostIntent(
    s.gateway.calls.find((call) => call.method === 'publishPost')!.args[0],
  );
  assert.deepEqual(sent.component, {
    kind: 'formation',
    capacity: 1,
    theme: '合成活动',
    contacts: { wechat: 'typed-by-creator', qq: '', phone: 'typed-phone' },
    contactSharing: 'members_v1',
  });
  assert.deepEqual(s.view().formationDraft, emptyFormationDraft());
  assert.equal(s.runtime.drafts.load(s.accountId, draftTarget), null);
  assert.equal(
    s.runtime.drafts.loadTradingPreferences(s.accountId)?.contacts.wechat,
    'private-trading-wechat',
  );
});

test('poll and formation cannot both enable; disabled subdrafts survive switching and reopening', async () => {
  const s = await ready();
  s.controller.setPollEnabled(true);
  assert.equal(s.view().pollDraft.enabled, false);
  assert.match(s.view().error, /先关闭组队/);
  s.controller.setFormationEnabled(false);
  s.controller.setPollEnabled(true);
  s.controller.setPollQuestion('保留的问题');
  s.controller.setFormationEnabled(true);
  assert.equal(s.view().formationDraft.enabled, false);
  assert.match(s.view().error, /先关闭投票/);
  s.controller.dispose();
  const views: ComposeView[] = [];
  const reopened = new ComposeController(s.runtime, target, (view) =>
    views.push(view),
  );
  await reopened.load();
  const view = () => views[views.length - 1]!;
  assert.equal(view().formationDraft.wechat, 'synthetic-wechat');
  assert.equal(view().formationDraft.enabled, false);
  assert.equal(view().pollDraft.question, '保留的问题');
  assert.equal(view().pollDraft.enabled, true);
  reopened.setPollEnabled(false);
  reopened.setFormationEnabled(true);
  assert.equal(view().pollDraft.question, '保留的问题');
  assert.equal(view().formationDraft.wechat, 'synthetic-wechat');
  assert.equal(view().formationDraft.contactConsent, false);
});

test('incomplete formation draft preserves exact entered text and is isolated by account and target', async () => {
  const s = await ready();
  s.controller.setFormationField('theme', ' 原主题\r\n🐳 ');
  s.controller.setFormationField('capacity', '2people');
  s.controller.setFormationField('qq', ' unfinished ');
  const saved = s.runtime.drafts.load(s.accountId, draftTarget)!;
  assert.equal(saved.formation?.theme, ' 原主题\r\n🐳 ');
  assert.equal(saved.formation?.capacity, '2people');
  assert.equal(saved.formation?.contactConsent, false);
  assert.equal(s.view().canSubmit, false);
  s.controller.dispose();
  const views: ComposeView[] = [];
  const reopened = new ComposeController(s.runtime, target, (view) =>
    views.push(view),
  );
  await reopened.load();
  assert.deepEqual(views[views.length - 1]!.formationDraft, saved.formation);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  assert.deepEqual(
    views[views.length - 1]!.formationDraft,
    emptyFormationDraft(),
  );
  assert.equal(s.runtime.drafts.load(otherId, draftTarget), null);
  assert.equal(
    s.runtime.drafts.load(s.accountId, `post:${spaceId}:help`),
    null,
  );
  assert.deepEqual(s.runtime.drafts.load(s.accountId, draftTarget), saved);
});

test('draft storage rejects active conflicts and component leakage without replacing old drafts', () => {
  const s = setup(),
    store = new DraftStore(s.storage, 'synthetic');
  const old: Draft = {
    version: 1,
    text: 'old',
    authorMode: 'anonymous',
    commentsPolicy: 'open',
  };
  store.save(s.accountId, draftTarget, old);
  assert.deepEqual(store.load(s.accountId, draftTarget), old);
  assert.throws(() =>
    store.save(s.accountId, draftTarget, {
      ...old,
      poll: { ...emptyPollDraft(), enabled: true },
      formation: validDraft(),
    }),
  );
  assert.deepEqual(store.load(s.accountId, draftTarget), old);
  assert.throws(() =>
    store.save(s.accountId, draftTarget, {
      ...old,
      trading: emptyTradingDraft(),
      formation: validDraft(),
    }),
  );
  assert.throws(() =>
    store.save(s.accountId, `post:${spaceId}:trading`, {
      ...old,
      formation: validDraft(),
    }),
  );
  assert.throws(() =>
    store.save(s.accountId, `comment:${postId}`, {
      ...old,
      formation: validDraft(),
    }),
  );
  const key = `whaleu.community.draft.v1:synthetic:${s.accountId}:${draftTarget}`;
  s.storage.data.set(key, {
    ...old,
    poll: { ...emptyPollDraft(), enabled: true },
    formation: validDraft(),
  });
  assert.throws(() => store.load(s.accountId, draftTarget));
});

test('formation timeout freezes normalized intent and contacts across cancel, reopen, failed lookup and exact retry', async () => {
  const s = await ready();
  s.controller.setFormationField('theme', ' 合成活动 ');
  s.controller.setFormationField('wechat', ' synthetic-wechat ');
  s.controller.setFormationConsent(true);
  s.gateway.publishPostImpl = async (payload) => {
    assert.deepEqual(s.runtime.pending.load(s.accountId)?.payload, payload);
    throw new ClientError('timeout', 'synthetic');
  };
  await s.controller.submit();
  const pending = s.runtime.pending.load(s.accountId)!;
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().formationDraft.theme, '合成活动');
  s.controller.setFormationField('wechat', 'changed');
  s.controller.setFormationConsent(false);
  s.controller.setFormationEnabled(false);
  s.controller.setPollEnabled(true);
  s.controller.cancel();
  assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
  s.controller.dispose();
  assert.deepEqual(s.view().formationDraft, emptyFormationDraft());
  const views: ComposeView[] = [];
  const recovery = new ComposeController(s.runtime, null, (view) =>
    views.push(view),
  );
  await recovery.load();
  assert.equal(views[views.length - 1]!.formationDraft.enabled, true);
  assert.equal(views[views.length - 1]!.pollDraft.enabled, false);
  assert.deepEqual(
    new PendingAttemptStore(s.storage, 'synthetic').load(s.accountId),
    pending,
  );
  s.gateway.receiptImpl = async () => {
    throw new ClientError('http', 'synthetic', {
      serverCode: 'REQUEST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await recovery.recover();
  assert.equal(views[views.length - 1]!.frozen, true);
  assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
  s.gateway.publishPostImpl = async () => receipt();
  await recovery.recover(true);
  const sends = s.gateway.calls.filter((call) => call.method === 'publishPost');
  assert.deepEqual(sends[0]!.args[0], sends[1]!.args[0]);
  assert.equal(s.runtime.pending.load(s.accountId), null);
  assert.deepEqual(
    views[views.length - 1]!.formationDraft,
    emptyFormationDraft(),
  );
});

test('formation double tap, late response and failed draft cleanup retain exactly one original request', async () => {
  const s = await ready(),
    response = deferred<ReturnType<typeof receipt>>();
  s.gateway.publishPostImpl = () => response.promise;
  const submitting = s.controller.submit();
  await flush();
  await s.controller.submit();
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'publishPost').length,
    1,
  );
  const pending = s.runtime.pending.load(s.accountId)!;
  s.controller.cancel();
  response.resolve(receipt());
  await submitting;
  assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
  s.storage.failRemove = true;
  await s.controller.recover();
  assert.equal(s.view().frozen, true);
  assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
  s.storage.failRemove = false;
  await s.controller.recover();
  assert.equal(s.runtime.pending.load(s.accountId), null);
});

test('plain historic requests remain byte-shape compatible; disabling formation emits no default component', async () => {
  const s = await ready();
  s.controller.setFormationEnabled(false);
  await s.controller.submit();
  const sent = s.gateway.calls.find((call) => call.method === 'publishPost')!
    .args[0];
  assert.equal(Object.prototype.hasOwnProperty.call(sent, 'component'), false);
  const old = composer(),
    payload = intent();
  old.runtime.pending.freeze({
    version: 1,
    accountId: old.accountId,
    operation: 'publish_post',
    payload,
  });
  await old.controller.load();
  assert.deepEqual(old.view().formationDraft, emptyFormationDraft());
  await old.controller.recover(true);
  assert.deepEqual(
    old.gateway.calls.find((call) => call.method === 'publishPost')!.args[0],
    payload,
  );
});

test('formation controls are unavailable for trading, comments and replies', async () => {
  for (const destination of [
    { operation: 'publish_post', spaceId, category: 'trading' },
    { operation: 'publish_comment', postId },
    {
      operation: 'publish_reply',
      postId,
      rootCommentId: commentId,
      targetReplyId: null,
    },
  ] as const) {
    const s = composer(destination);
    await s.controller.load();
    assert.equal(s.view().canAddFormation, false);
    s.controller.setFormationEnabled(true);
    s.controller.setFormationField('wechat', 'forbidden');
    s.controller.setFormationConsent(true);
    assert.deepEqual(s.view().formationDraft, emptyFormationDraft());
  }
});

test('secure ID delay, session replacement and cancellation cannot dispatch stale formation contacts', async () => {
  for (const changedAccount of [true, false]) {
    const s = await ready(),
      id = deferred<string>();
    Object.assign(s.runtime, { newRequestId: () => id.promise });
    const submitting = s.controller.submit();
    await flush();
    if (changedAccount)
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: otherId,
      });
    else s.controller.cancel();
    id.resolve(requestId);
    await submitting;
    await flush();
    assert.equal(s.runtime.pending.load(s.accountId), null);
    assert.equal(
      s.gateway.calls.some((call) => call.method === 'publishPost'),
      false,
    );
    if (changedAccount)
      assert.deepEqual(s.view().formationDraft, emptyFormationDraft());
  }
});

test('unreliable draft storage blocks formation publication without creating a pending request', async () => {
  const s = await ready();
  s.storage.failWrite = true;
  s.controller.setFormationField('qq', 'new-contact');
  s.controller.setFormationConsent(true);
  assert.equal(s.view().canSubmit, false);
  await s.controller.submit();
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'publishPost'),
    false,
  );
  assert.equal(s.runtime.pending.load(s.accountId), null);
});

for (const lifecycle of ['app-hide', 'logout', 'same-account-login'] as const)
  test(`formation ${lifecycle} clears entered contact display and ignores late publication success without dropping recovery`, async () => {
    const s = await ready(),
      response = deferred<ReturnType<typeof receipt>>();
    s.gateway.publishPostImpl = () => response.promise;
    const submitting = s.controller.submit();
    await flush();
    const pending = s.runtime.pending.load(s.accountId)!;
    assert.ok(pending);
    if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
    else if (lifecycle === 'logout') s.sessions.logout();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    assert.deepEqual(s.view().formationDraft, emptyFormationDraft());
    response.resolve(receipt());
    await submitting;
    assert.deepEqual(s.view().formationDraft, emptyFormationDraft());
    assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
    assert.equal(s.view().resourceId, '');
  });

test('formation access-token refresh keeps the same frozen intent while malformed receipts never settle it', async () => {
  const s = await ready(),
    response = deferred<ReturnType<typeof receipt>>();
  s.gateway.publishPostImpl = () => response.promise;
  const submitting = s.controller.submit();
  await flush();
  const pending = s.runtime.pending.load(s.accountId)!;
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
  response.resolve(receipt({ requestId: otherId }));
  await submitting;
  assert.equal(s.view().frozen, true);
  assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
  s.gateway.receiptImpl = async () => ({
    ...receipt(),
    contacts: { phone: 'unexpected' },
  });
  await s.controller.recover();
  assert.equal(s.view().frozen, true);
  assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
  assert.equal(JSON.stringify(s.view()).includes('unexpected'), false);
  s.gateway.receiptImpl = async () => receipt();
  await s.controller.recover();
  assert.equal(s.runtime.pending.load(s.accountId), null);
});
