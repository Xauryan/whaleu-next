import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  StudentVerificationController,
  initialStudentView,
} from '../src/verification/student-controller';
import type { StudentEvidenceRuntime } from '../src/verification/student-controller';
import { StudentCommandJournal } from '../src/verification/student-pending';
import {
  decodeStudentApplication,
  decodeStudentQueue,
  decodeStudentReceipt,
  studentCommandHash,
} from '../src/verification/student-contract';
import type { StudentApplication } from '../src/verification/student-contract';
import type { HttpStudentVerificationGateway } from '../src/verification/student-gateway';
import type { ProfileGateway } from '../src/profile/gateway';
import type { VerificationEvidenceReadView } from '../src/verification/evidence-runtime';
import { wireCredentials } from './identity-helpers';
const region = randomUUID(),
  campusId = randomUUID(),
  applicationId = randomUUID(),
  profileId = randomUUID();
const application = (): StudentApplication => ({
  id: applicationId,
  revision: 2,
  state: 'pending',
  campusId,
  campusName: 'Synthetic campus',
  institutionName: 'Synthetic institution',
  regionId: region,
  profileId,
  submittedAt: new Date(1800000000000).toISOString(),
  reason: null,
  evidenceRevision: 1,
  evidenceAvailable: true,
  evidenceExpiresAt: new Date(1900000000000).toISOString(),
});
function fixture() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const values = new Map<string, unknown>(),
    storage = {
      get: (k: string) => values.get(k),
      set: (k: string, v: unknown) => {
        values.set(k, structuredClone(v));
      },
      remove: (k: string) => {
        values.delete(k);
      },
    },
    journal = new StudentCommandJournal(storage, 'https://example.invalid'),
    privateViews = new PrivateViewLifecycle();
  let view = initialStudentView(),
    readerRender!: (v: VerificationEvidenceReadView) => void,
    readerEpoch = 0;
  const media = {
    reconcile: async () => undefined,
    createUploader: () => ({
      clear() {},
      dispose() {},
      pick: async () => null,
      recover: async () => null,
    }),
    createReader: (render: (v: VerificationEvidenceReadView) => void) => {
      readerRender = render;
      return {
        clear() {
          readerEpoch++;
          render({ status: 'idle', src: '', message: '' });
        },
        dispose() {
          readerEpoch++;
        },
        load: async () => {
          render({
            status: 'ready',
            src: 'wxfile://tmp/private-synthetic',
            message: '',
          });
        },
      };
    },
  } as unknown as StudentEvidenceRuntime;
  const gateway = {
    capabilities: async () => ({
      management: 'fixed',
      region: { id: region, name: 'Synthetic region' },
    }),
    queue: async (
      _r: string,
      page: number,
      _c: unknown,
      cursor: string | null,
    ) => ({
      items: [application()],
      page,
      hasNext: cursor === null,
      nextCursor: cursor === null ? applicationId : null,
    }),
    detail: async () => application(),
    regions: async () => [{ id: randomUUID(), name: 'Other region' }],
  } as unknown as HttpStudentVerificationGateway;
  const profiles = {
    campuses: async () => ({
      items: [
        {
          id: campusId,
          institutionId: '00001',
          institutionName: 'Synthetic',
          fullName: 'Synthetic campus',
          shortName: null,
          district: 'Synthetic',
          isActive: true,
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    }),
  } as unknown as ProfileGateway;
  const controller = new StudentVerificationController(
    {
      sessions,
      gateway,
      profiles,
      journal,
      newRequestId: async () => randomUUID(),
      media,
      privateViews,
      render: (v) => {
        view = v;
      },
    },
    'review',
  );
  return {
    controller,
    sessions,
    gateway,
    journal,
    values,
    privateViews,
    view: () => view,
    readerEpoch: () => readerEpoch,
    late: (epoch: number) => {
      if (epoch === readerEpoch)
        readerRender({
          status: 'ready',
          src: 'wxfile://tmp/late-private',
          message: '',
        });
    },
  };
}
test('student detail and receipt reject extra identity/material fields; queue cursor is explicit', () => {
  assert.deepEqual(decodeStudentApplication(application()), application());
  for (const key of [
    'imageUrl',
    'studentNumber',
    'realName',
    'bucket',
    'accountId',
  ])
    assert.throws(() =>
      decodeStudentApplication({ ...application(), [key]: 'private' }),
    );
  assert.throws(() =>
    decodeStudentReceipt({
      requestId: randomUUID(),
      applicationId,
      revision: 2,
      state: 'approved',
      evidence: 'hidden',
    }),
  );
  assert.throws(() =>
    decodeStudentQueue({ items: [], page: 1, hasNext: true, nextCursor: null }),
  );
  assert.equal(
    decodeStudentQueue({
      items: [],
      page: 1,
      hasNext: true,
      nextCursor: applicationId,
    }).nextCursor,
    applicationId,
  );
});
test('journal stores only original command identity; never a rejection reason or material payload', () => {
  const f = fixture(),
    actor = wireCredentials().accountId,
    record = {
      actor,
      requestId: randomUUID(),
      applicationId,
      operation: 'decide' as const,
      requestHash: studentCommandHash(['synthetic']),
    };
  f.journal.save(record);
  assert.deepEqual(f.journal.read(actor), record);
  assert.equal(
    JSON.stringify([...f.values.values()]).includes('reason'),
    false,
  );
  assert.throws(() => f.journal.save(record));
  f.journal.clear(record);
  assert.equal(f.journal.read(actor), null);
  f.controller.dispose();
});
test('review reload clears private file, reason and selected application before an authority failure', async () => {
  const f = fixture();
  await f.controller.load();
  await f.controller.select(applicationId);
  await f.controller.preview();
  f.controller.setReason('Synthetic private review reason');
  assert.ok(f.view().evidenceSrc);
  const epoch = f.readerEpoch();
  let reject!: (e: unknown) => void;
  f.gateway.capabilities = () => new Promise((_r, j) => (reject = j));
  const load = f.controller.load();
  assert.equal(f.view().evidenceSrc, '');
  assert.equal(f.view().application, null);
  assert.equal(f.view().reason, '');
  await new Promise((resolve) => setImmediate(resolve));
  reject(Error('revoked'));
  await load;
  f.late(epoch);
  assert.equal(f.view().evidenceSrc, '');
  assert.deepEqual(f.view().items, []);
  f.controller.dispose();
});
test('super-admin school switch clears old private bytes and pending callbacks immediately', async () => {
  const f = fixture();
  f.gateway.capabilities = async () => ({ management: 'global', region: null });
  await f.controller.load();
  await f.controller.searchCampuses();
  f.controller.chooseCampus(campusId);
  await new Promise<void>((r) => setTimeout(r, 0));
  await f.controller.select(applicationId);
  await f.controller.preview();
  f.controller.setReason('Previous reason');
  const epoch = f.readerEpoch();
  f.gateway.regions = () => new Promise(() => undefined);
  f.controller.chooseCampus(campusId);
  assert.equal(f.view().evidenceSrc, '');
  assert.equal(f.view().application, null);
  assert.equal(f.view().reason, '');
  assert.deepEqual(f.view().items, []);
  f.late(epoch);
  assert.equal(f.view().evidenceSrc, '');
  f.controller.dispose();
});
test('hide/account switch clears review state and immutable cursor navigation does not use row offsets', async () => {
  const f = fixture(),
    cursors: (string | null)[] = [];
  const original = f.gateway.queue.bind(f.gateway);
  f.gateway.queue = async (r, p, c, cursor = null) => {
    cursors.push(cursor);
    return original(r, p, c, cursor);
  };
  await f.controller.load();
  f.controller.page(1);
  await new Promise<void>((r) => setTimeout(r, 0));
  assert.deepEqual(cursors, [null, applicationId]);
  await f.controller.select(applicationId);
  await f.controller.preview();
  f.privateViews.clear();
  assert.equal(f.view().evidenceSrc, '');
  assert.equal(f.view().application, null);
  assert.equal(f.view().reason, '');
  await f.controller.load();
  assert.equal(f.view().loaded, false);
  f.controller.dispose();
});
