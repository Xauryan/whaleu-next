import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import { ProfileRepository } from '../../src/profile/profile.repository.js';
import { SchoolUidCoverageFacade } from '../../src/school-uid/coverage.facade.js';
import {
  applySyntheticAccountInventory,
  applySyntheticInventory,
  inventoryDigest,
} from '../../src/school-uid/inventory.js';
import {
  schoolUidFixture,
  syntheticUidInventory,
} from '../support/school-uid-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';

test(
  'synthetic inventory admissions are idempotent, monotone and reserve holes before runtime issuance',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const input = syntheticUidInventory(f.home, '1000');
    const first = await withCommunityScopeWriter(f.pool, (tx) =>
      applySyntheticInventory(input, f.home.institutionId, tx),
    );
    const owner = await f.actor();
    await f.approve(f.admin, await f.submit(owner));
    const assigned = await f.own(owner);
    assert.equal(assigned.status, 'assigned');
    if (assigned.status !== 'assigned') throw new Error('Missing issued UID');
    assert.equal(assigned.uid, '1001');
    const replay = await withCommunityScopeWriter(f.pool, (tx) =>
      applySyntheticInventory(input, f.home.institutionId, tx),
    );
    assert.equal(replay.replay, true);
    assert.equal(replay.admissionId, first.admissionId);
    assert.equal(replay.highWater, first.highWater);
    const lower = await withCommunityScopeWriter(f.pool, (tx) =>
      applySyntheticInventory(
        syntheticUidInventory(f.home, '100'),
        f.home.institutionId,
        tx,
      ),
    );
    assert.equal(lower.stale, true);
    assert.equal(
      (
        await f.pool.query(
          'SELECT high_water::text FROM whaleu_school_uid.admission_heads WHERE institution_id=$1',
          [f.home.institutionId],
        )
      ).rows[0].high_water,
      '1001',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.allocations WHERE institution_id=$1',
          [f.home.institutionId],
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  'admitted synthetic imports retain exact ownership inside reservation floor and explicit covered missing account history',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    // Reproduce accounts created before native Verification enrollment. The
    // real Identity owner supplies Safety/Experience creation baselines; no
    // imported account is relabeled as having native Verification lineage.
    const historicalIdentity = new IdentityRepository(
      f.app.get(DatabaseService),
      {
        ...f.app.get<RuntimeConfig>(APP_CONFIG),
        NATIVE_VERIFICATION_ENROLLMENT: 'disabled',
      },
    );
    const historicalAccount = async () =>
      (
        await historicalIdentity.createSession(
          {
            provider: 'wechat',
            appId: 'synthetic-historical-uid-import',
            subject: randomUUID(),
          },
          {
            access: hashToken(mintToken('access')),
            refresh: hashToken(mintToken('refresh')),
          },
        )
      ).accountId;
    const current = await historicalAccount(),
      missing = await historicalAccount();
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_verification.native_enrollments WHERE account_id=ANY($1::uuid[])',
          [[current, missing]],
        )
      ).rows[0].n,
      0,
    );
    const input = syntheticUidInventory(f.deferred, '100');
    input.sourceInstance = 'synthetic-uid-import';
    const school = input.schools[0]!;
    school.accountCoverage = [
      {
        sourceAccountId: 'legacy-current',
        accountId: current,
        status: 'known_assigned',
      },
      {
        sourceAccountId: 'legacy-missing',
        accountId: missing,
        status: 'known_missing',
      },
    ];
    school.reservations = [
      {
        uid: { type: 'string', value: '7' },
        sourceAccountId: 'legacy-current',
        accountId: current,
        sourceSchoolId: school.sourceSchoolId,
        kind: 'historical',
      },
      {
        uid: { type: 'integer', value: '9' },
        sourceAccountId: 'legacy-current',
        accountId: current,
        sourceSchoolId: school.sourceSchoolId,
        kind: 'current',
      },
    ];
    await withCommunityScopeWriter(f.pool, async (tx) => {
      for (const [id, legacy] of [
        [current, 'legacy-current'],
        [missing, 'legacy-missing'],
      ] as const) {
        await tx.query(
          'INSERT INTO whaleu_identity.legacy_account_mappings(source_system,legacy_id,account_id) VALUES($1,$2,$3)',
          [input.sourceInstance, legacy, id],
        );
      }
    });
    await setRuntimeVerification(
      f.pool,
      current,
      f.deferred.institutionId,
      f.deferred.regionId,
    );
    await setRuntimeVerification(
      f.pool,
      missing,
      f.deferred.institutionId,
      f.deferred.regionId,
    );
    const historical = await withCommunityScopeWriter(f.pool, (tx) =>
      applySyntheticAccountInventory(
        input,
        {
          institutionId: f.deferred.institutionId,
          accountId: current,
          mode: 'historical',
          uid: '7',
        },
        tx,
      ),
    );
    assert.equal(historical.eventId, null);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.account_heads WHERE account_id=$1',
          [current],
        )
      ).rows[0].n,
      0,
    );
    const imported = await withCommunityScopeWriter(f.pool, (tx) =>
      applySyntheticAccountInventory(
        input,
        {
          institutionId: f.deferred.institutionId,
          accountId: current,
          mode: 'current',
          uid: '9',
        },
        tx,
      ),
    );
    const view = (
      await f.pool.query('SELECT whaleu_school_uid.projection($1) value', [
        current,
      ])
    ).rows[0].value;
    assert.equal(view.status, 'assigned');
    assert.equal(view.uid, '9');
    assert.equal(view.formattedUid, '000009');
    assert.equal(
      (
        await f.pool.query(
          'SELECT high_water::text FROM whaleu_school_uid.admission_heads WHERE institution_id=$1',
          [f.deferred.institutionId],
        )
      ).rows[0].high_water,
      '100',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.counter_transitions WHERE allocation_id=$1',
          [imported.allocationId],
        )
      ).rows[0].n,
      0,
    );
    const replay = await withCommunityScopeWriter(f.pool, (tx) =>
      applySyntheticAccountInventory(
        input,
        {
          institutionId: f.deferred.institutionId,
          accountId: current,
          mode: 'current',
          uid: '9',
        },
        tx,
      ),
    );
    assert.equal(replay.replay, true);
    assert.equal(replay.allocationId, imported.allocationId);
    const absent = await withCommunityScopeWriter(f.pool, (tx) =>
      applySyntheticAccountInventory(
        input,
        {
          institutionId: f.deferred.institutionId,
          accountId: missing,
          mode: 'covered_missing',
        },
        tx,
      ),
    );
    assert.equal(absent.allocationId, null);
    assert.equal(
      (
        await f.pool.query(
          'SELECT whaleu_school_uid.coverage_valid($1) valid',
          [missing],
        )
      ).rows[0].valid,
      true,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT outcome FROM whaleu_school_uid.assignment_events WHERE id=$1',
          [absent.eventId],
        )
      ).rows[0].outcome,
      'covered_missing',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.issuance_decisions',
        )
      ).rows[0].n,
      0,
    );
    // Resolve the public target through the real Profile owner. Imported targets
    // need no fabricated native enrollment or session to be reviewed by an admin.
    const display = await f.app
      .get(DatabaseService)
      .transaction((tx) =>
        f.app.get(ProfileRepository).authorDisplay(current, tx),
      );
    const unchanged = await f.correct(
      f.admin,
      display.profileId,
      f.deferred.campusId,
    );
    assert.equal(unchanged.receipt.outcome, 'unchanged');
    assert.equal(
      (
        await f.pool.query('SELECT whaleu_school_uid.projection($1) value', [
          current,
        ])
      ).rows[0].value.uid,
      '9',
    );
    assert.equal(
      (await f.correct(f.admin, display.profileId, f.destination.campusId))
        .receipt.outcome,
      'applied',
    );
    assert.equal(
      (
        await f.pool.query('SELECT whaleu_school_uid.projection($1) value', [
          current,
        ])
      ).rows[0].value.uid,
      '1',
    );
    assert.equal(
      (await f.correct(f.admin, display.profileId, f.deferred.campusId)).receipt
        .outcome,
      'applied',
    );
    assert.equal(
      (
        await f.pool.query('SELECT whaleu_school_uid.projection($1) value', [
          current,
        ])
      ).rows[0].value.uid,
      '101',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT whaleu_school_uid.allocation_valid($1) valid',
          [imported.allocationId],
        )
      ).rows[0].valid,
      true,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.allocations WHERE account_id=$1',
          [current],
        )
      ).rows[0].n,
      4,
    );
    await assert.rejects(() =>
      withCommunityScopeWriter(f.pool, (tx) =>
        applySyntheticAccountInventory(
          input,
          {
            institutionId: f.deferred.institutionId,
            accountId: current,
            mode: 'historical',
            uid: '8',
          },
          tx,
        ),
      ),
    );
    // A regular native account cannot be reclassified as imported by supplying a mapping.
    const native = await f.actor();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'INSERT INTO whaleu_identity.legacy_account_mappings(source_system,legacy_id,account_id) VALUES($1,$2,$3)',
        [input.sourceInstance, 'native-collision', native.accountId],
      ),
    );
    const forged = structuredClone(input);
    forged.schools[0]!.accountCoverage = [
      {
        sourceAccountId: 'native-collision',
        accountId: native.accountId,
        status: 'known_missing',
      },
    ];
    forged.schools[0]!.reservations = [];
    await assert.rejects(() =>
      withCommunityScopeWriter(f.pool, (tx) =>
        applySyntheticAccountInventory(
          forged,
          {
            institutionId: f.deferred.institutionId,
            accountId: native.accountId,
            mode: 'covered_missing',
          },
          tx,
        ),
      ),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.account_coverage WHERE account_id=$1',
          [native.accountId],
        )
      ).rows[0].n,
      0,
    );
  },
);

