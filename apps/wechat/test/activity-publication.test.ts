import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { ClientError } from '../src/api/errors';
import {
  ActivityPublicationController,
  initialActivityPublicationView,
} from '../src/activities/publication/controller';
import { ActivityPublicationJournal } from '../src/activities/publication/pending';
import {
  activityCommandHash,
  decodeActivityContent,
  emptyActivityContent,
} from '../src/activities/publication/contract';
import type {
  ActivityCommand,
  ActivityDraft,
  ActivityReceipt,
} from '../src/activities/publication/contract';
import type { HttpActivityPublicationGateway } from '../src/activities/publication/gateway';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
function harness() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const actor = sessions.snapshot().credentials!.accountId,
    id = randomUUID(),
    organizationId = randomUUID(),
    regionId = randomUUID(),
    storage = new MemoryStorage(),
    journal = new ActivityPublicationJournal(
      storage,
      'https://activity.invalid',
    );
  let view = initialActivityPublicationView();
  const commands: ActivityCommand[] = [];
  let draft: ActivityDraft = {
    source: 'native',
    id,
    regionId,
    organization: { source: 'managed', organizationId },
    organizationRevision: 2,
    revision: 1,
    state: 'draft',
    content: emptyActivityContent(),
    mediaBindings: {},
  };
  const receipt = (c: ActivityCommand): ActivityReceipt => ({
    requestId: c.clientRequestId,
    requestHash: activityCommandHash(actor, id, c),
    activityId: id,
    revision:
      c.action === 'create'
        ? 1
        : c.expectedRevision + (c.action === 'save' ? 1 : 0),
    outcome:
      c.action === 'create'
        ? 'created'
        : c.action === 'save'
          ? 'saved'
          : 'published',
  });
  const gateway: Pick<
    HttpActivityPublicationGateway,
    'organizers' | 'draft' | 'command' | 'recover' | 'cancel'
  > = {
    organizers: async () => ({
      regionId,
      items: [
        {
          source: 'managed',
          organizationId,
          revision: 2,
          name: '社团',
          kind: 'org',
          role: 'organization_owner',
        },
      ],
      nextCursor: null,
    }),
    draft: async () => structuredClone(draft),
    command: async (_id, c) => {
      commands.push(c);
      if (c.action === 'create' || c.action === 'save')
        draft = { ...draft, content: c.content, revision: receipt(c).revision };
      else draft = { ...draft, state: 'published' };
      return receipt(c);
    },
    recover: async (requestId) => ({ state: 'not_recorded', requestId }),
    cancel: async (requestId, requestHash) => ({
      state: 'cancelled',
      requestId,
      requestHash,
    }),
  };
  const create = () =>
    new ActivityPublicationController(
      sessions,
      gateway,
      journal,
      async () => id,
      (v) => {
        view = v;
      },
    );
  const controller = create();
  return {
    sessions,
    actor,
    id,
    organizationId,
    journal,
    storage,
    gateway,
    commands,
    receipt,
    controller,
    create,
    get view() {
      return view;
    },
    get draft() {
      return draft;
    },
    set draft(v) {
      draft = v;
    },
  };
}
test('activity native contract enforces original title/details/time limits and distinct type flags', () => {
  const c = emptyActivityContent();
  assert.equal(
    decodeActivityContent({ ...c, title: '字'.repeat(50) }).title.length,
    50,
  );
  assert.throws(() => decodeActivityContent({ ...c, title: '字'.repeat(51) }));
  assert.throws(() =>
    decodeActivityContent({ ...c, description: 'x'.repeat(1001) }),
  );
  assert.throws(() =>
    decodeActivityContent({ ...c, activityTime: 'x'.repeat(201) }),
  );
  assert.throws(() =>
    decodeActivityContent({ ...c, types: ['online', 'online'] }),
  );
  assert.deepEqual(
    decodeActivityContent({ ...c, types: ['online', 'reward'] }).types,
    ['online', 'reward'],
  );
  assert.equal(decodeActivityContent(c).endAt, null);
});
test('end time remains editable character by character and validates only when saving; draft pointer survives page destruction', async () => {
  const h = harness();
  await h.controller.load();
  h.controller.chooseOrganizer(h.organizationId);
  h.controller.setField('title', '活动');
  for (const prefix of ['2', '2026-', '2026-12-01T18:00:00+08:00']) {
    h.controller.setField('endAt', prefix);
    assert.equal(h.view.endAtInput, prefix);
  }
  await h.controller.create();
  assert.equal(h.commands[0]?.action, 'create');
  assert.equal(h.journal.draftId(h.actor), h.id);
  h.controller.dispose();
  const reopened = h.create();
  await reopened.load();
  assert.equal(h.view.id, h.id);
  assert.equal(h.view.form.endAt, '2026-12-01T18:00:00+08:00');
  reopened.dispose();
});
test('unconfirmed publication cannot be edited; repeated recovery sends the frozen original only and terminal receipt settles once', async () => {
  const h = harness();
  h.draft = {
    ...h.draft,
    revision: 2,
    content: { ...emptyActivityContent(), title: '活动', types: ['online'] },
    mediaBindings: { cover: randomUUID() },
  };
  await h.controller.load(h.id);
  let key = '';
  h.gateway.command = async (_id, c) => {
    h.commands.push(structuredClone(c));
    key = c.clientRequestId;
    throw new ClientError('network', 'lost');
  };
  await h.controller.publish();
  assert.equal(h.view.pending, true);
  const before = h.view.form.title;
  h.controller.setField('title', '不能替换原文');
  assert.equal(h.view.form.title, before);
  h.gateway.recover = async () => ({
    state: 'pending',
    requestId: key,
    requestHash: activityCommandHash(h.actor, h.id, h.commands[0]!),
    review: 'ready',
  });
  h.gateway.command = async (_id, c) => {
    h.commands.push(structuredClone(c));
    h.draft = { ...h.draft, state: 'published' };
    return h.receipt(c);
  };
  await h.controller.recover();
  assert.deepEqual(h.commands[0], h.commands[1]);
  assert.equal(h.view.pending, false);
  assert.equal(h.view.draft?.state, 'published');
  assert.equal(h.journal.draftId(h.actor), null);
  h.controller.dispose();
});
test('cancel a never-recorded create after restart restores organizer selection without a hidden new request', async () => {
  const h = harness(),
    command: ActivityCommand = {
      action: 'create',
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      organization: { source: 'managed', organizationId: h.organizationId },
      organizationRevision: 2,
      content: emptyActivityContent(),
    };
  h.journal.write(h.actor, h.id, command);
  await h.controller.load();
  assert.equal(h.view.pending, true);
  await h.controller.cancelOriginal();
  assert.equal(h.view.pending, false);
  assert.equal(h.view.id, '');
  assert.equal(h.view.organizers.length, 1);
  assert.equal(h.commands.length, 0);
  h.controller.dispose();
});
test('account/environment journal isolation and hidden-page clearing keep unresolved keys durable', async () => {
  const h = harness(),
    command: ActivityCommand = {
      action: 'publish',
      clientRequestId: randomUUID(),
      expectedRevision: 2,
    };
  h.journal.write(h.actor, h.id, command);
  assert.equal(h.journal.read(randomUUID()), null);
  assert.equal(
    new ActivityPublicationJournal(h.storage, 'https://other.invalid').read(
      h.actor,
    ),
    null,
  );
  await h.controller.load();
  h.controller.dispose();
  assert.equal(h.view.pending, false);
  assert.equal(h.view.form.title, '');
  assert.equal(
    h.journal.read(h.actor)?.command.clientRequestId,
    command.clientRequestId,
  );
});

test('explicit unfinished draft abandonment preserves original CAS and returns to organizer selection', async () => {
  const h = harness();
  await h.controller.load(h.id);
  h.gateway.command = async (_id, c) => {
    h.commands.push(c);
    return { ...h.receipt(c), outcome: 'draft_cancelled' };
  };
  await h.controller.discardDraft();
  assert.equal(h.commands[0]?.action, 'cancel_draft');
  assert.equal(h.commands[0]?.expectedRevision, 1);
  assert.equal(h.view.id, '');
  assert.equal(h.view.organizers.length, 1);
  assert.equal(h.journal.draftId(h.actor), null);
  h.controller.dispose();
});
