import { ClientError } from '../../src/api/errors';
import type { MediaSession } from '../../src/media/contracts';
import { PendingMediaStore } from '../../src/media/pending';
import {
  MediaUploadController,
  type MediaPublicationOwner,
} from '../../src/media/upload-controller';
import {
  decodeUploadStatus,
  uploadRequestHash,
  type InspectedUpload,
  type UploadGateway,
  type UploadGrant,
  type UploadObserved,
  type UploadPrepare,
  type UploadRecovery,
  type UploadStatus,
  type UploadTransfer,
} from '../../src/media/upload-contracts';
import { FakeClock, MemoryStorage, signedIn } from '../helpers';
export const ids = {
  actor: '11111111-1111-4111-8111-111111111111',
  other: '22222222-2222-4222-8222-222222222222',
  request: '33333333-3333-4333-8333-333333333333',
  intent: '44444444-4444-4444-8444-444444444444',
  draft: '55555555-5555-4555-8555-555555555555',
  space: '66666666-6666-4666-8666-666666666666',
  grant: '77777777-7777-4777-8777-777777777777',
  asset: '88888888-8888-4888-8888-888888888888',
  binding: '99999999-9999-4999-8999-999999999999',
  publication: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
export const origin = 'https://media-upload.invalid';
export const prepare: UploadPrepare = {
  clientRequestId: ids.request,
  purpose: 'community-post-image',
  draftId: ids.draft,
  spaceId: ids.space,
  slot: 'images',
  ordinal: 0,
  declaration: { mime: 'image/png', bytes: 100, sha256: 'a'.repeat(64) },
};
export const hash = uploadRequestHash(ids.actor, prepare);
const base = {
  version: 2,
  intentId: ids.intent,
  requestId: ids.request,
  requestHash: hash,
  serverNow: 1000,
};
export function prepared(
  upload: 'none' | 'in_flight' | 'reconcile_needed' = 'none',
): UploadStatus {
  return decodeUploadStatus({
    ...base,
    status: 'prepared',
    operationDeadlineAt: 1801000,
    upload,
  });
}
export function uploaded(): UploadStatus {
  return decodeUploadStatus({
    ...base,
    status: 'uploaded',
    operationDeadlineAt: 1801000,
  });
}
export function ready(): UploadStatus {
  return decodeUploadStatus({
    ...base,
    status: 'ready_unbound',
    assetId: ids.asset,
    readyRetentionUntil: 86401000,
    draftExpiresAt: 86001000,
    bindBefore: 86001000,
    mediaProof: 'current',
  });
}
export function terminal(): UploadStatus {
  return decodeUploadStatus({
    ...base,
    status: 'terminal',
    reason: 'cancelled',
    cleanup: 'retained',
  });
}
export function bound(): UploadStatus {
  return decodeUploadStatus({
    ...base,
    status: 'bound_history',
    assetId: ids.asset,
    bindingId: ids.binding,
    publication: null,
    attachmentState: 'detached',
  });
}
export function recovery(status: UploadStatus): UploadRecovery {
  if (status.status === 'bound_history')
    return {
      version: 2,
      requestId: ids.request,
      requestHash: hash,
      serverNow: 1000,
      state: 'bound_history',
      status,
    };
  if (status.status === 'terminal')
    return {
      version: 2,
      requestId: ids.request,
      requestHash: hash,
      serverNow: 1000,
      state: 'terminal',
      reason: status.reason,
      status,
    };
  return {
    version: 2,
    requestId: ids.request,
    requestHash: hash,
    serverNow: 1000,
    state: 'active',
    status,
  };
}
export const notRecorded: UploadRecovery = {
  version: 2,
  requestId: ids.request,
  requestHash: null,
  serverNow: 1000,
  state: 'not_recorded',
};
export const grant: UploadGrant = {
  version: 1,
  strategy: 'authenticated-multipart-v1',
  intentId: ids.intent,
  generation: '9007199254740993',
  grantId: ids.grant,
  method: 'POST',
  fieldName: 'file',
  maxBytes: 5242880,
  expectedBytes: 100,
  expectedMime: 'image/png',
  expectedSha256: 'a'.repeat(64),
  grantExpiresAt: 100000,
  operationDeadlineAt: 1801000,
  serverNow: 1000,
};
export const observed: UploadObserved = {
  version: 2,
  status: 'uploadObserved',
  intentId: ids.intent,
  generation: grant.generation,
  grantId: ids.grant,
  bytes: 100,
  sha256: 'a'.repeat(64),
  next: 'finalize',
};
export function uploadHarness(publication?: MediaPublicationOwner) {
  const sessions = signedIn(ids.actor),
    storage = new MemoryStorage(),
    pending = new PendingMediaStore(storage, origin),
    clock = new FakeClock();
  const calls: string[] = [];
  const actors: string[] = [];
  let state: UploadRecovery = notRecorded;
  let inspect: InspectedUpload = {
    ...prepare.declaration,
    width: 80,
    height: 60,
    frameCount: 'unknown',
  };
  let prepareFailure = false,
    finalizeFailure = false,
    cancelFailure = false;
  const before = (name: string, session: MediaSession) => {
    calls.push(name);
    actors.push(session.current().credentials!.accountId);
  };
  const gateway: UploadGateway = {
    async prepare(input, session) {
      before('prepare', session);
      if (input.clientRequestId !== ids.request)
        throw new Error('Unexpected key');
      state = recovery(prepared());
      if (prepareFailure)
        throw new ClientError('network', 'Lost prepare response');
      return prepared();
    },
    async recover(_requestId, session) {
      before('recover', session);
      return state;
    },
    async status(_intentId, session) {
      before('status', session);
      if (state.state === 'not_recorded' || !state.status)
        throw new Error('Missing status');
      return state.status;
    },
    async grant(_intentId, session) {
      before('grant', session);
      return grant;
    },
    async finalize(_intentId, session) {
      before('finalize', session);
      state = recovery(ready());
      if (finalizeFailure)
        throw new ClientError('network', 'Lost finalize response');
      return ready();
    },
    async cancelRequest(_requestId, _hash, session) {
      before('cancel', session);
      if (cancelFailure) throw new ClientError('network', 'Offline cancel');
      if (state.state === 'bound_history') return state;
      state = recovery(terminal());
      return state;
    },
  };
  const file = Object.freeze({ localId: 'test-original' });
  const transfer: UploadTransfer = {
    async pick() {
      calls.push('pick');
      return file;
    },
    async inspect() {
      calls.push('inspect');
      return inspect;
    },
    register() {
      calls.push('register');
      return Object.freeze({ handle: 'fixture-grant' });
    },
    async upload(_plan, _file, progress) {
      calls.push('upload');
      progress(100);
      state = recovery(uploaded());
      return observed;
    },
    clearSession() {
      calls.push('clear');
    },
    async remove() {
      calls.push('remove');
    },
  };
  const create = () =>
    new MediaUploadController(
      sessions,
      pending,
      gateway,
      transfer,
      clock,
      async () => ids.request,
      () => undefined,
      publication,
    );
  return {
    sessions,
    storage,
    pending,
    clock,
    calls,
    actors,
    gateway,
    transfer,
    create,
    controller: create(),
    setState(value: UploadRecovery) {
      state = value;
    },
    getState() {
      return state;
    },
    setInspect(value: InspectedUpload) {
      inspect = value;
    },
    failPrepare() {
      prepareFailure = true;
    },
    failFinalize() {
      finalizeFailure = true;
    },
    failCancel() {
      cancelFailure = true;
    },
  };
}
