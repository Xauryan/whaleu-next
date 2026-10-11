import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { ClientError } from '../src/api/errors';
import {
  OrganizationEditorController,
  initialOrganizationEditorView,
} from '../src/organizations/controller';
import { OrganizationCommandJournal } from '../src/organizations/pending';
import {
  organizationCommandHash,
  decodeOrganizationCommand,
  decodeOrganizationPublicDetail,
} from '../src/organizations/contract';
import type {
  OrganizationDetail,
  OrganizationReceipt,
  OrganizationCommand,
} from '../src/organizations/contract';
import type { OrganizationGateway } from '../src/organizations/gateway';
import type { DirectoryGateway } from '../src/directory/gateway';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
const id = randomUUID(),
  region = randomUUID(),
  category = randomUUID();
function harness() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const storage = new MemoryStorage(),
    journal = new OrganizationCommandJournal(
      storage,
      'https://organization.invalid',
    );
  let view = initialOrganizationEditorView();
  const commands: OrganizationCommand[] = [];
  const detail: OrganizationDetail = {
    source: 'managed',
    id,
    regionId: region,
    revision: 1,
    authorityVersion: 1,
    state: 'draft',
    data: {
      kind: 'org',
      platform: 'qq',
      categoryId: category,
      name: '校园组织',
      introText: '',
      qqGroupNumber: '12345',
    },
    role: 'applicant',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mediaBindings: {},
    reviewReason: null,
    members: [],
    permissions: {
      edit: true,
      submit: true,
      review: false,
      manageMembers: false,
      transferOwner: false,
    },
  };
  const receipt = (c: OrganizationCommand): OrganizationReceipt => ({
    requestId: c.clientRequestId,
    requestHash: organizationCommandHash(
      sessions.snapshot().credentials!.accountId,
      id,
      c,
    ),
    organizationId: id,
    revision: 2,
    authorityVersion: 1,
    outcome: 'saved',
    changed: true,
  });
  const gateway: OrganizationGateway = {
    context: async () => ({ regionId: region }),
    capabilities: async () => ({ management: 'none', region: null }),
    list: async () => ({ items: [], continuation: 'end', nextCursor: null }),
    detail: async () => structuredClone(detail),
    publicDetail: async () => ({
      ...detail,
      role: 'reader',
      state: 'approved',
      management: { available: false },
    }),
    lookup: async (_id, profileId) => ({ profileId, displayName: '成员' }),
    command: async (_id, _region, c) => {
      commands.push(c);
      return receipt(c);
    },
    recover: async (requestId) => ({ state: 'not_recorded', requestId }),
    cancel: async (requestId, requestHash) => ({
      state: 'cancelled',
      requestId,
      requestHash,
    }),
  };
  const directory: DirectoryGateway = {
    context: async () => ({ regionId: region }),
    categories: async () => ({
      items: [
        {
          id: category,
          kind: 'org',
          name: '社团',
          description: '',
          accent: 'green',
        },
      ],
      continuation: 'end',
      nextCursor: null,
    }),
    entries: async () => ({ items: [], continuation: 'end', nextCursor: null }),
    detail: async () => {
      throw Error('unused');
    },
  };
  const controller = new OrganizationEditorController(
    sessions,
    gateway,
    directory,
    journal,
    async () => randomUUID(),
    (v) => {
      view = v;
    },
  );
  return {
    sessions,
    storage,
    journal,
    gateway,
    directory,
    controller,
    commands,
    detail,
    receipt,
    view: () => view,
  };
}
test('native organization lost response preserves original hash/key and recovery never invents a new command', async () => {
  const h = harness();
  let saved: OrganizationReceipt | undefined;
  h.gateway.command = async (_id, _region, c) => {
    h.commands.push(c);
    saved = h.receipt(c);
    throw new ClientError('network', 'lost response');
  };
  await h.controller.load(id);
  h.controller.setField('introText', '原请求内容');
  await h.controller.save();
  assert.equal(h.view().pending, true);
  const pending = h.journal.read(wireCredentials().accountId)!;
  assert.equal(pending.command.action, 'save');
  h.gateway.recover = async (requestId) => ({
    state: 'recorded',
    requestId,
    receipt: saved!,
  });
  await h.controller.recover();
  assert.equal(h.view().pending, false);
  assert.equal(h.commands.length, 1);
  assert.equal(h.journal.read(wireCredentials().accountId), null);
  h.controller.dispose();
});
test('native organization cancellation submits the original stored hash and blocks editing while unresolved', async () => {
  const h = harness();
  h.gateway.command = async () => {
    throw new ClientError('timeout', 'uncertain');
  };
  await h.controller.load(id);
  await h.controller.save();
  const before = h.view().form!.name;
  h.controller.setField('name', '不能覆盖');
  assert.equal(h.view().form!.name, before);
  const pending = h.journal.read(wireCredentials().accountId)!;
  let cancelled = '';
  h.gateway.cancel = async (requestId, hash) => {
    cancelled = hash;
    return { state: 'cancelled', requestId, requestHash: hash };
  };
  await h.controller.cancelPending();
  assert.equal(cancelled, pending.requestHash);
  assert.equal(h.view().pending, false);
  h.controller.dispose();
});
test('hide while awaiting request ID cannot write a journal or send a command', async () => {
  const h = harness();
  h.controller.dispose();
  let release!: (value: string) => void;
  const waiting = new Promise<string>((resolve) => {
    release = resolve;
  });
  const controller = new OrganizationEditorController(
    h.sessions,
    h.gateway,
    h.directory,
    h.journal,
    () => waiting,
    () => undefined,
  );
  await controller.load(id);
  const save = controller.save();
  controller.dispose();
  release(randomUUID());
  await save;
  assert.equal(h.commands.length, 0);
  assert.equal(h.journal.read(wireCredentials().accountId), null);
});
test('public native decoder rejects manager-contact disclosure and new-owner commands reject uppercase UUIDs', () => {
  const h = harness(),
    d = h.detail;
  assert.throws(() =>
    decodeOrganizationPublicDetail({
      source: d.source,
      id: d.id,
      regionId: d.regionId,
      revision: d.revision,
      authorityVersion: d.authorityVersion,
      state: 'approved',
      data: d.data,
      role: 'reader',
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      mediaBindings: { managerContact: randomUUID() },
      management: { available: false },
    }),
  );
  assert.throws(() =>
    decodeOrganizationCommand({
      action: 'save',
      clientRequestId: 'ABCDEFAB-1234-4234-8234-123456789ABC',
      expectedRevision: 1,
      expectedAuthorityVersion: 1,
      data: d.data,
      mediaChanges: {},
    }),
  );
  h.controller.dispose();
});
