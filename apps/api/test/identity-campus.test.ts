import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type {
  LocalPublicationEligibilitySource,
  PublicationAffiliation,
} from '../src/verification/publication-eligibility.source.js';
import type { LocalSafetyPhoneSource } from '../src/verification/safety-phone.source.js';
import type { SafetyPhoneEligibility } from '../src/verification/contracts.js';
import type { SafetyRepository } from '../src/safety/repository.js';
import { IdentityCampusService } from '../src/identity-campus/service.js';
import {
  identityCampusSelectionSchema,
  identityCampusEmptyQuerySchema,
} from '../src/identity-campus/contracts.js';
import {
  IdentitySelectionRepository,
  identitySelectionIntentHash,
  identitySelectionRevision,
} from '../src/campus/community-policy/identity-selection.repository.js';
import type { OwnCampusFacts } from '../src/campus/community-policy/identity-selection.repository.js';
import type { PublicationAffiliationMetadata } from '../src/campus/community-policy/contracts.js';
import { ApplicationError } from '../src/http/application-error.js';

function fixture() {
  const accountId = randomUUID(),
    campusId = randomUUID();
  const metadata: PublicationAffiliationMetadata = {
    assertionId: randomUUID(),
    snapshotId: randomUUID(),
    institutionId: randomUUID(),
    originRegionId: randomUUID(),
    validUntil: null,
  };
  const campus = {
    id: campusId,
    name: 'Physical campus',
    operatingRegion: { id: randomUUID(), name: 'Operating region' },
  };
  const facts: OwnCampusFacts = {
    selection: 'unavailable',
    reason: 'history_unknown',
    selectedCampus: null,
    options: { status: 'known', items: [campus] },
    writable: true,
    head: null,
    current: null,
    topology: null,
    validUntil: null,
    fingerprint: ['absent', randomUUID()],
  };
  const log: string[] = [];
  const tx = {
    query: async (sql: string) => {
      log.push(sql.includes('_shared') ? 'shared-gate' : 'exclusive-gate');
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const state: {
    affiliation: PublicationAffiliation;
    phone: SafetyPhoneEligibility;
    safety: 'allowed' | 'restricted' | 'unavailable';
    saved: null | {
      client_request_id: string;
      campus_id: string;
      intent_hash: string;
      expected_state_revision: string;
      selection_revision: number;
      outcome: 'applied';
    };
    failure: Error | null;
  } = {
    affiliation: { status: 'verified', ...metadata },
    phone: { status: 'verified', validUntil: null },
    safety: 'allowed',
    saved: null,
    failure: null,
  };
  const service = new IdentityCampusService(
    {
      transaction: async <T>(operation: (client: PoolClient) => Promise<T>) =>
        operation(tx),
    } as unknown as DatabaseService,
    {
      session: async () => {
        log.push('session');
        return { accountId };
      },
    } as unknown as IdentityService,
    {
      resolve: async () => {
        log.push('affiliation');
        return state.affiliation;
      },
    } as unknown as LocalPublicationEligibilitySource,
    {
      resolve: async () => {
        log.push('phone');
        return state.phone;
      },
    } as unknown as LocalSafetyPhoneSource,
    {
      selectionEligibility: async () => {
        log.push('safety');
        if (state.failure) throw state.failure;
        return { status: state.safety, fingerprint: null };
      },
    } as unknown as SafetyRepository,
    {
      own: async () => {
        log.push('campus');
        return facts;
      },
      receipt: async () => {
        log.push('receipt');
        return state.saved;
      },
      receiptView: IdentitySelectionRepository.prototype.receiptView,
      select: async (
        _account: string,
        intent: { requestId: string; campusId: string },
      ) => {
        log.push('select');
        return {
          requestId: intent.requestId,
          campusId: intent.campusId,
          outcome: 'applied',
          selectionRevision: 1,
        };
      },
    } as unknown as IdentitySelectionRepository,
  );
  const intent = {
    requestId: randomUUID(),
    campusId,
    expectedStateRevision: identitySelectionRevision(
      accountId,
      facts,
      state.affiliation as PublicationAffiliationMetadata,
      state.phone,
      null,
    ),
  };
  return { service, state, facts, log, intent, accountId, metadata };
}

test('identity campus input is strict, bounded, and UUID-normalized without authority fields', () => {
  const input = {
    requestId: randomUUID().toUpperCase(),
    campusId: randomUUID().toUpperCase(),
    expectedStateRevision: `ic1:${'a'.repeat(64)}`,
  };
  const parsed = identityCampusSelectionSchema.parse(input);
  assert.equal(parsed.requestId, input.requestId.toLowerCase());
  assert.equal(parsed.campusId, input.campusId.toLowerCase());
  for (const key of [
    'accountId',
    'assertionId',
    'snapshotId',
    'topologyId',
    'isVerified',
    'role',
    'selectedCampusId',
    'institutionId',
    'schoolCode',
    'provenance',
  ])
    assert.equal(
      identityCampusSelectionSchema.safeParse({ ...input, [key]: randomUUID() })
        .success,
      false,
      key,
    );
  for (const revision of [
    '',
    'ic1:x',
    `ic1:${'A'.repeat(64)}`,
    `ic2:${'a'.repeat(64)}`,
    'a'.repeat(10000),
  ])
    assert.equal(
      identityCampusSelectionSchema.safeParse({
        ...input,
        expectedStateRevision: revision,
      }).success,
      false,
    );
  assert.equal(
    identityCampusEmptyQuerySchema.safeParse({ accountId: randomUUID() })
      .success,
    false,
  );
});

test('intent hash excludes the replay key but includes immutable campus and version', () => {
  const f = fixture();
  assert.equal(
    identitySelectionIntentHash(f.intent),
    identitySelectionIntentHash({
      ...f.intent,
      requestId: randomUUID(),
    } as typeof f.intent),
  );
  assert.notEqual(
    identitySelectionIntentHash(f.intent),
    identitySelectionIntentHash({ ...f.intent, campusId: randomUUID() }),
  );
  assert.notEqual(
    identitySelectionIntentHash(f.intent),
    identitySelectionIntentHash({
      ...f.intent,
      expectedStateRevision: `ic1:${'b'.repeat(64)}`,
    }),
  );
  assert.notEqual(
    identitySelectionRevision(
      f.accountId,
      f.facts,
      f.metadata,
      { status: 'verified', validUntil: null },
      { state_version: '1' },
    ),
    identitySelectionRevision(
      f.accountId,
      f.facts,
      f.metadata,
      { status: 'verified', validUntil: null },
      { state_version: '2' },
    ),
  );
});

test('own read exposes independent candidates despite phone and safety blockers, with no write', async () => {
  const f = fixture();
  f.state.phone = { status: 'unverified' };
  f.state.safety = 'restricted';
  const state = await f.service.state('token');
  assert.equal(state.options.status, 'known');
  assert.equal(state.options.items.length, 1);
  assert.equal(state.selection, 'unavailable');
  assert.equal(state.reason, 'history_unknown');
  assert.equal(state.canSelect, false);
  assert.equal(state.expectedStateRevision, null);
  assert.deepEqual(state.writeEligibility, {
    phone: 'unverified',
    safety: 'restricted',
  });
  assert.deepEqual(f.log, [
    'shared-gate',
    'session',
    'affiliation',
    'phone',
    'safety',
    'campus',
    'session',
  ]);
});

test('unknown affiliation does not read campus authority or masquerade as known unverified', async () => {
  const f = fixture();
  f.state.affiliation = { status: 'unavailable' };
  const state = await f.service.state('token');
  assert.equal(state.reason, 'affiliation_unavailable');
  assert.equal(state.guidance, 'unavailable');
  assert.deepEqual(state.options, { status: 'unavailable', items: [] });
  assert.equal(state.selectedCampus, null);
  assert.equal(f.log.includes('campus'), false);
});

test('known empty options and structurally unavailable history never offer a save', async () => {
  const f = fixture();
  f.facts.options.items = [];
  assert.equal((await f.service.state('token')).canSelect, false);
  f.facts.options.items = [
    {
      id: f.intent.campusId,
      name: 'A',
      operatingRegion: { id: randomUUID(), name: 'R' },
    },
  ];
  f.facts.writable = false;
  assert.equal((await f.service.state('token')).canSelect, false);
});

test('repository and internal safety failures propagate rather than becoming an allowed gate', async () => {
  const f = fixture();
  const failure = new Error('database unavailable');
  f.state.failure = failure;
  await assert.rejects(f.service.state('token'), (error) => error === failure);
  await assert.rejects(
    f.service.select('token', f.intent),
    (error) => error === failure,
  );
  assert.equal(f.log.includes('select'), false);
});

test('new selection acquires exclusive gate before actor, receipt and canonical owners', async () => {
  const f = fixture();
  const receipt = await f.service.select('token', f.intent);
  assert.equal(receipt.outcome, 'applied');
  assert.deepEqual(f.log, [
    'exclusive-gate',
    'session',
    'receipt',
    'affiliation',
    'phone',
    'safety',
    'campus',
    'select',
    'session',
  ]);
});

test('stale explicit intent conflicts without substituting the current revision or saving', async () => {
  const f = fixture();
  f.facts.fingerprint = ['changed'];
  await assert.rejects(
    f.service.select('token', f.intent),
    (error) =>
      error instanceof ApplicationError &&
      error.code === 'IDENTITY_CAMPUS_REVISION_CONFLICT',
  );
  assert.equal(f.log.includes('select'), false);
});

test('exact success replay requires current actor twice but no current verification or campus authority', async () => {
  const f = fixture();
  f.state.saved = {
    client_request_id: f.intent.requestId,
    campus_id: f.intent.campusId,
    intent_hash: identitySelectionIntentHash(f.intent),
    expected_state_revision: f.intent.expectedStateRevision,
    selection_revision: 3,
    outcome: 'applied',
  };
  f.state.affiliation = { status: 'unavailable' };
  f.state.phone = { status: 'unverified' };
  f.state.safety = 'restricted';
  assert.equal(
    (await f.service.select('token', f.intent)).selectionRevision,
    3,
  );
  assert.deepEqual(f.log, ['exclusive-gate', 'session', 'receipt', 'session']);
  f.log.length = 0;
  await assert.rejects(
    f.service.select('token', { ...f.intent, campusId: randomUUID() }),
    (error) =>
      error instanceof ApplicationError &&
      error.code === 'IDENTITY_CAMPUS_REQUEST_CONFLICT',
  );
  assert.deepEqual(f.log, ['exclusive-gate', 'session', 'receipt']);
});

test('receipt read is owner-scoped authentication only, and missing does not create anything', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.receipt('token', f.intent.requestId),
    (error) =>
      error instanceof ApplicationError &&
      error.code === 'IDENTITY_CAMPUS_REQUEST_NOT_FOUND',
  );
  assert.deepEqual(f.log, ['shared-gate', 'session', 'receipt']);
});
