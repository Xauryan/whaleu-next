import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  TrustedInstitutionalVerifier,
  UnavailableInstitutionalProvider,
} from '../src/verification/institutional/provider.js';
import type { InstitutionalProviderContext } from '../src/verification/institutional/provider.js';
import {
  institutionalCompleteSchema,
  institutionalRequestHash,
  INSTITUTIONAL_CONSENT,
} from '../src/verification/institutional/contracts.js';
const context = (): InstitutionalProviderContext => ({
  accountId: randomUUID(),
  requestId: randomUUID(),
  requestHash: 'a'.repeat(64),
  claimId: randomUUID(),
  sessionId: randomUUID(),
  issuerNamespace: 'synthetic:test',
  adapterId: 'synthetic',
  audience: 'whaleu-institutional-verification',
  bindingVersion: 'synthetic/v1',
  policyReference: 'institutional-sso/synthetic-v1',
  institutionId: randomUUID(),
  originRegionId: randomUUID(),
  supportedNumber: true,
  requestExpiresAt: '2026-10-14T01:01:00Z',
  claimDeadline: '2026-10-14T01:00:50Z',
});
function payload(c: InstitutionalProviderContext) {
  const {
    supportedNumber: _supported,
    requestExpiresAt: _expires,
    claimDeadline: _claim,
    ...binding
  } = c;
  void _supported;
  void _expires;
  void _claim;
  return {
    ...binding,
    purpose: 'institutional_verification',
    subject: 'synthetic-only',
    eligibleStudent: true,
    studentNumber: '00001234',
    authenticatedAt: '2026-10-14T01:00:00Z',
    responseUseExpiresAt: '2026-10-14T01:00:45Z',
    factExpiresAt: '2026-10-14T01:10:00Z',
    evidenceDigest: 'b'.repeat(64),
  };
}
test('institutional verifier capability is runtime-authenticated, context-bound and one-use', async () => {
  const c = context();
  let calls = 0;
  const verifier = new TrustedInstitutionalVerifier({
    adapterId: 'synthetic',
    async exchange() {
      calls++;
      return payload(c);
    },
  });
  assert.equal(verifier.consume({}, c), null);
  const result = await verifier.verifyResponse('synthetic-response', c);
  assert.equal(result.state, 'accepted');
  if (result.state !== 'accepted') throw Error('Expected accepted');
  const p = verifier.consume(result.capability, c);
  assert.equal(p?.studentNumber, '00001234');
  assert.equal(verifier.consume(result.capability, c), null);
  assert.equal(calls, 1);
  const other = await verifier.verifyResponse('synthetic-response', c);
  if (other.state !== 'accepted') throw Error('Expected accepted');
  assert.equal(
    verifier.consume(other.capability, { ...c, requestId: randomUUID() }),
    null,
  );
});
test('institutional trust never comes from an environment switch or client claims', async () => {
  const c = context(),
    unavailable = new UnavailableInstitutionalProvider();
  assert.equal(unavailable.available('synthetic'), false);
  assert.deepEqual(await unavailable.verifyResponse('synthetic', c), {
    state: 'provider_unavailable',
  });
  for (const change of [
    { issuerNamespace: 'other' },
    { accountId: randomUUID() },
    { requestId: randomUUID() },
    { claimId: randomUUID() },
    { sessionId: randomUUID() },
    { purpose: 'grades' },
    { audience: 'other' },
    { eligibleStudent: false },
    { studentNumber: 'bad@number' },
    { studentNumber: ' 123' },
    { studentNumber: '123\n' },
    { unknown: true },
  ]) {
    const verifier = new TrustedInstitutionalVerifier({
      adapterId: 'synthetic',
      async exchange() {
        return { ...payload(c), ...change };
      },
    });
    assert.deepEqual(await verifier.verifyResponse('opaque', c), {
      state: 'rejected',
    });
  }
  const verifier = new TrustedInstitutionalVerifier({
    adapterId: 'synthetic',
    async exchange() {
      throw Error('must not dispatch');
    },
  });
  assert.deepEqual(await verifier.verifyResponse('x'.repeat(4097), c), {
    state: 'rejected',
  });
  assert.equal(
    institutionalCompleteSchema.safeParse({
      mode: 'authorize',
      requestHash: 'a'.repeat(64),
      authorizationResponse: 'opaque',
      verified: true,
    }).success,
    false,
  );
});
test('institutional original intent hash changes for every correlation or consent context', () => {
  const actor = randomUUID(),
    command = {
      requestId: randomUUID(),
      campusId: randomUUID(),
      capabilityVersion: '1'.repeat(64),
      consent: INSTITUTIONAL_CONSENT,
    },
    hash = institutionalRequestHash(actor, command);
  for (const altered of [
    { ...command, requestId: randomUUID() },
    { ...command, campusId: randomUUID() },
    { ...command, capabilityVersion: '2'.repeat(64) },
  ])
    assert.notEqual(institutionalRequestHash(actor, altered), hash);
  assert.notEqual(institutionalRequestHash(randomUUID(), command), hash);
});
