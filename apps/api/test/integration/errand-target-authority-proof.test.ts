import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { inTransaction } from '../../src/database/database.js';
import {
  checkpointTransactionDeadlines,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  restoreTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { ProfileAdminParticipantFacade } from '../../src/profile/admin-participant.facade.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';

const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  'E2B Authorization final target absence uses independent noncooperating grant writers',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    const authorization = f.app.get(AuthorizationService);
    const target = async () =>
      (await f.actor({ identity: false, affiliation: 'unverified' })).accountId;
    const transaction = <T>(work: (tx: PoolClient) => Promise<T>) =>
      inTransaction(f.pool, work, { isolationLevel: 'read committed' });
    const instrument = (
      query: (
        client: PoolClient,
        sql: string,
        values?: unknown[],
      ) => Promise<QueryResult>,
    ) => ({
      connect: async () => {
        const client = await f.pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === 'query')
              return (sql: string, values?: unknown[]) =>
                query(target, sql, values);
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    });
    const grant = async (
      account: string,
      options: {
        role?: 'developer' | 'super_admin' | 'school_admin';
        region?: string;
        from?: string;
        until?: string;
      } = {},
      client: Pick<PoolClient, 'query'> = f.pool,
    ) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from,expires_at)
       VALUES($1,$2,$3,$4,$2,'Synthetic E2B final proof',$5::timestamptz,$6::timestamptz)`,
        [
          id,
          account,
          options.role ?? 'developer',
          options.region ?? null,
          options.from ?? '2000-01-01T00:00:00Z',
          options.until ?? null,
        ],
      );
      return id;
    };
    const effect = async (
      tx: PoolClient,
      key: string,
      waitKey: string | null = null,
    ) => {
      await tx.query(
        'INSERT INTO whaleu_authorization.synthetic_errand_effects(id,wait_key) VALUES($1,$2)',
        [key, waitKey],
      );
    };
    const exists = async (key: string) =>
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_authorization.synthetic_errand_effects WHERE id=$1',
          [key],
        )
      ).rowCount !== 0;
    const command = async (
      account: string,
      key: string,
      after = async (_tx: PoolClient) => {},
    ) =>
      transaction(async (tx) => {
        await lockSafetyPolicy(tx, true);
        await authorization.requireUnprotectedErrandTarget(account, tx);
        await effect(tx, key);
        await after(tx);
      });
    const future = async (milliseconds = 400) =>
      (
        await f.pool.query<{ at: string }>(
          "SELECT (clock_timestamp()+$1::integer*interval '1 millisecond')::text AS at",
          [milliseconds],
        )
      ).rows[0]!.at;
    const waitUntil = async (at: string) => {
      await f.pool.query(
        'SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.01)',
        [at],
      );
    };
    try {
      await f.pool
        .query(`CREATE TABLE whaleu_authorization.synthetic_errand_effects(id uuid PRIMARY KEY,wait_key bigint);
      CREATE FUNCTION whaleu_authorization.synthetic_errand_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.wait_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(NEW.wait_key); END IF; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER synthetic_errand_wait AFTER INSERT ON whaleu_authorization.synthetic_errand_effects
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_authorization.synthetic_errand_wait();`);

      await t.test(
        'all privileged roles protect, including other and inactive school regions; cosmetic names do not',
        async () => {
          const inactive = randomUUID();
          await f.pool.query(
            "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic inactive E2B',false)",
            [inactive],
          );
          for (const options of [
            { role: 'developer' as const },
            { role: 'super_admin' as const },
            { role: 'school_admin' as const, region: f.scope.home.regionId },
            { role: 'school_admin' as const, region: inactive },
          ]) {
            const account = await target(),
              key = randomUUID();
            await grant(account, options);
            await assert.rejects(
              command(account, key),
              errorIs('ERRAND_RESTRICTION_TARGET_PROTECTED'),
            );
            assert.equal(await exists(key), false);
          }
          const account = await target(),
            key = randomUUID();
          await f.pool.query(
            "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES($1,'developer')",
            [account],
          );
          await command(account, key);
          assert.equal(await exists(key), true);
        },
      );

      await t.test(
        'direct INSERT committed after a negative precheck rolls back every effect and leaves key retryable',
        async () => {
          const account = await target(),
            key = randomUUID(),
            entered = deferred(),
            resume = deferred();
          const pending = command(account, key, async () => {
            entered.resolve();
            await resume.promise;
          });
          const rejected = assert.rejects(
            pending,
            errorIs('AUTHORIZATION_UNAVAILABLE'),
          );
          await entered.promise;
          const id = await grant(account);
          resume.resolve();
          await rejected;
          assert.equal(await exists(key), false);
          await assert.rejects(
            command(account, key),
            errorIs('ERRAND_RESTRICTION_TARGET_PROTECTED'),
          );
          await f.pool.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
            [id],
          );
          await command(account, key);
          assert.equal(await exists(key), true);
        },
      );

      await t.test(
        'uncommitted INSERT and UPDATE, including unrelated subjects, cause immediate whole-command failure',
        async () => {
          for (const operation of [
            'insert-target',
            'insert-unrelated',
            'update-unrelated',
          ]) {
            const account = await target(),
              other = await target(),
              key = randomUUID();
            const id =
              operation === 'update-unrelated'
                ? await grant(other, { until: '2001-01-01T00:00:00Z' })
                : null;
            const holder = await f.pool.connect();
            try {
              await holder.query('BEGIN');
              if (id)
                await holder.query(
                  'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
                  [id],
                );
              else
                await grant(
                  operation === 'insert-target' ? account : other,
                  {},
                  holder,
                );
              const started = performance.now();
              await assert.rejects(
                command(account, key),
                errorIs('AUTHORIZATION_UNAVAILABLE'),
              );
              assert.ok(
                performance.now() - started < 2000,
                'NOWAIT must not await the writer transaction',
              );
              assert.equal(await exists(key), false);
              await holder.query('ROLLBACK');
              await command(account, key);
              assert.equal(await exists(key), true);
            } finally {
              await holder.query('ROLLBACK');
              holder.release();
            }
          }
        },
      );

      await t.test(
        'no-write FOR UPDATE holder may request Safety after its row lock without deadlocking final plain reads',
        async () => {
          const account = await target(),
            key = randomUUID();
          const id = await grant(account, { until: '2001-01-01T00:00:00Z' });
          const holder = await f.pool.connect(),
            entered = deferred(),
            resume = deferred();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_authorization.role_grants WHERE id=$1 FOR UPDATE',
              [id],
            );
            const pending = command(account, key, async () => {
              entered.resolve();
              await resume.promise;
            });
            await entered.promise;
            const waitingGate = lockSafetyPolicy(holder, true);
            await f.waitForLock('whaleu:named-block-policy:v1');
            resume.resolve();
            await pending;
            await waitingGate;
            await holder.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
              [id],
            );
            await holder.query('COMMIT');
            assert.equal(await exists(key), true);
          } finally {
            resume.resolve();
            await holder.query('ROLLBACK');
            holder.release();
          }
        },
      );

      await t.test(
        'a writer starting after the final SHARE fence waits while the command completes',
        async () => {
          const account = await target(),
            key = randomUUID(),
            fenced = deferred(),
            resume = deferred();
          const pending = command(account, key, async (tx) => {
            const after = {
              maximumFacts: 1,
              failureCode: 'AUTHORIZATION_UNAVAILABLE' as const,
              validate: async () => {
                fenced.resolve();
                await resume.promise;
              },
            };
            enableRequiredTransactionProof(tx, after);
            registerRequiredTransactionFact(
              tx,
              after,
              'after-fence',
              'after-fence',
            );
          });
          await fenced.promise;
          let writerDone = false;
          const writer = grant(account).then(() => {
            writerDone = true;
          });
          await f.waitForLock('INSERT INTO whaleu_authorization.role_grants');
          assert.equal(writerDone, false);
          resume.resolve();
          await pending;
          await writer;
          assert.equal(await exists(key), true);
          await assert.rejects(
            command(account, randomUUID()),
            errorIs('ERRAND_RESTRICTION_TARGET_PROTECTED'),
          );
        },
      );

      await t.test(
        'future activation during ordinary work rejects at the final exact SQL reread',
        async () => {
          const account = await target(),
            key = randomUUID(),
            at = await future();
          await grant(account, { from: at });
          await assert.rejects(
            command(account, key, async () => {
              await waitUntil(at);
            }),
            errorIs('AUTHORIZATION_UNAVAILABLE'),
          );
          assert.equal(await exists(key), false);
        },
      );

      await t.test(
        'deferred waits precede the target fence, and activation during that wait aborts',
        async () => {
          const account = await target(),
            key = randomUUID(),
            waitKey = '763921104',
            at = await future();
          await grant(account, { from: at });
          const holder = await f.pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [
              waitKey,
            ]);
            const pending = transaction(async (tx) => {
              await lockSafetyPolicy(tx, true);
              await authorization.requireUnprotectedErrandTarget(account, tx);
              await effect(tx, key, waitKey);
            });
            const rejected = assert.rejects(
              pending,
              errorIs('AUTHORIZATION_UNAVAILABLE'),
            );
            await f.waitForLock('SET CONSTRAINTS ALL IMMEDIATE');
            const fences = (
              await f.pool.query<{ n: string }>(
                "SELECT count(*)::text n FROM pg_locks WHERE relation='whaleu_authorization.role_grants'::regclass AND mode='ShareLock' AND granted",
              )
            ).rows[0]!.n;
            assert.equal(fences, '0');
            await waitUntil(at);
            await holder.query('COMMIT');
            await rejected;
            assert.equal(await exists(key), false);
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
        },
      );

      await t.test(
        'scheduled activation after protection reread during another required proof is caught by the final wrapper clock',
        async () => {
          const account = await target(),
            key = randomUUID(),
            at = await future();
          await grant(account, { from: at });
          await assert.rejects(
            command(account, key, async (tx) => {
              const after = {
                maximumFacts: 1,
                failureCode: 'AUTHORIZATION_UNAVAILABLE' as const,
                validate: async () => {
                  await waitUntil(at);
                },
              };
              enableRequiredTransactionProof(tx, after);
              registerRequiredTransactionFact(tx, after, 'wait', 'wait');
            }),
            errorIs('AUTHORIZATION_UNAVAILABLE'),
          );
          assert.equal(await exists(key), false);
        },
      );

      await t.test(
        'future grant revocation committed before final reread removes its unlocked scheduled deadline',
        async () => {
          const account = await target(),
            key = randomUUID(),
            at = await future();
          const id = await grant(account, { from: at });
          await command(account, key, async () => {
            await f.pool.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
              [id],
            );
            await waitUntil(at);
          });
          assert.equal(await exists(key), true);
        },
      );

      await t.test(
        'nonfinite grants fail unavailable instead of becoming unprotected or protected',
        async () => {
          for (const options of [
            { from: '-infinity' },
            { from: 'infinity' },
            { until: 'infinity' },
          ]) {
            const account = await target(),
              key = randomUUID();
            await grant(account, options);
            await assert.rejects(
              command(account, key),
              errorIs('AUTHORIZATION_UNAVAILABLE'),
            );
            assert.equal(await exists(key), false);
          }
        },
      );

      await t.test(
        'owner success restores timeout settings and savepoint rollback prunes unused target proof facts',
        async () => {
          const account = await target(),
            protectedAccount = await target();
          const id = await grant(protectedAccount, {
            from: await future(10000),
          });
          await transaction(async (tx) => {
            await tx.query("SET LOCAL statement_timeout='2s'");
            await tx.query("SET LOCAL lock_timeout='700ms'");
            await authorization.requireUnprotectedErrandTarget(account, tx);
            await tx.query('SAVEPOINT discarded_sanction');
            const checkpoint = checkpointTransactionDeadlines(tx);
            await authorization.requireUnprotectedErrandTarget(
              protectedAccount,
              tx,
            );
            await tx.query('ROLLBACK TO SAVEPOINT discarded_sanction');
            restoreTransactionDeadlines(tx, checkpoint);
            const after = {
              maximumFacts: 1,
              failureCode: 'AUTHORIZATION_UNAVAILABLE' as const,
              validate: async () => {
                const row = (
                  await tx.query<{ statement: string; lock: string }>(
                    "SELECT current_setting('statement_timeout') statement,current_setting('lock_timeout') lock",
                  )
                ).rows[0]!;
                assert.deepEqual(row, { statement: '2s', lock: '700ms' });
              },
            };
            enableRequiredTransactionProof(tx, after);
            registerRequiredTransactionFact(tx, after, 'settings', 'settings');
          });
          await f.pool.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
            [id],
          );
        },
      );

      await t.test(
        'repeatable-read server/session defaults never silently bypass fresh committed source proof',
        async () => {
          const account = await target(),
            key = randomUUID(),
            client = await f.pool.connect();
          try {
            await client.query(
              "SET default_transaction_isolation='repeatable read'",
            );
            const borrowed = {
              connect: async () =>
                new Proxy(client, {
                  get(target, property) {
                    return property === 'release'
                      ? () => {}
                      : Reflect.get(target, property, target);
                  },
                }),
            };
            await assert.rejects(
              inTransaction(borrowed, async (tx) => {
                await authorization.requireUnprotectedErrandTarget(account, tx);
                await effect(tx, key);
              }),
              errorIs('AUTHORIZATION_UNAVAILABLE'),
            );
            await inTransaction(
              borrowed,
              async (tx) => {
                await authorization.requireUnprotectedErrandTarget(account, tx);
                await effect(tx, key);
              },
              { isolationLevel: 'read committed' },
            );
            assert.equal(await exists(key), true);
          } finally {
            await client.query('RESET default_transaction_isolation');
            client.release();
          }
        },
      );

      await t.test(
        'ordinary read privilege without SHARE lock privilege fails closed and rolls back prior writes',
        async () => {
          const account = await target(),
            key = randomUUID();
          await assert.rejects(
            transaction(async (tx) => {
              await effect(tx, key);
              // Built-in read-only role, transaction-local; no role/access creation.
              await tx.query('SET LOCAL ROLE pg_read_all_data');
              await authorization.requireUnprotectedErrandTarget(account, tx);
            }),
            errorIs('AUTHORIZATION_UNAVAILABLE'),
          );
          assert.equal(await exists(key), false);
        },
      );

      await t.test(
        'Profile resolution holds stable narrow public ownership until transaction end and never creates missing profiles',
        async () => {
          const account = await target(),
            missing = randomUUID(),
            facade = f.app.get(ProfileAdminParticipantFacade);
          const profile = (
            await f.pool.query<{ id: string }>(
              "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES($1,'Before') RETURNING public_id id",
              [account],
            )
          ).rows[0]!.id;
          const entered = deferred(),
            resume = deferred();
          const pending = transaction(async (tx) => {
            const result = await facade.resolve(profile, tx);
            assert.deepEqual(result, {
              accountId: account,
              profileId: profile,
              displayName: 'Before',
            });
            assert.equal(await facade.resolve(missing, tx), null);
            entered.resolve();
            await resume.promise;
          });
          await entered.promise;
          const writer = f.pool.query(
            "UPDATE whaleu_profile.profiles SET nickname='After' WHERE account_id=$1",
            [account],
          );
          await f.waitForLock("SET nickname='After'");
          resume.resolve();
          await pending;
          await writer;
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.profiles WHERE public_id=$1',
                [missing],
              )
            ).rowCount,
            0,
          );
        },
      );

      await t.test(
        'actual owner SQL preserves microsecond starts/ends and conservatively floors only the final deadline',
        async () => {
          // Deterministic temporal arithmetic probe: only the sampled SQL clock is
          // controlled. All grant predicates, decoding and finalization are real.
          // Separate preceding tests use unmodified clocks and independent writers.
          const checkedAt = '2026-01-01T00:00:00.123500Z';
          const controlled = instrument(async (client, sql, values) => {
            if (sql.includes('WITH checked AS MATERIALIZED'))
              return client.query(
                sql.replace(
                  'SELECT clock_timestamp() AS at',
                  'SELECT $2::timestamptz AS at',
                ),
                [...(values ?? []), checkedAt],
              );
            if (sql === 'SELECT clock_timestamp() AS now')
              return client.query('SELECT $1::timestamptz AS now', [checkedAt]);
            return client.query(sql, values);
          });
          for (const [options, outcome] of [
            [
              { until: '2026-01-01T00:00:00.123501Z' },
              'ERRAND_RESTRICTION_TARGET_PROTECTED',
            ],
            [{ until: checkedAt }, null],
            [{ until: '2026-01-01T00:00:00.123499Z' }, null],
            [{ from: checkedAt }, 'ERRAND_RESTRICTION_TARGET_PROTECTED'],
            [
              { from: '2026-01-01T00:00:00.123501Z' },
              'AUTHORIZATION_UNAVAILABLE',
            ],
            [{ from: '2026-01-01T00:00:00.124001Z' }, null],
          ] as const) {
            const account = await target(),
              key = randomUUID();
            await grant(account, options);
            const pending = inTransaction(
              controlled,
              async (tx) => {
                await authorization.requireUnprotectedErrandTarget(account, tx);
                await effect(tx, key);
              },
              { isolationLevel: 'read committed' },
            );
            if (outcome) await assert.rejects(pending, errorIs(outcome));
            else await pending;
            assert.equal(await exists(key), outcome === null);
          }
        },
      );

      await t.test(
        'a final statement cancellation remains retryable and restores settings on rollback',
        async () => {
          const account = await target(),
            key = randomUUID();
          let fenced = false,
            interrupted = false;
          const delayed = instrument(async (client, sql, values) => {
            if (
              sql ===
              'LOCK TABLE whaleu_authorization.role_grants IN SHARE MODE NOWAIT'
            )
              fenced = true;
            if (
              fenced &&
              sql.includes('FROM whaleu_authorization.role_grants')
            ) {
              interrupted = true;
              await client.query('SELECT pg_sleep(0.3)');
            }
            return client.query(sql, values);
          });
          await assert.rejects(
            inTransaction(
              delayed,
              async (tx) => {
                await authorization.requireUnprotectedErrandTarget(account, tx);
                await effect(tx, key);
              },
              { isolationLevel: 'read committed' },
            ),
            errorIs('AUTHORIZATION_UNAVAILABLE'),
          );
          assert.equal(interrupted, true);
          assert.equal(await exists(key), false);
          await command(account, key);
          assert.equal(await exists(key), true);
        },
      );

      await t.test(
        'shared positive SQL corroboration enforces exact school/global scope and stable expiry diagnostics',
        async () => {
          const actor = await f.actor({
            identity: false,
            affiliation: 'unverified',
          });
          const sessionId = (
            await f.pool.query<{ id: string }>(
              'SELECT id FROM whaleu_identity.sessions WHERE account_id=$1',
              [actor.accountId],
            )
          ).rows[0]!.id;
          const school = await grant(actor.accountId, {
            role: 'school_admin',
            region: f.scope.home.regionId,
          });
          const call = (grantId: string, region: string | null) =>
            transaction((tx) =>
              tx.query(
                'SELECT whaleu_authorization.require_errand_management_authority($1,$2,$3,$4)',
                [actor.accountId, sessionId, grantId, region],
              ),
            );
          const constraint = (name: string) => (error: unknown) =>
            !!error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === '23514' &&
            'constraint' in error &&
            error.constraint === name;
          await call(school, f.scope.home.regionId);
          for (const region of [null, randomUUID()])
            await assert.rejects(
              call(school, region),
              constraint('errand_management_authority_invalid'),
            );
          const expired = await grant(actor.accountId, {
            role: 'super_admin',
            until: '2001-01-01T00:00:00Z',
          });
          await assert.rejects(
            call(expired, null),
            constraint('errand_management_authorization_expired'),
          );
          const global = await grant(actor.accountId);
          await call(global, null);
          await call(global, randomUUID());
          await f.pool.query(
            "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [sessionId],
          );
          await assert.rejects(
            call(global, null),
            constraint('errand_management_session_expired'),
          );
        },
      );

      // Let completion continuations settle before fixture ownership is dropped.
      await sleep(0);
    } finally {
      await f.close();
    }
  },
);