test(
  'future issuance suspension keeps historical projection and same-school no-op valid',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      profile = await f.profile(owner);
    await f.approve(f.admin, await f.submit(owner));
    const original = await f.own(owner);
    const suspend = syntheticUidInventory(f.home, '0');
    suspend.schools[0]!.classification = 'reconciled';
    suspend.schools[0]!.issuanceAvailable = false;
    await withCommunityScopeWriter(f.pool, (tx) =>
      applySyntheticInventory(suspend, f.home.institutionId, tx),
    );
    assert.deepEqual(await f.own(owner), original);
    assert.equal(
      (await f.correct(f.admin, profile, f.scope.related.campusId)).receipt
        .outcome,
      'unchanged',
    );
    const waiting = await f.actor();
    await f.approve(f.admin, await f.submit(waiting));
    assert.deepEqual(await f.own(waiting), { status: 'unavailable' });
    assert.equal(
      (
        await f.pool.query(
          'SELECT high_water::text FROM whaleu_school_uid.admission_heads WHERE institution_id=$1',
          [f.home.institutionId],
        )
      ).rows[0].high_water,
      '1',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT outcome,unavailable_reason FROM whaleu_school_uid.issuance_decisions i JOIN whaleu_verification.student_decisions d ON d.id=i.student_decision_id WHERE d.account_id=$1',
          [waiting.accountId],
        )
      ).rows[0].unavailable_reason,
      'inventory_unknown',
    );
  },
);

