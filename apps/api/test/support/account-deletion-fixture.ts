/** Real PostgreSQL owners, real additive migrations, generated accounts only.
 * This module never runs implicitly and never connects to a provider. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import type { DatabaseService } from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { initializeNativeExperienceAccount } from '../../src/experience/lifecycle.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { initializeNativeVerificationAccount } from '../../src/verification/lifecycle.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { ProfileRepository } from '../../src/profile/profile.repository.js';
import { ProfileDetailsRepository } from '../../src/profile-details/repository.js';
import { PublicProfileFacade } from '../../src/profile/public-profile.facade.js';
import { ExperiencePublicDisplayFacade } from '../../src/experience/public-display.facade.js';
import { SafetyRepository } from '../../src/safety/repository.js';
import { ProfileVisibilityFacade } from '../../src/safety/profile-visibility.facade.js';
import { CommunitySocialSourceCapture } from '../../src/community/social-source/capture.js';
import { FollowingService } from '../../src/community/following/service.js';
import { SocialUpdatesIngress } from '../../src/notifications/social/ingress.js';
import { PersonalTimetableRepository } from '../../src/personal-timetable/repository.js';
import type { TimetableCommand } from '../../src/personal-timetable/contracts.js';
import { AccountDeletionRepository } from '../../src/account-deletion/repository.js';
import { AccountDeletionService } from '../../src/account-deletion/service.js';
import type { ExistingAccountReauthenticationPort } from '../../src/account-deletion/service.js';
import { AccountDeletionWorker } from '../../src/account-deletion/worker.js';
import { SyntheticDeletionMedia } from '../../src/account-deletion/synthetic-media.js';
import {
  SyntheticIdentityKeys,
  SYNTHETIC_APP,
} from '../../src/account-deletion/synthetic-policy.js';
import {
  SYNTHETIC_POLICY,
  INVENTORY_VERSION,
  DeletionError,
} from '../../src/account-deletion/contracts.js';
import {
  inventory,
  sha,
  relationSql,
} from '../../src/account-deletion/owners/preflight.js';
import {
  readBaseline,
  validateNativeBaseline,
} from '../../src/account-deletion/owners/baseline.js';
import { migrationSchemaNames } from './migration-schemas.js';
import { createHistoricalDeletionPeer } from './historical-deletion-peer.js';
import { historicalDeletionIdentity } from './historical-lifecycle-identity/deletion.js';
export async function accountDeletionFixture(
  options: { throughMigration?: 173 | 174 } = {},
) {
  assert.ok(
    options.throughMigration === undefined ||
      options.throughMigration === 173 ||
      options.throughMigration === 174,
    'Only the exact 0173 or 0174 historical prefix is supported',
  );
  const url = process.env['TEST_DATABASE_URL'];
  assert.ok(
    url,
    'Requires explicitly coordinated disposable PostgreSQL; no skips',
  );
  const parsed = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname));
  assert.equal(parsed.pathname, '/whaleu_test');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    PG_POOL_MAX: '8',
    PG_STATEMENT_TIMEOUT_MS: '30000',
    COMMUNITY_UPDATES_PROCESSING: 'disabled',
  });
  const pool = new Pool(poolOptions(config));
  let suite: PoolClient | undefined,
    locked = false,
    owns = false,
    closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (owns)
        for (const schema of migrationSchemaNames)
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      if (locked)
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  };
  try {
    suite = await pool.connect();
    locked = (
      await suite.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1,$2) locked',
        [MIGRATION_LOCK[0], 2],
      )
    ).rows[0]!.locked;
    assert.ok(locked, 'Another isolated PostgreSQL lane owns this database');
    assert.ok(
      supportedPostgresVersion(
        (
          await pool.query<{ v: number }>(
            "SELECT current_setting('server_version_num')::integer v",
          )
        ).rows[0]!.v,
      ),
    );
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
        )
      ).rowCount,
      0,
      'Refuse any preexisting application schema',
    );
    owns = true;
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    );
    const selected =
      options.throughMigration === undefined
        ? migrations
        : migrations.filter(
            (migration) =>
              Number(migration.name.slice(0, 4)) <= options.throughMigration!,
          );
    if (options.throughMigration !== undefined)
      assert.equal(
        Number(selected.at(-1)?.name.slice(0, 4)),
        options.throughMigration,
        'The requested historical migration must actually exist',
      );
    await runMigrations(pool, selected, { mode: 'up' });
    const repository = new AccountDeletionRepository(pool),
      sandbox = randomUUID();
    let now = Date.now();
    await repository.transaction(async (tx) => {
      const seal = await inventory(tx, true);
      await tx.query(
        'INSERT INTO whaleu_account_deletion.sandboxes(id,now_at,inventory,policy,catalog_hash) VALUES($1,$2,$3,$4,$5)',
        [
          sandbox,
          new Date(now),
          INVENTORY_VERSION,
          SYNTHETIC_POLICY,
          sha(
            seal.map(({ relation, shape_hash }) => ({ relation, shape_hash })),
          ),
        ],
      );
      for (const row of seal)
        await tx.query(
          'INSERT INTO whaleu_account_deletion.inventory(sandbox_id,relation,shape_hash,rows_hash,row_count,supported) VALUES($1,$2,$3,$4,$5,$6)',
          [
            sandbox,
            row.relation,
            row.shape_hash,
            row.rows_hash,
            row.row_count,
            row.supported,
          ],
        );
    });
    const database = {
      transaction: <T>(work: (tx: PoolClient) => Promise<T>) =>
        repository.transaction(work),
      query: pool.query.bind(pool),
    } as unknown as DatabaseService;
    const identity =
        options.throughMigration === undefined
          ? new IdentityRepository(database)
          : await historicalDeletionIdentity(
              database,
              config,
              options.throughMigration,
            ),
      profiles = new ProfileRepository(database),
      details = new ProfileDetailsRepository(),
      timetable = new PersonalTimetableRepository();
    const identityService = new IdentityService(
        {
          exchange: async () => {
            throw new Error('Synthetic fixture must not call a provider');
          },
        },
        identity,
      ),
      safety = new SafetyRepository();
    const following = new FollowingService(
      database,
      identityService,
      new PublicProfileFacade(profiles, new ExperiencePublicDisplayFacade()),
      new ProfileVisibilityFacade(safety),
      safety,
      new CommunitySocialSourceCapture(config, new SocialUpdatesIngress()),
    );
    // Fixed explicit test-key material lives ONLY in this fixture, not a runtime default.
    const keys = new SyntheticIdentityKeys(Buffer.alloc(32, 0x53)),
      assertionKey = Buffer.alloc(32, 0x41),
      used = new Set<string>();
    const verifier: ExistingAccountReauthenticationPort = {
      verify: async (value) => {
        if (!value || typeof value !== 'object')
          throw new DeletionError('SYNTHETIC_ASSERTION_INVALID');
        const v = value as {
          subject: string;
          expiresAt: number;
          nonce: string;
          signature: string;
        };
        if (
          typeof v.subject !== 'string' ||
          typeof v.expiresAt !== 'number' ||
          typeof v.nonce !== 'string' ||
          typeof v.signature !== 'string' ||
          used.has(v.nonce) ||
          v.expiresAt <= now
        )
          throw new DeletionError('SYNTHETIC_ASSERTION_INVALID');
        const expected = createHmac('sha256', assertionKey)
          .update(JSON.stringify([v.subject, v.expiresAt, v.nonce]))
          .digest('hex');
        if (
          v.signature.length !== expected.length ||
          !timingSafeEqual(Buffer.from(v.signature), Buffer.from(expected))
        )
          throw new DeletionError('SYNTHETIC_ASSERTION_INVALID');
        used.add(v.nonce);
        return {
          provider: 'wechat',
          appId: SYNTHETIC_APP,
          subject: v.subject,
          expiresAt: v.expiresAt,
        };
      },
    };
    const assertion = (actor: { subject: string }) => {
      const payload = {
        subject: actor.subject,
        expiresAt: now + 60000,
        nonce: randomUUID(),
      };
      return {
        ...payload,
        signature: createHmac('sha256', assertionKey)
          .update(
            JSON.stringify([payload.subject, payload.expiresAt, payload.nonce]),
          )
          .digest('hex'),
      };
    };
    const service = new AccountDeletionService(repository, verifier),
      media = new SyntheticDeletionMedia(),
      worker = new AccountDeletionWorker(repository, media);
    const create = async (
      subject = 'synthetic-' + randomUUID(),
      verification = true,
      afterGuardCheck?: () => Promise<void>,
    ) => {
      const digest = keys.digest(subject),
        accountId = randomUUID();
      await repository.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          JSON.stringify(['wechat', SYNTHETIC_APP, subject]),
        ]);
        if (
          (
            await tx.query(
              'SELECT 1 FROM whaleu_account_deletion.reregistration_guards WHERE identity_digest=$1 AND reregister_after>$2 LIMIT 1',
              [digest, new Date(now)],
            )
          ).rowCount
        )
          throw new DeletionError('REREGISTRATION_RESTRICTED');
        await afterGuardCheck?.();
        await tx.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
          accountId,
        ]);
        await initializeNativeExperienceAccount(accountId, tx);
        await initializeNativeSafetyAccount(accountId, tx);
        await tx.query(
          "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat',$1,$2,$3)",
          [SYNTHETIC_APP, subject, accountId],
        );
        if (verification)
          await initializeNativeVerificationAccount(
            accountId,
            SYNTHETIC_APP,
            tx,
          );
        const baseline = await readBaseline(tx, accountId);
        validateNativeBaseline(baseline, accountId);
        await tx.query(
          'INSERT INTO whaleu_account_deletion.fixture_accounts(account_id,sandbox_id,identity_digest,baseline) VALUES($1,$2,$3,$4::jsonb)',
          [accountId, sandbox, digest, JSON.stringify(baseline)],
        );
        await tx.query(
          'INSERT INTO whaleu_account_deletion.fixture_media_cohorts(account_id,cohort_id) VALUES($1,$2)',
          [accountId, media.cohortId],
        );
      });
      const accessToken = mintToken('access'),
        refreshToken = mintToken('refresh'),
        session = await identity.createSession(
          { provider: 'wechat', appId: SYNTHETIC_APP, subject },
          { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
        );
      return { ...session, subject, accessToken, refreshToken };
    };
    const createPeer = async () => {
      assert.equal(
        options.throughMigration,
        174,
        'Historical external peers require the explicit exact 0174 fixture',
      );
      return createHistoricalDeletionPeer(database, config);
    };
    type Actor = Awaited<ReturnType<typeof create>>;
    const populate = async (actor: Actor) => {
      const suffix = randomUUID().slice(0, 8),
        nickname = 'Private' + suffix,
        bio = 'private-bio-' + randomUUID(),
        region = 'private-region-' + randomUUID(),
        course = 'private-course-' + randomUUID(),
        note = 'private-note-' + randomUUID(),
        termId = randomUUID(),
        entryId = randomUUID();
      await repository.transaction((tx) =>
        profiles.authorDisplay(actor.accountId, tx),
      );
      await profiles.update(
        actor.accountId,
        0,
        async () => ({ nickname, bio }),
        { sessionId: actor.sessionId, tokenHash: hashToken(actor.accessToken) },
      );
      await repository.transaction(async (tx) => {
        await identity.authenticate(hashToken(actor.accessToken), tx);
        await details.update(
          actor.accountId,
          {
            expectedRevision: 0,
            region,
            gender: 'female',
            age: 24,
            showRegion: true,
            showGender: true,
            showAge: true,
          },
          tx,
        );
      });
      const commands: TimetableCommand[] = [
        {
          version: 1,
          requestId: randomUUID(),
          operation: 'term.create',
          termId,
          expectedRevision: 0,
          payload: {
            name: 'Synthetic term',
            weekOneMonday: '2026-09-07',
            weekCount: 20,
            timeZone: 'Asia/Shanghai',
          },
        },
        {
          version: 1,
          requestId: randomUUID(),
          operation: 'entry.create',
          termId,
          entryId,
          expectedRevision: 1,
          payload: {
            name: course,
            teacher: 'Private teacher',
            location: 'Private classroom',
            note,
            dayOfWeek: 1,
            startMinute: 480,
            endMinute: 530,
            weeks: [1, 3],
            color: 'blue',
          },
        },
      ];
      for (const command of commands)
        await repository.transaction(async (tx) => {
          await identity.authenticate(hashToken(actor.accessToken), tx);
          await timetable.lock(actor.accountId, tx);
          const receipt = await timetable.apply(actor.accountId, command, tx);
          assert.equal(receipt.outcome, 'applied');
          await timetable.save(actor.accountId, receipt, tx);
        });
      return {
        sentinels: [
          nickname,
          bio,
          region,
          course,
          note,
          actor.subject,
          hashToken(actor.accessToken),
          hashToken(actor.refreshToken),
        ],
        termId,
        entryId,
        profileId: await repository.transaction((tx) =>
          profiles.publicReference(actor.accountId, tx),
        ),
      };
    };
    const advance = async (ms: number) => {
      assert.ok(Number.isSafeInteger(ms) && ms >= 0);
      now += ms;
      await pool.query(
        'UPDATE whaleu_account_deletion.sandboxes SET now_at=$2 WHERE id=$1',
        [sandbox, new Date(now)],
      );
    };
    const residue = async (values: readonly string[]) => {
      const found: string[] = [];
      const relations = (
        await pool.query<{ name: string }>(
          "SELECT n.nspname||'.'||c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\\_%' ESCAPE '\\' AND c.relkind='r' ORDER BY 1",
        )
      ).rows;
      for (const { name } of relations) {
        for (const value of values)
          if (
            (
              await pool.query(
                `SELECT 1 FROM ${relationSql(name)} t WHERE position($1 IN to_jsonb(t)::text)>0 LIMIT 1`,
                [value],
              )
            ).rowCount
          )
            found.push(name);
      }
      return [...new Set(found)];
    };
    return {
      pool,
      repository,
      service,
      worker,
      media,
      identity,
      following,
      profiles,
      create,
      createPeer,
      populate,
      assertion,
      advance,
      residue,
      now: () => now,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
