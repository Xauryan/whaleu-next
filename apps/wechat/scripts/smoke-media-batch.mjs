import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
function observe(page) {
  const waiting = new Set(),
    setData = page.setData.bind(page);
  page.setData = (patch) => {
    setData(patch);
    for (const inspect of [...waiting]) inspect();
  };
  return (predicate) => {
    if (predicate(page.data)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const inspect = () => {
        if (predicate(page.data)) {
          clearTimeout(timer);
          waiting.delete(inspect);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        waiting.delete(inspect);
        reject(new Error('Expected emitted batch Page state did not arrive'));
      }, 5000);
      waiting.add(inspect);
    });
  };
}
/** Actual emitted Page/controller/store/coordination with metadata-only synthetic
 * server and picker DI. Native bytes, sockets and PostgreSQL have separate gates. */
export async function smokeMediaBatch({ app, dist, mountPage, postWire }) {
  const load = (file) => require(path.join(dist, file));
  const { PendingBatchStore } = load('media/batch-pending.js');
  const { createMediaBatchRuntime, observeBatch } = load(
    'media/batch-runtime.js',
  );
  const { PendingAttemptStore } = load('community/pending-attempt.js');
  const {
    batchRequestHash,
    memberRequestHash,
    attachmentPlanDigest,
    decodeBatchStatus,
  } = load('media/batch-contracts.js');
  const { ClientError } = load('api/errors.js');
  const { systemClock } = load('platform/clock.js');
  const sessions = app.identity.sessions,
    actor = sessions.snapshot().credentials.accountId;
  const original = Object.fromEntries(
    [
      'mediaBatch',
      'mediaUpload',
      'gateway',
      'profiles',
      'pending',
      'newRequestId',
    ].map((key) => [key, app.community[key]]),
  );
  const values = new Map(),
    storage = {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, structuredClone(value)),
      remove: (key) => values.delete(key),
    };
  const origin = 'https://emitted-batch.invalid',
    pending = new PendingBatchStore(storage, origin),
    publicationPending = new PendingAttemptStore(storage, origin);
  const spaceId = postWire().space.id,
    batchId = randomUUID(),
    deadline = Date.now() + 3600000;
  const identity = {
    version: 1,
    batchRequestId: randomUUID(),
    draftId: randomUUID(),
    spaceId,
    purpose: 'community-post-images',
  };
  let revision = '3',
    mode = 'editing',
    publication,
    planDigest,
    receipt;
  const retired = new Map(),
    files = new Set();
  let peakFiles = 0,
    picks = 0,
    publishes = 0;
  const readyMember = (prepare) => {
    const requestHash = memberRequestHash(actor, identity, prepare),
      intentId = randomUUID(),
      assetId = randomUUID();
    return {
      version: 3,
      batchId,
      memberId: prepare.memberId,
      sourceSlot: prepare.sourceSlot,
      prepare,
      requestId: prepare.clientRequestId,
      requestHash,
      intentId,
      assetId,
      manifestDigest: 'b'.repeat(64),
      observation: {
        version: 2,
        intentId,
        requestId: prepare.clientRequestId,
        requestHash,
        serverNow: Date.now(),
        status: 'ready_unbound',
        assetId,
        readyRetentionUntil: deadline,
        draftExpiresAt: deadline,
        bindBefore: deadline,
        mediaProof: 'current',
      },
    };
  };
  let members = [0, 1].map((sourceSlot) =>
    readyMember({
      clientRequestId: randomUUID(),
      memberId: randomUUID(),
      sourceSlot,
      declaration: { mime: 'image/png', bytes: 100, sha256: 'a'.repeat(64) },
    }),
  );
  const assets = () =>
    members.map(({ memberId, assetId, manifestDigest }) => ({
      memberId,
      assetId,
      manifestDigest,
    }));
  const status = () =>
    decodeBatchStatus({
      version: 3,
      batchIdentity: identity,
      batchRequestId: identity.batchRequestId,
      batchRequestHash: batchRequestHash(actor, identity),
      batchId,
      revision,
      serverNow: Date.now(),
      orderedMemberIds: members.map((member) => member.memberId),
      members,
      retiring: [],
      ...(mode === 'editing'
        ? {
            status: 'ready_unbound',
            orderedAssets: assets(),
            draftExpiresAt: deadline,
            bindBefore: deadline,
          }
        : mode === 'sealed'
          ? {
              status: 'publication_pending',
              publication,
              attachmentPlanDigest: planDigest,
              orderedAssets: assets(),
            }
          : {
              status: 'bound_history',
              publication,
              attachmentPlanDigest: planDigest,
              orderedAssets: assets(),
              parent: {
                ownerKind: 'community',
                resourceKind: 'post',
                resourceId: receipt.resourceId,
                contentVersion: 1,
              },
              bindings: members.map((member, ordinal) => ({
                memberId: member.memberId,
                assetId: member.assetId,
                manifestDigest: member.manifestDigest,
                bindingId: member.observation.bindingId,
                ordinal,
                attachmentState: 'active',
              })),
            }),
    });
  const gateway = {
    async prepare() {
      assert.fail('The emitted fixture reuses its original prepared batch');
    },
    async recover() {
      return { version: 3, state: 'recorded', status: status() };
    },
    async memberStatus(intentId) {
      const member = [...members, ...retired.values()].find(
        (item) => item.intentId === intentId,
      );
      assert.ok(member);
      return member;
    },
    async prepareMember(id, input) {
      assert.equal(id, batchId);
      const member = readyMember(input);
      members.push(member);
      revision = String(BigInt(revision) + 1n);
      return member;
    },
    async command(id, command) {
      assert.equal(id, batchId);
      assert.equal(command.payload.expectedRevision, revision);
      if (command.kind === 'layout') {
        for (const memberId of command.payload.removeMemberIds) {
          assert.ok(
            pending
              .load(actor)
              .retiring.some((member) => member.memberId === memberId),
          );
          const member = members.find((item) => item.memberId === memberId);
          assert.ok(member);
          retired.set(memberId, {
            ...member,
            observation: {
              version: 2,
              intentId: member.intentId,
              requestId: member.requestId,
              requestHash: member.requestHash,
              serverNow: Date.now(),
              status: 'terminal',
              reason: 'cancelled',
              cleanup: 'pending',
            },
          });
        }
        members = command.payload.orderedMemberIds.map((memberId) => {
          const member = members.find((item) => item.memberId === memberId);
          assert.ok(member);
          return member;
        });
        assert.ok(members.length > 0);
        revision = String(BigInt(revision) + 1n);
        return status();
      }
      assert.equal(command.kind, 'seal');
      assert.deepEqual(
        command.payload.orderedMemberIds,
        members.map((member) => member.memberId),
      );
      assert.equal(pending.load(actor).publication.linkState, 'linked');
      revision = String(BigInt(revision) + 1n);
      publication = command.payload.publication;
      planDigest = attachmentPlanDigest(batchId, revision, assets());
      mode = 'sealed';
      return status();
    },
    async cancel() {
      assert.fail('This emitted flow never removes the entire batch');
    },
    async recoverPublication() {
      assert.fail('The original metadata key is present');
    },
    async fencePublication() {
      assert.fail('This emitted flow does not request cancellation');
    },
    async grant() {
      assert.fail('Synthetic ready member has no byte mutation');
    },
    async finalize() {
      assert.fail('Synthetic ready member has no finalize mutation');
    },
  };
  const transfer = {
    async pick() {
      const file = { localId: `emitted-batch-${++picks}` };
      files.add(file);
      peakFiles = Math.max(peakFiles, files.size);
      return file;
    },
    async inspect() {
      return {
        mime: 'image/png',
        bytes: 100,
        sha256: 'a'.repeat(64),
        width: 10,
        height: 10,
        frameCount: 1,
      };
    },
    async remove(file) {
      files.delete(file);
    },
    clearSession() {},
    register() {
      assert.fail('No grant should be registered');
    },
    async upload() {
      assert.fail('Metadata smoke must not fabricate byte transfer');
    },
  };
  const community = {
    ...original.gateway,
    async capabilities() {
      return {
        publish: { availability: 'allowed', reason: null },
        authorModes: ['named', 'anonymous'],
        canDisableComments: false,
        mediaAvailability: 'unavailable',
        postImageLimit: 9,
        commentImageLimit: 3,
        commentRules: {
          unverifiedRequiresNamed: true,
          ownAnonymousPostForcesAnonymous: true,
        },
      };
    },
    async receipt() {
      if (!receipt)
        throw new ClientError('http', 'Original receipt not recorded', {
          serverCode: 'REQUEST_NOT_FOUND',
        });
      return receipt;
    },
    async publishPost(payload) {
      publishes++;
      assert.equal(mode, 'sealed');
      assert.equal(payload.clientRequestId, publication.clientRequestId);
      assert.deepEqual(
        payload.imageAssetIds,
        members.map((member) => member.assetId),
      );
      receipt = {
        requestId: payload.clientRequestId,
        operation: 'publish_post',
        outcome: 'created',
        resourceId: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      members = members.map((member) => ({
        ...member,
        observation: {
          version: 2,
          intentId: member.intentId,
          requestId: member.requestId,
          requestHash: member.requestHash,
          serverNow: Date.now(),
          status: 'bound_history',
          assetId: member.assetId,
          bindingId: randomUUID(),
          publication,
          attachmentState: 'active',
        },
      }));
      mode = 'bound';
      return receipt;
    },
  };
  const record = pending.freeze(actor, identity, Date.now());
  observeBatch(pending, record, status(), Date.now());
  let page;
  try {
    assert.equal(
      original.mediaBatch,
      undefined,
      'Formal runtime must not install a batch uploader',
    );
    const template = readFileSync(
      path.join(dist, 'pages/community-compose/community-compose.wxml'),
      'utf8',
    );
    assert.match(
      template,
      /<view wx:if="\{\{batchMode\}\}" class="media-batch">/,
    );
    assert.match(template, /wx:for="\{\{mediaMembers\}\}" wx:key="memberId"/);
    assert.match(
      template,
      /<view wx:elif="\{\{canSelectImage\}\}"><button bindtap="onSelectImage"/,
    );
    for (const event of [
      'onSelectImage',
      'onMoveImage',
      'onRemoveImage',
      'onReplaceImage',
      'onRecoverImage',
      'onCancelImage',
    ])
      assert.match(template, new RegExp(`bindtap="${event}"`));
    app.community.mediaUpload = undefined;
    app.community.gateway = community;
    app.community.pending = publicationPending;
    app.community.newRequestId = async () => randomUUID();
    app.community.profiles = {
      async profile() {
        return {
          accountId: actor,
          preferences: {
            defaultCommentAnonymousEnabled: false,
            defaultCommentNonAnonymousEnabled: false,
          },
        };
      },
    };
    app.community.mediaBatch = createMediaBatchRuntime({
      sessions,
      pending,
      publicationPending,
      community,
      gateway,
      transfer,
      clock: systemClock,
      newRequestId: app.community.newRequestId,
      privateViews: app.community.privateViews,
    });
    page = mountPage(
      path.join(dist, 'pages/community-compose/community-compose.js'),
      { spaceId, category: 'discussion' },
    );
    const wait = observe(page);
    await wait(
      (view) =>
        view.loaded &&
        !view.busy &&
        !view.mediaBusy &&
        view.mediaSelected === 2,
    );
    assert.equal(page.data.batchMode, true);
    assert.equal(page.data.mediaReady, 2);
    const first = members[0].memberId;
    page.onMoveImage({
      currentTarget: { dataset: { id: first, direction: 1 } },
    });
    await wait(
      (view) => !view.mediaBusy && view.mediaMembers[1]?.memberId === first,
    );
    assert.equal(members[1].sourceSlot, 0);
    page.onRemoveImage({ currentTarget: { dataset: { id: first } } });
    await wait((view) => !view.mediaBusy && view.mediaSelected === 1);
    assert.equal(pending.load(actor).retiring.length, 0);
    page.onSelectImage();
    await wait((view) => !view.mediaBusy && view.mediaSelected === 2);
    const replaced = members[0].memberId;
    page.onReplaceImage({ currentTarget: { dataset: { id: replaced } } });
    await wait(
      (view) =>
        !view.mediaBusy &&
        view.mediaSelected === 2 &&
        !view.mediaMembers.some((member) => member.memberId === replaced),
    );
    assert.equal(picks, 2);
    assert.equal(peakFiles, 1);
    assert.equal(files.size, 0);
    page.onText({ detail: { value: 'Emitted complete batch publication.' } });
    assert.equal(page.data.canSubmit, true);
    page.onSubmit();
    await wait((view) => !view.busy && view.receiptStatus === '发布已确认');
    assert.equal(publishes, 1);
    assert.equal(pending.load(actor), null);
    assert.equal(publicationPending.load(actor), null);
  } finally {
    page?.onUnload();
    Object.assign(app.community, original);
  }
  console.log(
    'Media batch emitted smoke passed: distinct legacy/batch WXML, actual Page add/reorder/remove/replace handlers, one-file selection, full-plan seal before publish and both-key settlement. Metadata-only synthetic server/transfer DI; no device, native-byte or PG claim.',
  );
}