test(
  'pre-wait native absence rejects a mapping inserted after its original observation',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      application = await f.submit(owner);
    const database = f.app.get(DatabaseService),
      original = database.transaction,
      run = original.bind(database);
    let inserted = false;
    database.transaction = (work, options) =>
      run(async (tx) => {
        const raw = tx.query,
          query = raw.bind(tx);
        tx.query = (async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (
            !inserted &&
            sql.startsWith(
              'INSERT INTO whaleu_school_uid.native_absence_observations',
            ) &&
            values?.[1] === owner.accountId
          ) {
            inserted = true;
            await f.pool.query(
              'INSERT INTO whaleu_identity.legacy_account_mappings(source_system,legacy_id,account_id) VALUES($1,$2,$3)',
              ['synthetic-late-uid-mapping', randomUUID(), owner.accountId],
            );
          }
          return result;
        }) as PoolClient['query'];
        try {
          return await work(tx);
        } finally {
          tx.query = raw;
        }
      }, options);
    try {
      const response = await request(f.app.getHttpServer())
        .post(
          `/v1/student-verification-review/regions/${f.home.regionId}/applications/${application.id}/decision`,
        )
        .set('Authorization', `Bearer ${f.admin.accessToken}`)
        .send({
          clientRequestId: randomUUID(),
          expectedRevision: application.revision,
          decision: 'approved',
        });
      assert.ok(response.status >= 400, JSON.stringify(response.body));
    } finally {
      database.transaction = original;
    }
    assert.equal(inserted, true);
    assert.equal(
      (
        await f.pool.query(
          'SELECT state FROM whaleu_verification.student_applications WHERE id=$1',
          [application.id],
        )
      ).rows[0].state,
      'pending',
    );
    for (const table of [
      'account_coverage',
      'allocations',
      'assignment_events',
    ])
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::int n FROM whaleu_school_uid.${table} WHERE account_id=$1`,
            [owner.accountId],
          )
        ).rows[0].n,
        0,
      );
  },
);

test(
  'raw synthetic admission cannot turn missing JSON inventory or ambiguous current ownership into a zero floor',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const base = syntheticUidInventory(f.deferred, '100');
    const owner = randomUUID();
    const reservation = (uid: string) => ({
      uid: { type: 'string', value: uid },
      sourceAccountId: 'legacy-one',
      accountId: owner,
      sourceSchoolId: f.deferred.schoolCode,
      kind: 'current',
    });
    const cases: [
      string,
      (school: Record<string, unknown>, raw: Record<string, unknown>) => void,
    ][] = [
      ...[
        'reservations',
        'trustedCounters',
        'unresolvedConflicts',
        'priorAdmittedFloor',
      ].map((field): [string, (school: Record<string, unknown>) => void] => [
        `missing ${field}`,
        (school) => {
          delete school[field];
        },
      ]),
      [
        'missing UID raw type',
        (school) => {
          school['reservations'] = [
            { ...reservation('1'), uid: { value: '1' } },
          ];
        },
      ],
      [
        'missing UID raw value',
        (school) => {
          school['reservations'] = [
            { ...reservation('1'), uid: { type: 'integer' } },
          ];
        },
      ],
      [
        'two current numbers for one account',
        (school) => {
          school['reservations'] = [reservation('1'), reservation('2')];
        },
      ],
      [
        'known missing contradicts current owner',
        (school) => {
          school['reservations'] = [reservation('1')];
          school['accountCoverage'] = [
            {
              sourceAccountId: 'legacy-one',
              accountId: owner,
              status: 'known_missing',
            },
          ];
        },
      ],
      [
        'negative infinite source cutoff',
        (_school, raw) => {
          raw['sourceCutoff'] = '-infinity';
        },
      ],
      [
        'positive infinite source cutoff',
        (_school, raw) => {
          raw['sourceCutoff'] = 'infinity';
        },
      ],
      [
        'future source cutoff',
        (_school, raw) => {
          raw['sourceCutoff'] = '9999-01-01T00:00:00Z';
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      const raw = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      const school = (raw['schools'] as Record<string, unknown>[])[0]!;
      mutate(school, raw);
      await assert.rejects(
        () =>
          withCommunityScopeWriter(f.pool, async (tx) => {
            const batch = randomUUID();
            const manifest = {
              package: raw,
              acceptedSchools: [
                {
                  institutionId: f.deferred.institutionId,
                  classification: 'reconciled',
                  reservedFloor: '100',
                  issuanceAvailable: true,
                },
              ],
            };
            await tx.query(
              `INSERT INTO whaleu_school_uid.inventory_batches(id,format_version,package_digest,source_instance,source_cutoff,snapshot_digest,mapping_digest,acceptance_digest,writer_cutover_digest,classification,manifest) VALUES($1,'school-uid-inventory/v1',$2,$3,$4,$5,$6,$7,$8,'synthetic',$9::jsonb)`,
              [
                batch,
                inventoryDigest(raw),
                base.sourceInstance,
                raw['sourceCutoff'],
                base.snapshotDigest,
                inventoryDigest([
                  base.schoolCrosswalkDigest,
                  base.accountCrosswalkDigest,
                ]),
                base.reviewerAcceptanceDigest,
                inventoryDigest([
                  base.writerQuiescenceDigest,
                  base.finalDeltaDigest,
                ]),
                JSON.stringify(manifest),
              ],
            );
            await tx.query(
              "INSERT INTO whaleu_school_uid.school_admissions(id,institution_id,revision,batch_id,classification,reserved_floor) VALUES($1,$2,1,$3,'reconciled',100)",
              [randomUUID(), f.deferred.institutionId, batch],
            );
          }),
        name,
      );
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.admission_heads WHERE institution_id=$1',
          [f.deferred.institutionId],
        )
      ).rows[0].n,
      0,
    );
  },
);

test(
  'generic account and provider identity without native enrollment cannot manufacture lazy UID absence',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const subject = 'missing-native-' + randomUUID();
    // The supported disabled lifecycle path creates real Identity, Safety and
    // Experience owner facts, but deliberately has no Verification enrollment.
    const identity = new IdentityRepository(f.app.get(DatabaseService), {
      ...f.app.get<RuntimeConfig>(APP_CONFIG),
      NATIVE_VERIFICATION_ENROLLMENT: 'disabled',
    });
    const created = await identity.createSession(
      { provider: 'wechat', appId: 'wx0000000000000000', subject },
      {
        access: hashToken(mintToken('access')),
        refresh: hashToken(mintToken('refresh')),
      },
    );
    const owner = await f.actor(subject);
    assert.equal(owner.accountId, created.accountId);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_identity.provider_identities WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_verification.native_enrollments WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows[0].n,
      0,
    );
    // Generic complete Verification facts are not original native lineage.
    await setRuntimeVerification(
      f.pool,
      owner.accountId,
      f.home.institutionId,
      f.home.regionId,
      'unverified',
    );
    await f.approve(f.admin, await f.submit(owner));
    assert.deepEqual(await f.own(owner), { status: 'unavailable' });
    assert.equal(
      (
        await f.pool.query(
          'SELECT whaleu_school_uid.native_identity_proof($1) proof',
          [owner.accountId],
        )
      ).rows[0].proof,
      null,
    );
    const decision = (
      await f.pool.query(
        'SELECT i.outcome,i.unavailable_reason FROM whaleu_school_uid.issuance_decisions i JOIN whaleu_verification.student_decisions d ON d.id=i.student_decision_id WHERE d.account_id=$1',
        [owner.accountId],
      )
    ).rows[0];
    assert.deepEqual(decision, {
      outcome: 'deferred_unavailable',
      unavailable_reason: 'account_history_unknown',
    });
    for (const table of ['account_coverage', 'allocations'])
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::int n FROM whaleu_school_uid.${table} WHERE account_id=$1`,
            [owner.accountId],
          )
        ).rows[0].n,
        0,
      );
  },
);

