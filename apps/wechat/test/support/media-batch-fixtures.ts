import { ClientError } from '../../src/api/errors';
import {
  PendingAttemptStore,
  type PendingAttempt,
} from '../../src/community/pending-attempt';
import { decodeReceipt, type Receipt } from '../../src/community/contract';
import {
  attachmentPlanDigest,
  batchEqual,
  batchRequestHash,
  decodeBatchStatus,
  decodeMemberStatus,
  memberRequestHash,
  type BatchCommand,
  type BatchGateway,
  type BatchIdentity,
  type BatchStatus,
  type MemberPrepare,
  type MemberStatus,
} from '../../src/media/batch-contracts';
import { PendingBatchStore } from '../../src/media/batch-pending';
import {
  createMediaBatchRuntime,
  observeBatch,
} from '../../src/media/batch-runtime';
import type { UploadTransfer } from '../../src/media/upload-contracts';
import { FakeClock, MemoryStorage, signedIn } from '../helpers';
import { ids, origin } from './media-upload-fixtures';
export { ids, origin };
export const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const identity: BatchIdentity = {
  version: 1,
  batchRequestId: uuid(1),
  draftId: ids.draft,
  spaceId: ids.space,
  purpose: 'community-post-images',
};
export const memberPrepare = (n: number): MemberPrepare => ({
  clientRequestId: uuid(100 + n),
  memberId: uuid(200 + n),
  sourceSlot: n,
  declaration: { mime: 'image/png', bytes: 100, sha256: 'a'.repeat(64) },
});
export function memberStatus(
  prepare: MemberPrepare,
  phase:
    'prepared' | 'uploaded' | 'ready_unbound' | 'terminal' = 'ready_unbound',
  batchIdentity = identity,
): MemberStatus {
  const requestHash = memberRequestHash(ids.actor, batchIdentity, prepare),
    intentId = uuid(300 + prepare.sourceSlot),
    assetId = uuid(400 + prepare.sourceSlot);
  return decodeMemberStatus({
    version: 3,
    batchId: uuid(2),
    memberId: prepare.memberId,
    sourceSlot: prepare.sourceSlot,
    prepare,
    requestId: prepare.clientRequestId,
    requestHash,
    intentId,
    assetId: phase === 'ready_unbound' ? assetId : null,
    manifestDigest: phase === 'ready_unbound' ? 'b'.repeat(64) : null,
    observation: {
      version: 2,
      requestId: prepare.clientRequestId,
      requestHash,
      intentId,
      serverNow: 1000,
      ...(phase === 'prepared'
        ? { status: phase, upload: 'none', operationDeadlineAt: 9000 }
        : phase === 'uploaded'
          ? { status: phase, operationDeadlineAt: 9000 }
          : phase === 'terminal'
            ? { status: phase, reason: 'cancelled', cleanup: 'pending' }
            : {
                status: phase,
                assetId,
                readyRetentionUntil: 90000,
                draftExpiresAt: 80000,
                bindBefore: 80000,
                mediaProof: 'current',
              }),
    },
  });
}
export function readyBatch(
  count = 3,
): Extract<BatchStatus, { status: 'ready_unbound' }> {
  const members = Array.from({ length: count }, (_, n) =>
    memberStatus(memberPrepare(n)),
  );
  return decodeBatchStatus({
    version: 3,
    batchIdentity: identity,
    batchRequestId: identity.batchRequestId,
    batchRequestHash: batchRequestHash(ids.actor, identity),
    batchId: uuid(2),
    revision: String(1 + count),
    serverNow: 1000,
    members,
    retiring: [],
    orderedMemberIds: members.map((m) => m.memberId),
    status: 'ready_unbound',
    orderedAssets: members.map((m) => ({
      memberId: m.memberId,
      assetId: m.assetId,
      manifestDigest: m.manifestDigest,
    })),
    draftExpiresAt: 80000,
    bindBefore: 80000,
  }) as Extract<BatchStatus, { status: 'ready_unbound' }>;
}
export function attempt(status = readyBatch()): PendingAttempt {
  return {
    version: 1,
    accountId: ids.actor,
    operation: 'publish_post',
    payload: {
      clientRequestId: ids.publication,
      spaceId: ids.space,
      category: 'discussion',
      text: 'Original body stays only in Community storage.',
      imageAssetIds: status.orderedAssets.map((a) => a.assetId),
      authorMode: 'named',
      commentsPolicy: 'open',
    },
  };
}
export function created(): Receipt {
  return decodeReceipt({
    requestId: ids.publication,
    operation: 'publish_post',
    outcome: 'created',
    resourceId: uuid(900),
    createdAt: '2026-10-10T10:00:00.000Z',
  });
}
export function history(
  status: Extract<BatchStatus, { status: 'publication_pending' }>,
): Extract<BatchStatus, { status: 'bound_history' }> {
  return decodeBatchStatus({
    ...status,
    members: status.members.map((m, ordinal) => ({
      ...m,
      observation: {
        version: 2,
        requestId: m.requestId,
        requestHash: m.requestHash,
        intentId: m.intentId,
        serverNow: 1000,
        status: 'bound_history',
        assetId: m.assetId,
        bindingId: uuid(700 + ordinal),
        publication: status.publication,
        attachmentState: 'detached',
      },
    })),
    status: 'bound_history',
    parent: {
      ownerKind: 'community',
      resourceKind: 'post',
      resourceId: uuid(900),
      contentVersion: 1,
    },
    bindings: status.orderedAssets.map((a, ordinal) => ({
      ...a,
      bindingId: uuid(700 + ordinal),
      ordinal,
      attachmentState: 'detached',
    })),
  }) as Extract<BatchStatus, { status: 'bound_history' }>;
}
export function batchHarness(count = 3) {
  const storage = new MemoryStorage(),
    sessions = signedIn(ids.actor),
    clock = new FakeClock();
  const pending = new PendingBatchStore(storage, origin),
    publicationPending = new PendingAttemptStore(storage, origin),
    calls: string[] = [];
  let state: BatchStatus = readyBatch(count),
    receipt: Receipt | null = null,
    sequence = 1000;
  const current = () => state;
  const archived: MemberStatus[] = [];
  const commands = new Map<
    string,
    { command: BatchCommand; result: BatchStatus }
  >();
  const gateway: BatchGateway = {
    async prepare(input) {
      calls.push('prepare');
      if (!batchEqual(input, state.batchIdentity)) throw new Error('identity');
      return state;
    },
    async recover() {
      calls.push('recover');
      return { version: 3, state: 'recorded', status: state };
    },
    async recoverPublication() {
      calls.push('recover-publication');
      return { version: 3, state: 'recorded', status: state };
    },
    async cancel() {
      calls.push('cancel');
      throw new Error('Override cancel for cancellation fixture');
    },
    async command(_id, command) {
      calls.push(command.kind);
      const cached = commands.get(command.payload.commandId);
      if (cached) {
        if (!batchEqual(cached.command, command))
          throw new Error('command-conflict');
        return cached.result;
      }
      if (state.revision !== command.payload.expectedRevision)
        throw new ClientError('business', 'Revision conflict');
      if (command.kind === 'seal') {
        if (
          state.status !== 'ready_unbound' ||
          !batchEqual(command.payload.orderedMemberIds, state.orderedMemberIds)
        )
          throw new Error('partial seal');
        const { draftExpiresAt, bindBefore, ...base } = state;
        if (draftExpiresAt <= 0 || bindBefore <= 0)
          throw new Error('Invalid ready deadlines');
        state = decodeBatchStatus({
          ...base,
          status: 'publication_pending',
          revision: String(BigInt(state.revision) + 1n),
          publication: command.payload.publication,
          attachmentPlanDigest: attachmentPlanDigest(
            state.batchId!,
            String(BigInt(state.revision) + 1n),
            state.orderedAssets,
          ),
        });
      } else if (command.kind === 'layout') {
        const source = state;
        const members = command.payload.orderedMemberIds.map((id) =>
          source.members.find((m) => m.memberId === id)!,
        );
        const retiring = source.members
          .filter((m) => command.payload.removeMemberIds.includes(m.memberId))
          .map((m) => ({
            ...m,
            observation: {
              version: 2 as const,
              requestId: m.requestId,
              requestHash: m.requestHash,
              intentId: m.intentId,
              serverNow: 1000,
              status: 'terminal' as const,
              reason: 'cancelled' as const,
              cleanup: 'pending' as const,
            },
          }));
        archived.push(...retiring);
        state = decodeBatchStatus({
          version: 3,
          batchIdentity: source.batchIdentity,
          batchRequestId: source.batchRequestId,
          batchRequestHash: source.batchRequestHash,
          batchId: source.batchId,
          revision: String(BigInt(source.revision) + 1n),
          serverNow: 1000,
          orderedMemberIds: command.payload.orderedMemberIds,
          members,
          retiring: [],
          status: members.length ? 'ready_unbound' : 'editing',
          ...(members.length
            ? {
                orderedAssets: members.map((m) => ({
                  memberId: m.memberId,
                  assetId: m.assetId,
                  manifestDigest: m.manifestDigest,
                })),
                draftExpiresAt: 80000,
                bindBefore: 80000,
              }
            : {}),
        });
      } else throw new Error('Override reopen for rejection fixture');
      commands.set(command.payload.commandId, { command, result: state });
      return state;
    },
    async fencePublication() {
      throw new Error('Explicit cancellation not expected');
    },
    async prepareMember(_id, input) {
      calls.push('member-prepare');
      return memberStatus(input, 'ready_unbound', state.batchIdentity!);
    },
    async memberStatus(id) {
      calls.push('member-status');
      const member = [...state.members, ...state.retiring, ...archived].find(
        (m) => m.intentId === id,
      );
      if (!member) throw new Error('missing member');
      return member;
    },
    async grant() {
      throw new Error('No bytes expected for ready fixtures');
    },
    async finalize() {
      throw new Error('No finalize expected');
    },
  };
  const community = {
    async receipt() {
      calls.push('receipt');
      if (!receipt)
        throw new ClientError('business', 'Missing receipt', {
          serverCode: 'REQUEST_NOT_FOUND',
          httpStatus: 404,
        });
      return receipt;
    },
  };
  const transfer: UploadTransfer = {
    async pick() {
      calls.push('pick');
      return { localId: 'one-file' };
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
    register() {
      return { handle: 'one-grant' };
    },
    async upload() {
      throw new Error('Override byte fixture');
    },
    clearSession() {},
    async remove() {
      calls.push('remove-file');
    },
  };
  const options = {
    sessions,
    pending,
    publicationPending,
    community,
    clock,
    gateway,
    transfer,
    newRequestId: async () => uuid(sequence++),
  };
  const runtime = createMediaBatchRuntime(options),
    views: import('../../src/media/batch-controller').BatchView[] = [],
    controller = runtime.create((view) => views.push(view));
  let record = pending.freeze(ids.actor, identity, clock.now());
  record = observeBatch(pending, record, state, clock.now());
  return {
    storage,
    sessions,
    clock,
    pending,
    publicationPending,
    calls,
    gateway,
    community,
    transfer,
    options,
    runtime,
    controller,
    current,
    views,
    setState(value: BatchStatus) {
      state = value;
    },
    setReceipt(value: Receipt | null) {
      receipt = value;
    },
    record,
  };
}
