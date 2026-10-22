/** Current-catalog rejection, distinct from historical 0174 owner completion.
 * Uses actual migrations, synthetic Identity/reauthentication, service and worker.
 * No source relation is admitted to erasure and no schema/guard is weakened. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import {
  COOLING_MS,
  DeletionError,
} from '../../src/account-deletion/contracts.js';
import {
  inventory,
  preflight,
} from '../../src/account-deletion/owners/preflight.js';
import { accountDeletionFixture } from '../support/account-deletion-fixture.js';

const inventoryDenied = (code: string) => (error: unknown) =>
  error instanceof DeletionError && error.code === code;
const command = () => ({
  version: 1,
  requestId: randomUUID(),
  expectedGeneration: '0',
  consent: 'account-deletion-explicit-v1',
});

test(
  'default current deletion fixture rejects the unregistered real deletion owner, even with no source rows',
  { timeout: 120000 },
  async () => {
    // The fixture owns disposal on failed construction. Its default must still
    // apply the actual full catalog, never silently pin a historical prefix.
    await assert.rejects(
      accountDeletionFixture(),
      inventoryDenied('UNREGISTERED_OWNER_SCHEMA'),
    );
  },
);

test(
  'real current service and worker fail closed after source, reading, Home, registration, epoch, preparation and request installation without erasing any owner data',
  { timeout: 240000 },
  async (t) => {
    const f = await accountDeletionFixture({ throughMigration: 174 });
    t.after(() => f.close());
    const active = await f.create(),
      pending = await f.create(),
      historical = await f.create();
    await f.populate(pending);
    await f.populate(historical);
    const pendingObject = f.media.create(
      [pending.accountId],
      Buffer.from('retained generated pending payload'),
    );
    const historicalObject = f.media.create(
      [historical.accountId],
      Buffer.from('erased generated historical control payload'),
    );
    assert.deepEqual(await f.service.eligibility(f.assertion(active)), {
      status: 'eligible',
      blockers: [],
      generation: '0',
    });
    const acceptedCommand = command();
    const accepted = await f.service.request(
      f.assertion(pending),
      acceptedCommand,
    );
    assert.equal(accepted.status.phase, 'cooling');
    assert.ok(accepted.receiptRecoveryKey);
    const historicalCommand = command();
    const historicalAccepted = await f.service.request(
      f.assertion(historical),
      historicalCommand,
    );
    assert.equal(historicalAccepted.status.phase, 'cooling');
    // Existing reviewed synthetic-clock path: advance changes only the sandbox
    // now_at via f.advance(). No wall-clock seven-day wait, trigger disabling,
    // request timestamp rewriting or fabricated cause/revision is involved.
    await f.advance(COOLING_MS);
    const due = await f.repository.transaction(async (tx) => {
      const context = await f.repository.context(tx, pending.accountId);
      const row = await f.repository.request(tx, acceptedCommand.requestId);
      return context.now_at.getTime() >= row.eligible_at.getTime();
    });
    assert.equal(due, true, 'The real pending request is no longer cooling');
    let historicalStatus = historicalAccepted.status;
    for (let i = 0; i < 16 && historicalStatus.phase !== 'completed'; i++)
      historicalStatus = await f.worker.tick(historicalCommand.requestId);
    assert.equal(historicalStatus.phase, 'completed');
    assert.deepEqual(historicalStatus.pending, []);
    assert.ok(historicalStatus.completedAt);
    assert.equal(f.media.exists(historicalObject), false);
    assert.equal(
      (
        await f.pool.query<{ count: number }>(
          'SELECT count(*)::integer count FROM whaleu_account_deletion.owner_receipts WHERE request_id=$1',
          [historicalCommand.requestId],
        )
      ).rows[0]!.count,
      7,
      'The same real worker and seven historical owners must succeed before upgrade',
    );
    assert.deepEqual(await f.service.eligibility(f.assertion(active)), {
      status: 'eligible',
      blockers: [],
      generation: '0',
    });
    assert.equal(
      (
        await f.pool.query<{ valid: boolean }>(
          'SELECT whaleu_account_deletion.inventory_current($1) valid',
          [acceptedCommand.requestId],
        )
      ).rows[0]!.valid,
      true,
      'The exact SQL inventory predicate must admit the pending request before upgrade',
    );
    const activeContext = await f.repository.transaction((tx) =>
      f.repository.context(tx, active.accountId),
    );
    const immutableSeal = async () =>
      (
        await f.pool.query<{ value: unknown }>(`SELECT jsonb_build_object(
          'sandboxes',(SELECT jsonb_agg(to_jsonb(s)-'now_at' ORDER BY id) FROM whaleu_account_deletion.sandboxes s),
          'inventory',(SELECT jsonb_agg(to_jsonb(i) ORDER BY sandbox_id,relation COLLATE "C") FROM whaleu_account_deletion.inventory i)
        ) value`)
      ).rows[0]!.value;
    const activeState = async () =>
      (
        await f.pool.query<{
          value: {
            account: Record<string, unknown>;
            requests: unknown[];
            commands: unknown[];
          };
        }>(
          `SELECT jsonb_build_object(
            'account',(SELECT to_jsonb(a) FROM whaleu_identity.accounts a WHERE id=$1),
            'requests',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb) FROM whaleu_account_deletion.requests r WHERE account_id=$1),
            'commands',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY command_id),'[]'::jsonb) FROM whaleu_account_deletion.commands c WHERE account_id=$1)
          ) value`,
          [active.accountId],
        )
      ).rows[0]!.value;
    const retainedOwnerData = async () =>
      (
        await f.pool.query<{
          value: Record<string, unknown> & {
            sessions: Record<string, unknown>[] | null;
          };
        }>(`SELECT jsonb_build_object(
          'identities',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C") FROM whaleu_identity.provider_identities t),
          'sessions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM whaleu_identity.sessions t),
          'access',(SELECT jsonb_agg(to_jsonb(t) ORDER BY token_hash) FROM whaleu_identity.access_tokens t),
          'refresh',(SELECT jsonb_agg(to_jsonb(t) ORDER BY token_hash) FROM whaleu_identity.refresh_tokens t),
          'profiles',(SELECT jsonb_agg(to_jsonb(t) ORDER BY account_id) FROM whaleu_profile.profiles t),
          'details',(SELECT jsonb_agg(to_jsonb(t) ORDER BY account_id) FROM whaleu_profile.details t),
          'terms',(SELECT jsonb_agg(to_jsonb(t) ORDER BY account_id,term_id) FROM whaleu_timetable.terms t),
          'entries',(SELECT jsonb_agg(to_jsonb(t) ORDER BY account_id,entry_id) FROM whaleu_timetable.entries t)
        ) value`)
      ).rows[0]!.value;
    const ownerEvidence = async () =>
      (
        await f.pool.query<{ causes: number; receipts: number }>(
          `SELECT
            (SELECT count(*)::integer FROM whaleu_account_deletion.owner_causes WHERE request_id=$1) causes,
            (SELECT count(*)::integer FROM whaleu_account_deletion.owner_receipts WHERE request_id=$1) receipts`,
          [acceptedCommand.requestId],
        )
      ).rows[0]!;
    const catalog = async () =>
      (
        await f.pool.query<{ relation: string }>(
          "SELECT n.nspname||'.'||c.relname relation FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\\_%' ESCAPE '\\' AND c.relkind IN('r','p','m','f')",
        )
      ).rows
        .map((row) => row.relation)
        .sort();
    const historicalCatalog = await catalog();
    const beforeSeal = await immutableSeal(),
      beforeActive = await activeState(),
      beforePrivate = await retainedOwnerData();
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    );
    assert.ok(
      migrations.some((m) => m.name === '0175_community_text_sources.sql'),
    );
    await runMigrations(
      f.pool,
      migrations.filter((m) => Number(m.name.slice(0, 4)) <= 175),
      { mode: 'up' },
    );
    assert.deepEqual(await immutableSeal(), beforeSeal);
    let previousWaiting: typeof accepted.status | undefined;
    // Keep the original 0175/0176 inventories exact. Later owners are separate
    // upgrade stages, not an expansion of the deletion owner's reviewed bound.
    const stages = [
      {
        stage: 'M1 source only',
        throughMigration: 175,
        relations: ['whaleu_community.community_text_sources'],
      },
      {
        stage: 'M2 empty derived owner',
        throughMigration: 176,
        relations: [
          'whaleu_community.reading_format_heads',
          'whaleu_community.reading_format_jobs',
          'whaleu_community.reading_format_results',
          'whaleu_community.reading_format_slots',
        ],
      },
      {
        stage: 'Home policy admission owner',
        throughMigration: 177,
        relations: [
          'whaleu_community.home_policy_admissions',
          'whaleu_community.home_policy_head',
          'whaleu_community.home_policy_preparations',
        ],
      },
      {
        stage: 'Home publication owner',
        throughMigration: 178,
        relations: [
          'whaleu_community.home_discussion_parent_bindings',
          'whaleu_community.home_post_dispositions',
          'whaleu_community.home_publication_activations',
          'whaleu_community.home_publication_head',
          'whaleu_community.home_publication_preparations',
        ],
      },
      {
        stage: 'Registration owner',
        throughMigration: 179,
        relations: [
          'whaleu_identity.registration_guard_key_epochs',
          'whaleu_identity.registration_guard_policy',
          'whaleu_identity.registration_guards',
        ],
      },
      {
        stage: 'Session epoch foundation',
        throughMigration: 180,
        relations: [],
      },
      {
        stage: 'Real deletion preparation owner',
        throughMigration: 181,
        relations: ['whaleu_real_deletion.preparations'],
      },
      {
        stage: 'Current real deletion request owner',
        // Still install the full current catalog. A future unreviewed relation
        // must fail the exact inventory comparison, never disappear behind a pin.
        throughMigration: undefined,
        relations: [
          'whaleu_real_deletion_admission.receipts',
          'whaleu_real_deletion.reauthentication_attempts',
          'whaleu_real_deletion.provider_captures',
          'whaleu_real_deletion.requests',
          'whaleu_real_deletion.cancellations',
        ],
      },
    ] as const;
    const addedRelations: string[] = [];
    for (const { stage, throughMigration, relations } of stages) {
      if (throughMigration !== 175) {
        await runMigrations(
          f.pool,
          throughMigration === undefined
            ? migrations
            : migrations.filter(
                (m) => Number(m.name.slice(0, 4)) <= throughMigration,
              ),
          { mode: 'up' },
        );
      }
      // 0180 adds numeric zero epochs; 0182 adds only a null real request pointer.
      // Qualify full migrated snapshots before testing denied actions. Neither
      // predecessor fields nor either exact additive default may be ignored.
      const hasSessionEpoch =
        throughMigration === undefined || throughMigration >= 180;
      const hasRealRequest =
        throughMigration === undefined || throughMigration >= 182;
      const migratedActive = await activeState();
      const migratedPrivate = await retainedOwnerData();
      assert.deepEqual(
        migratedActive,
        hasSessionEpoch
          ? {
              ...beforeActive,
              account: {
                ...beforeActive.account,
                session_revocation_epoch: 0,
                ...(hasRealRequest ? { real_deletion_request_id: null } : {}),
              },
            }
          : beforeActive,
        'Only the initial account epoch and null real request pointer may be added by the current upgrade',
      );
      assert.deepEqual(
        migratedPrivate,
        hasSessionEpoch
          ? {
              ...beforePrivate,
              sessions:
                beforePrivate.sessions?.map((session) => ({
                  ...session,
                  issued_revocation_epoch: 0,
                })) ?? null,
            }
          : beforePrivate,
        'Only initial session epochs may be added by the current upgrade',
      );
      addedRelations.push(...relations);
      const hasDerivedOwner =
        throughMigration === undefined || throughMigration >= 176;
      assert.deepEqual(
        await catalog(),
        [...historicalCatalog, ...addedRelations].sort(),
        'Only the exact added owner relations may exceed the reviewed catalog bound',
      );
      const sourceBefore = (
        await f.pool.query<{ count: number }>(
          'SELECT count(*)::integer count FROM whaleu_community.community_text_sources',
        )
      ).rows[0]!.count;
      assert.equal(sourceBefore, 0, stage);
      const derivedBefore = hasDerivedOwner
        ? (
            await f.pool.query<{ value: unknown }>(`SELECT jsonb_build_object(
              'heads',(SELECT count(*) FROM whaleu_community.reading_format_heads),
              'jobs',(SELECT count(*) FROM whaleu_community.reading_format_jobs),
              'results',(SELECT count(*) FROM whaleu_community.reading_format_results),
              'slots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY slot_id) FROM whaleu_community.reading_format_slots s)
            ) value`)
          ).rows[0]!.value
        : null;
      // 0181/0182 introduce new schemas, rejected before the relation-count gate.
      const denialCode =
        throughMigration === undefined || throughMigration >= 181
          ? 'UNREGISTERED_OWNER_SCHEMA'
          : 'INVENTORY_BOUND_EXCEEDED';
      const denied = inventoryDenied(denialCode);
      await assert.rejects(
        f.repository.transaction((tx) => inventory(tx, true)),
        denied,
        stage,
      );
      await assert.rejects(
        f.repository.transaction((tx) =>
          preflight(tx, activeContext.sandbox_id),
        ),
        denied,
        stage,
      );
      await assert.rejects(
        f.service.eligibility(f.assertion(active)),
        denied,
        stage,
      );
      await assert.rejects(
        f.service.request(f.assertion(active), command()),
        denied,
        stage,
      );
      assert.deepEqual(
        await activeState(),
        migratedActive,
        'Rejected new requests cannot change account, command, receipt or lifecycle',
      );
      const waiting = await f.worker.tick(acceptedCommand.requestId);
      assert.equal(waiting.phase, 'waiting', stage);
      assert.deepEqual(waiting.pending, [denialCode], stage);
      assert.equal(waiting.completedAt, null);
      assert.equal(waiting.reregisterAfter, null);
      if (previousWaiting)
        assert.deepEqual(
          waiting,
          throughMigration === 181
            ? {
                ...previousWaiting,
                pending: [denialCode],
                revision: String(BigInt(previousWaiting.revision) + 1n),
              }
            : previousWaiting,
          'A new owner schema may only change the waiting reason and its revision',
        );
      assert.deepEqual(
        await f.worker.tick(acceptedCommand.requestId),
        waiting,
        'Repeated catalog denial must not advance the waiting cursor',
      );
      previousWaiting = waiting;
      assert.deepEqual(await ownerEvidence(), { causes: 0, receipts: 0 });
      assert.equal(f.media.exists(pendingObject), true);
      assert.deepEqual(
        await retainedOwnerData(),
        migratedPrivate,
        'No Identity/Profile/Timetable data can be erased on inventory denial',
      );
      assert.equal(
        (
          await f.pool.query<{ valid: boolean }>(
            'SELECT whaleu_account_deletion.inventory_current($1) valid',
            [acceptedCommand.requestId],
          )
        ).rows[0]!.valid,
        false,
      );
      // Supply the real current cause first, isolating inventory rejection from
      // a generic missing-cause failure. The entire failed attempt must roll back.
      await assert.rejects(
        f.repository.transaction(async (tx) => {
          const row = await f.repository.request(tx, acceptedCommand.requestId);
          await f.repository.cause(tx, row, 'unsupported-inventory');
          assert.equal(
            (
              await tx.query<{ valid: boolean }>(
                "SELECT whaleu_account_deletion.owner_cause($1,'unsupported-inventory') valid",
                [pending.accountId],
              )
            ).rows[0]!.valid,
            true,
          );
          await f.repository.proof(
            tx,
            row,
            'unsupported-inventory',
            'a'.repeat(64),
          );
        }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === '23514' &&
          error.message === 'Owner receipt requires actual erasure evidence',
        stage,
      );
      assert.deepEqual(
        await ownerEvidence(),
        { causes: 0, receipts: 0 },
        'The deliberate cause and failed receipt must both roll back',
      );
      assert.deepEqual(await immutableSeal(), beforeSeal);
      assert.equal(
        (
          await f.pool.query<{ count: number }>(
            'SELECT count(*)::integer count FROM whaleu_community.community_text_sources',
          )
        ).rows[0]!.count,
        sourceBefore,
      );
      if (hasDerivedOwner) {
        const after = (
          await f.pool.query<{ value: unknown }>(`SELECT jsonb_build_object(
          'heads',(SELECT count(*) FROM whaleu_community.reading_format_heads),
          'jobs',(SELECT count(*) FROM whaleu_community.reading_format_jobs),
          'results',(SELECT count(*) FROM whaleu_community.reading_format_results),
          'slots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY slot_id) FROM whaleu_community.reading_format_slots s)
        ) value`)
        ).rows[0]!.value;
        assert.deepEqual(
          after,
          derivedBefore,
          'Unqualified deletion cannot clear slots or mutate derived work',
        );
      }
    }
  },
);