test(
  'a committed UID owner invalidates an earlier absence observation and cannot lend its producing cause to another native account',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      other = await f.actor(),
      application = await f.submit(owner);
    const coverage = new SchoolUidCoverageFacade();
    await f.app.get(DatabaseService).transaction(async (tx) => {
      const observation = await coverage.observeNativeAbsence(
        owner.accountId,
        tx,
      );
      await f.approve(f.admin, application);
      const row = (
        await tx.query(
          'SELECT o.native_proof IS NOT NULL native, o.history_proof IS DISTINCT FROM whaleu_school_uid.account_history_proof(o.account_id) changed FROM whaleu_school_uid.native_absence_observations o WHERE o.id=$1',
          [observation.id],
        )
      ).rows[0];
      assert.deepEqual(row, { native: true, changed: true });
      const cause = (
        await tx.query(
          'SELECT cause_id FROM whaleu_school_uid.account_heads WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows[0].cause_id;
      await assert.rejects(
        coverage.establishNativeAbsence(
          owner.accountId,
          cause,
          observation,
          tx,
        ),
        (error: unknown) =>
          (error as { code: string }).code === 'SCHOOL_UID_UNAVAILABLE',
      );
      const otherObservation = await coverage.observeNativeAbsence(
        other.accountId,
        tx,
      );
      await assert.rejects(
        coverage.establishNativeAbsence(
          other.accountId,
          cause,
          otherObservation,
          tx,
        ),
        (error: unknown) =>
          (error as { code: string }).code === 'SCHOOL_UID_UNAVAILABLE',
      );
    });
    for (const table of [
      'account_coverage',
      'allocations',
      'assignment_events',
    ]) {
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::int n FROM whaleu_school_uid.${table} WHERE account_id=$1`,
            [owner.accountId],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::int n FROM whaleu_school_uid.${table} WHERE account_id=$1`,
            [other.accountId],
          )
        ).rows[0].n,
        0,
      );
    }
  },
);
