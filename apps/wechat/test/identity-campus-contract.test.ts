import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeIdentityCampusIntent,
  decodeIdentityCampusReceipt,
  decodeIdentityCampusState,
  matchIdentityCampusReceipt,
} from '../src/identity-campus/contract';
import {
  campus,
  campusId,
  intent,
  otherCampusId,
  receipt,
  state,
} from './identity-campus-helpers';

test('independent own status: unknown history, required, same-ID renewal, valid-with-unavailable-options, no phone and known empty', () => {
  const blocked = {
    canSelect: false,
    expectedStateRevision: null,
    guidance: 'refresh',
  } as const;
  for (const input of [
    state(),
    state({
      canSelect: false,
      expectedStateRevision: null,
      guidance: 'refresh',
    }),
    state({ selection: 'selection_required', reason: 'choice_required' }),
    state({ reason: 'inputs_changed', guidance: 'reselect' }),
    state({
      selection: 'valid',
      reason: 'current',
      selectedCampus: campus(),
      guidance: 'reselect',
    }),
    state({
      selection: 'valid',
      reason: 'current',
      selectedCampus: campus(),
      options: { status: 'unavailable', items: [] },
      ...blocked,
    }),
    state({ options: { status: 'known', items: [] }, ...blocked }),
    state({
      writeEligibility: { phone: 'unverified', safety: 'restricted' },
      ...blocked,
    }),
    state({
      affiliation: 'unavailable',
      reason: 'affiliation_unavailable',
      options: { status: 'unavailable', items: [] },
      ...blocked,
      guidance: 'unavailable',
    }),
    state({
      affiliation: 'unverified',
      reason: 'affiliation_required',
      options: { status: 'unavailable', items: [] },
      ...blocked,
      guidance: 'await_affiliation',
    }),
  ]) {
    const decoded = decodeIdentityCampusState(input);
    assert.deepEqual(decoded, input);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.options.items));
  }
});
test('state decoder rejects private leakage, malformed IDs and contradictory flags/status/candidate coverage', () => {
  for (const input of [
    { ...state(), accountId: campusId },
    { ...state(), affiliation: 'expired' },
    { ...state(), selection: 'selection_required' },
    { ...state(), selectedCampus: campus() },
    { ...state(), reason: 'current' },
    {
      ...state(),
      selection: 'valid',
      reason: 'current',
      selectedCampus: campus(otherCampusId),
    },
    { ...state(), options: { status: 'unavailable', items: [campus()] } },
    { ...state(), options: { status: 'known', items: [] } },
    { ...state(), options: { status: 'known', items: [campus(), campus()] } },
    {
      ...state(),
      options: {
        status: 'known',
        items: [{ ...campus(), assertionId: campusId }],
      },
    },
    {
      ...state(),
      options: { status: 'known', items: [{ ...campus(), id: 'school-code' }] },
    },
    {
      ...state(),
      options: {
        status: 'known',
        items: [
          {
            ...campus(),
            operatingRegion: { ...campus().operatingRegion, issuer: 'private' },
          },
        ],
      },
    },
    {
      ...state(),
      options: {
        status: 'known',
        items: [{ ...campus(), name: '\u0000private' }],
      },
    },
    { ...state(), affiliation: 'unverified' },
    {
      ...state(),
      writeEligibility: { phone: 'unverified', safety: 'allowed' },
    },
    {
      ...state(),
      writeEligibility: { phone: 'verified', safety: 'unavailable' },
    },
    {
      ...state(),
      writeEligibility: {
        phone: 'verified',
        safety: 'allowed',
        phoneNumber: 'private',
      },
    },
    { ...state(), expectedStateRevision: null },
    { ...state(), expectedStateRevision: 'abc' },
    { ...state(), canSelect: false },
    { ...state(), guidance: 'await_affiliation' },
    {
      ...state(),
      canSelect: false,
      expectedStateRevision: null,
      guidance: 'choose',
    },
  ])
    assert.throws(() => decodeIdentityCampusState(input), { kind: 'protocol' });
});
test('intent and receipt reject unknown authority inputs, noncanonical UUIDs, unsafe revisions and mismatched request/campus', () => {
  assert.deepEqual(decodeIdentityCampusIntent(intent()), intent());
  assert.deepEqual(decodeIdentityCampusReceipt(receipt()), receipt());
  for (const input of [
    { ...intent(), role: 'admin' },
    { ...intent(), campusId: '10001' },
    { ...intent(), expectedStateRevision: `ic2:${'a'.repeat(64)}` },
    { ...intent(), requestId: campusId.replace('-4333-', '-1333-') },
    { ...intent(), accountId: campusId },
  ])
    assert.throws(() => decodeIdentityCampusIntent(input), {
      kind: 'protocol',
    });
  for (const input of [
    { ...receipt(), eventId: campusId },
    { ...receipt(), outcome: 'rejected' },
    { ...receipt(), selectionRevision: 0 },
    { ...receipt(), selectionRevision: '1' },
    { ...receipt(), selectionRevision: 2147483648 },
    { ...receipt(), selectionRevision: 1.5 },
  ])
    assert.throws(() => decodeIdentityCampusReceipt(input), {
      kind: 'protocol',
    });
  assert.throws(
    () =>
      matchIdentityCampusReceipt(
        intent(),
        receipt({ campusId: otherCampusId }),
      ),
    { kind: 'protocol' },
  );
  assert.throws(
    () =>
      matchIdentityCampusReceipt(intent(), receipt({ requestId: campusId })),
    { kind: 'protocol' },
  );
});
