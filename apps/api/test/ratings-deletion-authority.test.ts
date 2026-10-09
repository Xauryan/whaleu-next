import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { RatingTargetOriginFacade } from '../src/ratings/deletion/origin.facade.js';
import { CampusRatingOriginScopeFacade } from '../src/campus/rating-origin-scope.facade.js';
import { RatingDeletionService } from '../src/ratings/deletion/service.js';
import {
  RatingAdminDeletionRequests,
  ratingAdminDeletionIntentHash,
} from '../src/ratings/deletion/requests.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { DatabaseService } from '../src/database/database.js';
import type { RatingsAccessService } from '../src/ratings/access.js';
import {
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  startTransactionDeadlines,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../src/database/transaction-deadlines.js';
const instant = Date.parse('2026-10-09T07:00:00.123Z');
const targetId = randomUUID();
function originRow() {
  return {
    head_revision: 1,
    source_id: randomUUID(),
    revision: 1,
    state: 'known_school',
    origin_campus_id: randomUUID(),
    revoked: false,
    source_version: 1,
    coverage_state: 'complete',
    provenance_state: 'accepted',
    source_reference: 'synthetic-test-only',
    policy_reference: 'test-policy',
    effective_at: new Date(instant - 1000),
    precise_from: '2026-10-09 07:00:00.122999+00',
    valid_until: null as Date | null,
    precise_until: null as string | null,
    expiry_kind: 'policy_exempt',
    valid: true,
    future: false,
  };
}
function sourceHarness(source: () => unknown[]) {
  const state = { now: instant, statements: [] as string[] };
  const tx = {
    query: async (sql: string) => {
      state.statements.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '5s',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.startsWith('WITH instant')) return { rows: source() };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(state.now) }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, state };
}
const authorityError = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === 'RATING_DELETION_AUTHORITY_UNAVAILABLE';
test('same-millisecond future origin is unknown even when the JavaScript date has already arrived', async () => {
  const row = {
    ...originRow(),
    effective_at: new Date(instant),
    precise_from: '2026-10-09 07:00:00.123999+00',
    valid: false,
    future: true,
  };
  const { tx, state } = sourceHarness(() => [row]);
  try {
    const fact = await new RatingTargetOriginFacade().observe(targetId, tx);
    assert.equal(fact.state, 'unknown');
    assert.equal(fact.campusId, null);
    assert.equal(fact.sourceId, row.source_id);
    assert.ok(
      state.statements.some(
        (sql) =>
          sql.includes('s.effective_at<=instant.now') &&
          sql.includes('s.effective_at>instant.now'),
      ),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('future-origin activation invalidates the previous unknown observation', async () => {
  const row = {
    ...originRow(),
    effective_at: new Date(instant + 1),
    valid: false,
    future: true,
  };
  const { tx } = sourceHarness(() => [row]);
  try {
    assert.equal(
      (await new RatingTargetOriginFacade().observe(targetId, tx)).state,
      'unknown',
    );
    row.valid = true;
    row.future = false;
    await assert.rejects(checkTransactionDeadlines(tx), authorityError);
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('scheduled origin deadline cannot pass between its last source proof and the final clock', async () => {
  const row = {
    ...originRow(),
    effective_at: new Date(instant + 1),
    valid: false,
    future: true,
  };
  const { tx, state } = sourceHarness(() => [row]);
  try {
    await new RatingTargetOriginFacade().observe(targetId, tx);
    state.now = instant + 1;
    await assert.rejects(checkTransactionDeadlines(tx), authorityError);
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('exact origin expiry is enforced by source state and the final deadline', async () => {
  for (const sourceChanges of [false, true]) {
    const row = {
      ...originRow(),
      valid_until: new Date(instant + 1),
      precise_until: '2026-10-09 07:00:00.124+00',
      expiry_kind: 'at',
    };
    const { tx, state } = sourceHarness(() => [row]);
    try {
      await new RatingTargetOriginFacade().observe(targetId, tx);
      if (sourceChanges) row.valid = false;
      else state.now = instant + 1;
      await assert.rejects(checkTransactionDeadlines(tx), authorityError);
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});
test('new origin version invalidates identical-looking school scope and normalized unknown facts', async () => {
  for (const valid of [true, false]) {
    let row = { ...originRow(), valid };
    const { tx } = sourceHarness(() => [row]);
    try {
      await new RatingTargetOriginFacade().observe(targetId, tx);
      row = { ...row, source_id: randomUUID(), revision: 2, head_revision: 2 };
      await assert.rejects(checkTransactionDeadlines(tx), authorityError);
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});
test('source absence final fence never retries a NOWAIT conflict with a blocking lock', async () => {
  const h = sourceHarness(() => []);
  const original = h.tx.query.bind(h.tx);
  h.tx.query = (async (sql: string) => {
    if (sql.includes('IN SHARE MODE NOWAIT'))
      throw Object.assign(new Error('busy'), { code: '55P03' });
    return original(sql);
  }) as typeof h.tx.query;
  try {
    await new RatingTargetOriginFacade().observe(targetId, h.tx);
    await assert.rejects(checkTransactionDeadlines(h.tx), authorityError);
    assert.equal(
      h.state.statements.some(
        (sql) => sql.startsWith('LOCK TABLE') && !sql.includes('NOWAIT'),
      ),
      false,
    );
  } finally {
    clearTransactionDeadlines(h.tx);
  }
});
function topologyRow() {
  const campusId = randomUUID(),
    institutionId = randomUUID(),
    regionId = randomUUID(),
    groupId = randomUUID();
  return {
    campusId,
    row: {
      id: randomUUID(),
      revision: 1,
      valid: true,
      valid_until: null as Date | null,
      effective_at: '2026-10-09 00:00:00+00',
      precise_until: null as string | null,
      topology: {
        version: 1,
        groups: [{ groupId, coverage: 'complete', isActive: false }],
        regions: [
          {
            regionId,
            institutionId,
            groupId,
            coverage: 'complete',
            isActive: false,
          },
        ],
        assignments: [
          {
            campusId,
            institutionId,
            regionId,
            coverage: 'complete',
            isActive: false,
          },
        ],
      },
    },
  };
}
test('Campus mapping rejects incomplete, duplicate, foreign-institution and malformed topology', async () => {
  const cases = [
    (r: ReturnType<typeof topologyRow>['row']) => {
      r.topology.groups[0]!.coverage = 'missing';
    },
    (r: ReturnType<typeof topologyRow>['row']) => {
      r.topology.regions[0]!.coverage = 'conflicting';
    },
    (r: ReturnType<typeof topologyRow>['row']) => {
      r.topology.assignments[0]!.coverage = 'missing';
    },
    (r: ReturnType<typeof topologyRow>['row']) => {
      r.topology.groups.push({ ...r.topology.groups[0]! });
    },
    (r: ReturnType<typeof topologyRow>['row']) => {
      r.topology.regions.push({ ...r.topology.regions[0]! });
    },
    (r: ReturnType<typeof topologyRow>['row']) => {
      r.topology.assignments.push({ ...r.topology.assignments[0]! });
    },
    (r: ReturnType<typeof topologyRow>['row']) => {
      r.topology.assignments[0]!.institutionId = randomUUID();
    },
    (r: ReturnType<typeof topologyRow>['row']) => {
      r.topology.groups = [];
    },
    (r: ReturnType<typeof topologyRow>['row']) => {
      r.topology.version = 2;
    },
    (r: ReturnType<typeof topologyRow>['row']) => {
      r.valid = false;
    },
  ];
  for (const change of cases) {
    const { campusId, row } = topologyRow();
    change(row);
    const { tx } = sourceHarness(() => [row]);
    try {
      await assert.rejects(
        new CampusRatingOriginScopeFacade().resolve(campusId, tx),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.code === 'IDENTITY_CAMPUS_UNAVAILABLE',
      );
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});
test('equivalent new Campus snapshot, invalid source and final expiry all reject the original proof', async () => {
  for (const change of ['version', 'expiry', 'invalid'] as const) {
    const { campusId, row } = topologyRow();
    row.valid_until = new Date(instant + 1);
    row.precise_until = '2026-10-09 07:00:00.124+00';
    const { tx, state } = sourceHarness(() => [row]);
    try {
      await new CampusRatingOriginScopeFacade().resolve(campusId, tx);
      if (change === 'version') {
        row.id = randomUUID();
        row.revision++;
      }
      if (change === 'invalid') row.valid = false;
      if (change === 'expiry') state.now = instant + 1;
      await assert.rejects(
        checkTransactionDeadlines(tx),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.code === 'IDENTITY_CAMPUS_UNAVAILABLE',
      );
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});
function contextHarness() {
  const session = {
    accountId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: instant + 3600000,
    refreshExpiresAt: instant + 7200000,
  };
  const root = {
    id: randomUUID(),
    target_id: targetId,
    account_id: randomUUID(),
    revision: randomUUID(),
    deleted_at: null,
  };
  const target = {
    id: targetId,
    revision: randomUUID(),
    active: false,
    region_id: null,
  };
  const state = {
    now: instant,
    grantFingerprint: 'grant-v1',
    grantId: randomUUID(),
    originFingerprint: 'origin-v1',
    eligibility: 'global-v1',
    ordinary: false,
    fixed: false,
    originKnown: false,
    originCampusId: randomUUID(),
    originSourceId: randomUUID(),
    grantRegionId: randomUUID(),
    mappedRegionId: randomUUID(),
    grantUnavailable: false,
    mappingUnavailable: false,
    receiptWrites: 0,
    lookups: 0,
    audits: 0,
    finalTime: null as number | null,
  };
  const positions = new Map<
    string,
    { scope: string; position: { fingerprint: string; expiresAt: number } }
  >();
  let requestHash = '';
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql === 'SELECT clock_timestamp() now')
        return { rows: [{ now: new Date(state.now) }] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(state.finalTime ?? state.now) }] };
      if (sql.startsWith('SELECT clock_timestamp()<'))
        return { rows: [{ valid: state.now < Number(values?.[0]) }] };
      if (sql.startsWith('INSERT INTO whaleu_ratings.requests'))
        requestHash = values?.[3] as string;
      if (sql.startsWith('UPDATE whaleu_ratings.requests'))
        state.receiptWrites++;
      if (sql.startsWith('SELECT intent_hash'))
        return {
          rows: [
            {
              intent_hash: requestHash,
              operation: 'admin_delete_comment',
              receipt: null,
            },
          ],
        };
      if (sql.startsWith('INSERT INTO whaleu_ratings.admin_delete_audits')) {
        state.audits++;
        throw new Error('Unexpected audit in stale-context test');
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const transaction = async <T>(run: (tx: PoolClient) => Promise<T>) => {
    startTransactionDeadlines(tx);
    try {
      const result = await run(tx);
      await checkTransactionDeadlines(tx);
      return result;
    } finally {
      clearTransactionDeadlines(tx);
    }
  };
  const access = {
    authenticate: async () => session,
    requireDeletionActor: async () => ({ fingerprint: state.eligibility }),
    recheck: async () => {},
  };
  const metadata = {
    locator: async () => {
      state.lookups++;
      return { target_id: targetId, root_id: root.id };
    },
    target: async () => target,
    root: async () => root,
  };
  const records = {
    enable: () => {},
    retainComment: () => {},
    retainReply: () => {},
  };
  const grants = {
    scope: async () => {
      if (state.grantUnavailable)
        throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
      if (state.ordinary)
        return { kind: 'ordinary', fingerprint: state.grantFingerprint };
      return {
        kind: state.fixed ? 'fixed' : 'global',
        regionId: state.fixed ? state.grantRegionId : undefined,
        fingerprint: state.grantFingerprint,
        grant: {
          id: state.grantId,
          role: state.fixed ? 'school_admin' : 'super_admin',
          operatingRegionId: state.fixed ? state.grantRegionId : null,
          validUntil: null,
        },
      };
    },
  };
  const origins = {
    observe: async () => ({
      state: state.originKnown ? 'known_school' : 'absent',
      sourceId: state.originKnown ? state.originSourceId : null,
      revision: state.originKnown ? 1 : null,
      campusId: state.originKnown ? state.originCampusId : null,
      fingerprint: state.originFingerprint,
      deadline: null,
    }),
  };
  const campus = {
    resolve: async () => {
      if (state.mappingUnavailable)
        throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
      return {
        operatingRegionId: state.mappedRegionId,
        fingerprint: 'mapping-v1',
      };
    },
  };
  const contexts = {
    create: async (
      scope: string,
      _actor: string,
      position: { fingerprint: string; expiresAt: number },
    ) => {
      const id = Buffer.from(randomUUID()).toString('base64url').slice(0, 43);
      positions.set(id, { scope, position });
      return id;
    },
    get: async (
      token: string,
      scope: string,
      _tx: PoolClient,
      validate: (value: unknown) => unknown,
    ) => {
      const entry = positions.get(token);
      if (!entry || entry.scope !== scope)
        throw new BadRequestException('Invalid context');
      return validate(entry.position);
    },
  };
  const requests = new RatingAdminDeletionRequests(
    { transaction } as unknown as DatabaseService,
    access as unknown as RatingsAccessService,
  );
  const service = new RatingDeletionService(
    ...([
      { transaction },
      access,
      metadata,
      records,
      grants,
      origins,
      campus,
      contexts,
      requests,
    ] as unknown as ConstructorParameters<typeof RatingDeletionService>),
  );
  const command = (contextRevision: string) => ({
    clientRequestId: randomUUID(),
    targetId,
    expectedTargetRevision: target.revision,
    expectedRevision: root.revision,
    expectedContextRevision: contextRevision,
  });
  return { service, state, session, root, target, positions, command };
}
test('admin context lookup does not expose subject existence to an ordinary actor', async () => {
  const h = contextHarness();
  h.state.ordinary = true;
  await assert.rejects(
    h.service.adminContext('token', 'comment', h.root.id),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'AUTHORIZATION_REQUIRED',
  );
  assert.equal(h.state.lookups, 0);
});
test('opaque deletion context binds grant set, selected grant, source version, eligibility and session', async () => {
  for (const change of [
    'grantFingerprint',
    'grantId',
    'originFingerprint',
    'eligibility',
    'session',
  ] as const) {
    const h = contextHarness();
    const context = await h.service.adminContext('token', 'comment', h.root.id);
    if (change === 'session') h.session.sessionId = randomUUID();
    else h.state[change] = randomUUID();
    await assert.rejects(
      h.service.deleteComment(
        'token',
        h.root.id,
        h.command(context.contextRevision),
      ),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATING_DELETION_CONTEXT_CHANGED',
    );
    assert.equal(h.state.audits, 0);
  }
});
test('admin context expires at five minutes and cannot be refreshed by replaying its token', async () => {
  const h = contextHarness();
  const context = await h.service.adminContext('token', 'comment', h.root.id);
  assert.equal(
    h.positions.get(context.contextRevision)?.position.expiresAt,
    instant + 300000,
  );
  h.state.now = instant + 300000;
  await assert.rejects(
    h.service.deleteComment(
      'token',
      h.root.id,
      h.command(context.contextRevision),
    ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'RATING_DELETION_CONTEXT_CHANGED',
  );
  assert.equal(h.state.audits, 0);
});
test('context expiry after a terminal CAS decision rolls back that rejection at the final clock', async () => {
  const h = contextHarness();
  const context = await h.service.adminContext('token', 'comment', h.root.id);
  h.state.finalTime = instant + 300000;
  await assert.rejects(
    h.service.deleteComment('token', h.root.id, {
      ...h.command(context.contextRevision),
      expectedTargetRevision: randomUUID(),
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'RATING_DELETION_CONTEXT_CHANGED',
  );
  assert.equal(h.state.audits, 0);
});
test('context issuance cannot return a token that expired during its final commit wait', async () => {
  const h = contextHarness();
  h.state.finalTime = instant + 300000;
  await assert.rejects(
    h.service.adminContext('token', 'comment', h.root.id),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'RATING_DELETION_CONTEXT_CHANGED',
  );
});
test('each successfully issued context gets a fresh opaque reference', async () => {
  const h = contextHarness();
  const a = await h.service.adminContext('token', 'comment', h.root.id),
    b = await h.service.adminContext('token', 'comment', h.root.id);
  assert.notEqual(a.contextRevision, b.contextRevision);
  assert.equal(
    h.positions.get(a.contextRevision)?.position.fingerprint,
    h.positions.get(b.contextRevision)?.position.fingerprint,
  );
});
test('terminal rejection keeps negative mandatory facts through final validation', async () => {
  const session = {
    accountId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: instant + 10000,
    refreshExpiresAt: instant + 10000,
  };
  const requestId = randomUUID(),
    intent = { subjectId: randomUUID() };
  let state = 'unverified',
    saved = false,
    rolledBack = false,
    validations = 0;
  const negative: RequiredTransactionProof<string> = {
    maximumFacts: 1,
    failureCode: 'VERIFICATION_UNAVAILABLE',
    validate: async (facts) => {
      validations++;
      if (facts[0] !== state)
        throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    },
  };
  const tx = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT intent_hash'))
        return {
          rows: [
            {
              intent_hash: ratingAdminDeletionIntentHash(
                'admin_delete_comment',
                intent,
              ),
              operation: 'admin_delete_comment',
              receipt: null,
            },
          ],
        };
      if (sql.startsWith('UPDATE whaleu_ratings.requests')) {
        saved = true;
        state = 'verified';
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(instant) }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async (run: (tx: PoolClient) => Promise<unknown>) => {
      startTransactionDeadlines(tx);
      try {
        const result = await run(tx);
        await checkTransactionDeadlines(tx);
        return result;
      } catch (error) {
        saved = false;
        rolledBack = true;
        throw error;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as unknown as DatabaseService;
  const access = {
    authenticate: async () => session,
    recheck: async () => {},
  } as unknown as RatingsAccessService;
  await assert.rejects(
    new RatingAdminDeletionRequests(database, access).execute(
      'token',
      requestId,
      'admin_delete_comment',
      intent,
      async () => {
        enableRequiredTransactionProof(tx, negative);
        registerRequiredTransactionFact(tx, negative, 'phone', state);
        throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
      },
    ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'VERIFICATION_UNAVAILABLE',
  );
  assert.equal(validations, 1);
  assert.equal(saved, false);
  assert.equal(rolledBack, true);
});
test('stored receipt replay still refuses revoked sessions and never calls current deletion authority', async () => {
  const session = {
    accountId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: instant + 10000,
    refreshExpiresAt: instant + 10000,
  };
  const requestId = randomUUID(),
    id = randomUUID(),
    intent = { subjectId: id };
  const receipt = {
    requestId,
    operation: 'admin_delete_comment',
    outcome: 'noop',
    targetId,
    rootId: id,
    subjectId: id,
    revision: randomUUID(),
    occurredAt: '2026-10-09T07:00:00.123000Z',
  };
  let applyCalls = 0;
  const tx = {
    query: async (sql: string) => ({
      rows: sql.startsWith('SELECT intent_hash')
        ? [
            {
              intent_hash: ratingAdminDeletionIntentHash(
                'admin_delete_comment',
                intent,
              ),
              operation: 'admin_delete_comment',
              receipt,
            },
          ]
        : [],
    }),
  } as unknown as PoolClient;
  const database = {
    transaction: async (run: (tx: PoolClient) => Promise<unknown>) => run(tx),
  } as unknown as DatabaseService;
  const access = {
    authenticate: async () => session,
    recheck: async () => {
      throw new ApplicationError('SESSION_REVOKED');
    },
  } as unknown as RatingsAccessService;
  await assert.rejects(
    new RatingAdminDeletionRequests(database, access).execute(
      'token',
      requestId,
      'admin_delete_comment',
      intent,
      async () => {
        applyCalls++;
        throw new Error('No apply');
      },
    ),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'SESSION_REVOKED',
  );
  assert.equal(applyCalls, 0);
});

test('known revoked grant invalidates an existing command context without a terminal receipt', async () => {
  const h = contextHarness();
  const context = await h.service.adminContext('token', 'comment', h.root.id);
  h.state.ordinary = true;
  await assert.rejects(
    h.service.deleteComment(
      'token',
      h.root.id,
      h.command(context.contextRevision),
    ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'RATING_DELETION_CONTEXT_CHANGED',
  );
  assert.equal(h.state.audits, 0);
  assert.equal(h.state.receiptWrites, 0);
  // Context discovery still exposes the ordinary-role denial, not a command-reset signal.
  await assert.rejects(
    h.service.adminContext('token', 'comment', h.root.id),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'AUTHORIZATION_REQUIRED',
  );
});

test('known new fixed scope mismatch invalidates a verified old command context', async () => {
  const h = contextHarness();
  h.state.originKnown = true;
  const context = await h.service.adminContext('token', 'comment', h.root.id);
  h.state.fixed = true;
  assert.notEqual(h.state.grantRegionId, h.state.mappedRegionId);
  await assert.rejects(
    h.service.deleteComment(
      'token',
      h.root.id,
      h.command(context.contextRevision),
    ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'RATING_DELETION_CONTEXT_CHANGED',
  );
  assert.equal(h.state.audits, 0);
  assert.equal(h.state.receiptWrites, 0);
  await assert.rejects(
    h.service.adminContext('token', 'comment', h.root.id),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'RATING_SCOPE_UNAVAILABLE',
  );
});

test('unknown grants, original campus and current mapping never masquerade as a definitive context reset', async () => {
  for (const kind of ['grant', 'origin', 'mapping'] as const) {
    const h = contextHarness();
    h.state.originKnown = kind === 'mapping';
    const context = await h.service.adminContext('token', 'comment', h.root.id);
    if (kind === 'grant') h.state.grantUnavailable = true;
    else h.state.fixed = true;
    if (kind === 'mapping') h.state.mappingUnavailable = true;
    const code =
      kind === 'grant'
        ? 'AUTHORIZATION_UNAVAILABLE'
        : kind === 'origin'
          ? 'RATING_DELETION_AUTHORITY_UNAVAILABLE'
          : 'IDENTITY_CAMPUS_UNAVAILABLE';
    await assert.rejects(
      h.service.deleteComment(
        'token',
        h.root.id,
        h.command(context.contextRevision),
      ),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === code,
    );
    assert.equal(h.state.audits, 0);
    assert.equal(h.state.receiptWrites, 0);
  }
});
