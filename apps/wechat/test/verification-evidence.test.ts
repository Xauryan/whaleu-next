import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
  decodeVerificationEvidencePrepare,
  decodeVerificationEvidenceDescriptor,
  decodeVerificationEvidenceGrant,
  verificationEvidencePrepareHash,
  evidenceUploadDescriptor,
} from '../src/verification/evidence-contract';
import { VerificationEvidencePending } from '../src/verification/evidence-pending';
import type { Storage } from '../src/platform/contracts';
const actor = randomUUID();
const prepare = () => ({
  protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
  clientRequestId: randomUUID(),
  applicationId: randomUUID(),
  revision: 1,
  declaration: { mime: 'image/png', bytes: 128, sha256: 'a'.repeat(64) },
});
test('private evidence has closed typed upload and descriptor surfaces', () => {
  const raw = prepare();
  assert.deepEqual(decodeVerificationEvidencePrepare(raw), raw);
  for (const key of [
    'imageUrl',
    'signedUrl',
    'bucket',
    'slot',
    'studentNumber',
  ])
    assert.throws(() =>
      decodeVerificationEvidencePrepare({ ...raw, [key]: 'synthetic' }),
    );
  const ref = {
    protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
    kind: 'verification-evidence',
    applicationId: raw.applicationId,
    revision: 1,
    bindingId: randomUUID(),
    width: 200,
    height: 120,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.equal(
    decodeVerificationEvidenceDescriptor(ref).applicationId,
    raw.applicationId,
  );
  assert.throws(() =>
    decodeVerificationEvidenceDescriptor({
      ...ref,
      url: 'https://example.invalid',
    }),
  );
  assert.throws(() =>
    decodeVerificationEvidenceDescriptor({
      ...ref,
      kind: 'announcement-media',
    }),
  );
  assert.equal(
    evidenceUploadDescriptor(randomUUID()).kind,
    'verification-evidence-upload',
  );
});
test('native request hashing is canonical and domain separated', () => {
  const raw = decodeVerificationEvidencePrepare(prepare());
  const expected = createHash('sha256')
    .update('whaleu-verification-evidence-media-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
        actorAccountId: actor,
        clientRequestId: raw.clientRequestId,
        applicationId: raw.applicationId,
        revision: raw.revision,
        declaration: raw.declaration,
      }),
    )
    .digest('hex');
  assert.equal(verificationEvidencePrepareHash(actor, raw), expected);
  assert.notEqual(verificationEvidencePrepareHash(randomUUID(), raw), expected);
});
test('private evidence rejects another upload protocol before transport', () => {
  assert.throws(() =>
    decodeVerificationEvidenceGrant({ protocol: 'announcement-media-v1' }),
  );
});
function memory() {
  const values = new Map<string, unknown>();
  const storage: Storage = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
  return { values, storage };
}
test('journal contains only original operation identities, never file declarations or paths', () => {
  const { storage, values } = memory(),
    pending = new VerificationEvidencePending(
      storage,
      'https://example.invalid',
    );
  const raw = prepare(),
    record = {
      actor,
      applicationId: raw.applicationId,
      revision: 1,
      requestId: raw.clientRequestId,
      requestHash: verificationEvidencePrepareHash(actor, raw),
    };
  pending.write(record);
  assert.deepEqual(pending.readAll(actor), [record]);
  const encoded = JSON.stringify([...values.values()]);
  for (const secret of [
    'declaration',
    'sha256',
    'imageUrl',
    'tempFilePath',
    'studentNumber',
    'mime',
    'bytes',
  ])
    assert.equal(encoded.includes(secret), false);
  const other = randomUUID();
  assert.deepEqual(pending.readAll(other), []);
  pending.clear(record);
  assert.deepEqual(pending.readAll(actor), []);
});
test('all-account journal can drain twenty old scopes and reuse capacity', () => {
  const { storage } = memory(),
    pending = new VerificationEvidencePending(
      storage,
      'https://example.invalid',
    );
  for (let i = 0; i < 20; i++)
    pending.write({
      actor,
      applicationId: randomUUID(),
      revision: 1,
      requestId: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
  assert.equal(pending.readAll(actor).length, 20);
  assert.throws(() =>
    pending.write({
      actor,
      applicationId: randomUUID(),
      revision: 1,
      requestId: randomUUID(),
      requestHash: 'b'.repeat(64),
    }),
  );
  for (const entry of pending.readAll(actor)) pending.clear(entry);
  pending.write({
    actor,
    applicationId: randomUUID(),
    revision: 1,
    requestId: randomUUID(),
    requestHash: 'b'.repeat(64),
  });
  assert.equal(pending.readAll(actor).length, 1);
});

import { SessionStore } from '../src/auth/session';
import { VerificationEvidenceUploader } from '../src/verification/evidence-runtime';
import type { HttpVerificationEvidenceGateway } from '../src/verification/evidence-gateway';
import type { VerificationEvidenceUpload } from '../src/verification/evidence-upload';
import type { VerificationEvidenceUploadView } from '../src/verification/evidence-runtime';
function uploaderFixture(gateway: Record<string, unknown>) {
  const { storage } = memory(),
    pending = new VerificationEvidencePending(
      storage,
      'https://example.invalid',
    ),
    sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), {
    accountId: actor,
    sessionId: randomUUID(),
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
    expiresAt: 100000,
    refreshExpiresAt: 200000,
  });
  const views: VerificationEvidenceUploadView[] = [];
  let picks = 0;
  const upload = {
    pick: async () => {
      picks++;
      throw Error('Picker must not run');
    },
    remove: async () => undefined,
  } as unknown as VerificationEvidenceUpload;
  const uploader = new VerificationEvidenceUploader(
    sessions,
    pending,
    gateway as unknown as HttpVerificationEvidenceGateway,
    upload,
    async () => randomUUID(),
    (view) => views.push(view),
  );
  return { pending, sessions, uploader, views, picks: () => picks };
}
test('recover automatically closes twenty old account scopes using original request keys', async () => {
  const seen: string[] = [],
    f = uploaderFixture({
      cancelRequest: async (requestId: string, requestHash: string) => {
        seen.push(requestId);
        return {
          protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
          requestId,
          requestHash,
          serverNow: 100,
          state: 'cancelled_before_prepare',
          reason: 'cancelled',
        };
      },
    });
  for (let i = 0; i < 20; i++)
    f.pending.write({
      actor,
      applicationId: randomUUID(),
      revision: 1,
      requestId: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
  assert.equal(
    await f.uploader.recover({ applicationId: randomUUID(), revision: 1 }),
    null,
  );
  assert.equal(seen.length, 20);
  assert.equal(f.pending.readAll(actor).length, 0);
  assert.equal(f.picks(), 0);
  f.uploader.dispose();
});
test('not-recorded prepare uncertainty is fenced at original key without persisting or replaying material declaration', async () => {
  const record = {
    actor,
    applicationId: randomUUID(),
    revision: 1,
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
  };
  let cancelled = 0;
  const f = uploaderFixture({
    recover: async () => ({ state: 'not_recorded', requestHash: null }),
    cancelRequest: async (requestId: string, requestHash: string) => {
      assert.equal(requestId, record.requestId);
      assert.equal(requestHash, record.requestHash);
      cancelled++;
      return { state: 'cancelled_before_prepare' };
    },
  });
  f.pending.write(record);
  assert.equal(await f.uploader.recover(record), null);
  assert.equal(cancelled, 1);
  assert.equal(f.pending.readAll(actor).length, 0);
  assert.equal(f.picks(), 0);
  f.uploader.dispose();
});
test('ready original request returns only typed submit reference without choosing or retransmitting bytes', async () => {
  const record = {
      actor,
      applicationId: randomUUID(),
      revision: 1,
      requestId: randomUUID(),
      requestHash: 'a'.repeat(64),
    },
    assetId = randomUUID();
  const f = uploaderFixture({
    recover: async () => ({
      state: 'recorded',
      requestHash: record.requestHash,
      status: {
        status: 'ready_unbound',
        assetId,
        requestHash: record.requestHash,
      },
    }),
  });
  f.pending.write(record);
  assert.deepEqual(await f.uploader.recover(record), {
    protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
    kind: 'verification-evidence-upload',
    assetId,
  });
  assert.equal(f.pending.readAll(actor).length, 1);
  assert.equal(f.picks(), 0);
  f.uploader.dispose();
});
test('account switch during recovery suppresses late authority and preserves original-account journal', async () => {
  let resolve!: (value: unknown) => void;
  const response = new Promise((resolveResponse) => {
    resolve = resolveResponse;
  });
  const record = {
      actor,
      applicationId: randomUUID(),
      revision: 1,
      requestId: randomUUID(),
      requestHash: 'a'.repeat(64),
    },
    f = uploaderFixture({ recover: () => response });
  f.pending.write(record);
  const pending = f.uploader.recover(record);
  f.sessions.logout();
  resolve({
    state: 'recorded',
    requestHash: record.requestHash,
    status: {
      status: 'ready_unbound',
      assetId: randomUUID(),
      requestHash: record.requestHash,
    },
  });
  assert.equal(await pending, null);
  assert.equal(
    f.views.some((v) => v.status === 'ready'),
    false,
  );
  assert.equal(f.pending.readAll(actor).length, 1);
  f.uploader.dispose();
});

test('journal rejects forged private additions before any persistent write', () => {
  const { storage, values } = memory(),
    pending = new VerificationEvidencePending(
      storage,
      'https://example.invalid',
    );
  const record = {
    actor,
    applicationId: randomUUID(),
    revision: 1,
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
  };
  for (const key of ['imageUrl', 'declaration', 'studentNumber', 'filePath'])
    assert.throws(() =>
      pending.write({ ...record, [key]: 'synthetic-private' }),
    );
  assert.equal(values.size, 0);
});
