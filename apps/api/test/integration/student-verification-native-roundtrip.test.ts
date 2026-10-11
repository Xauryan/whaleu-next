import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { studentEvidenceFixture } from '../support/student-evidence-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import { VerificationRepository } from '../../src/verification/verification.repository.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
test(
  'emitted native student material to real scoped review, affiliation, phone, identity campus and ordinary publication',
  { timeout: 240000 },
  async (t) => {
    const png = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#4b8576' },
    })
      .png()
      .toBuffer();
    let runtimeConfig!: RuntimeConfig;
    const f = await studentEvidenceFixture(
      [{ sha256: sha256(png), verdict: 'allow' }],
      undefined,
      {
        configureTestModule(builder, config) {
          runtimeConfig = {
            ...config,
            COMMUNITY_TEXT_REVIEW: 'local_manual',
            COMMUNITY_TEXT_REVIEW_POLICY_ID: randomUUID(),
            COMMUNITY_TEXT_REVIEW_OPERATOR:
              'local:test:student-native-reviewer',
          };
          builder.overrideProvider(APP_CONFIG).useValue(runtimeConfig);
        },
      },
    );
    t.after(() => f.close());
    // Synthetic local policy configuration and initial catalog are explicit test setup.
    Object.assign(runtimeConfig, {
      COMMUNITY_TEXT_REVIEW_SPACE_ID: f.scope.home.spaceId,
      COMMUNITY_TEXT_REVIEW_REGION_ID: f.scope.home.regionId,
    });
    const admin = await f.actor('synthetic-student-native-admin');
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic-native-student-reviewer')",
        [randomUUID(), admin.accountId, f.scope.home.regionId],
      ),
    );
    const operator = new TextReviewOperator(
        f.app.get(TextReviewRuntime),
        runtimeConfig.COMMUNITY_TEXT_REVIEW_OPERATOR!,
      ),
      records = new VerificationRepository();
    await inTransaction(f.pool, (tx) =>
      operator.run(
        {
          command: 'init-policy',
          basis:
            'Disposable student verification native post exact-text policy',
        },
        tx,
      ),
    );
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/student-verification-native-worker.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
        env: { ...process.env },
      },
    );
    let logs = '';
    child.stdout?.on('data', (v) => (logs += String(v)));
    child.stderr?.on('data', (v) => (logs += String(v)));
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const checkpoints: string[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          if (!raw || typeof raw !== 'object' || !('event' in raw))
            throw Error('Invalid native IPC');
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure') throw Error(String(m['message']));
          if (m['event'] === 'checkpoint') {
            const name = String(m['name']);
            checkpoints.push(name);
            if (name === 'process-images') {
              for (const kind of ['seal', 'process', 'review'] as const)
                assert.equal(await f.worker.runOne(kind), true);
            } else if (name === 'pending') {
              const read = await inTransaction(f.pool, (tx) =>
                records.read(String(m['accountId']), tx),
              );
              assert.equal(read.summary.affiliation.status, 'unverified');
              assert.equal(read.summary.application.status, 'pending');
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_verification.student_decisions WHERE application_id=$1',
                    [m['applicationId']],
                  )
                ).rows[0].n,
                0,
              );
            } else if (name === 'approved') {
              const read = await inTransaction(f.pool, (tx) =>
                records.read(String(m['accountId']), tx),
              );
              assert.equal(read.summary.affiliation.status, 'verified');
              assert.equal(read.summary.studentNumber.status, 'unverified');
              assert.equal(read.summary.phone.status, 'unverified');
            } else if (name === 'identity-selected') {
              const read = await inTransaction(f.pool, (tx) =>
                records.read(String(m['accountId']), tx),
              );
              assert.equal(read.summary.phone.status, 'verified');
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_campus.community_identity_selections WHERE account_id=$1',
                    [m['accountId']],
                  )
                ).rows[0].n,
                1,
              );
            } else if (name === 'post-review') {
              const row = (
                await f.pool.query<{ digest: string }>(
                  'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
                  [m['accountId'], m['requestId']],
                )
              ).rows[0];
              assert.ok(row);
              await inTransaction(f.pool, (tx) =>
                operator.run(
                  {
                    command: 'decide',
                    accountId: String(m['accountId']),
                    requestId: String(m['requestId']),
                    digest: row.digest,
                    decision: 'allow',
                    basis:
                      'Actual exact synthetic student native post text reviewed',
                  },
                  tx,
                ),
              );
            } else throw Error(`Unexpected checkpoint ${name}`);
            child.send({ event: 'continue', name });
          } else if (m['event'] === 'done') {
            assert.deepEqual(checkpoints, [
              'process-images',
              'pending',
              'approved',
              'identity-selected',
              'post-review',
            ]);
            const post = (
              await f.pool.query<{ text: string }>(
                'SELECT text FROM whaleu_community.posts WHERE id=$1',
                [m['postId']],
              )
            ).rows[0];
            assert.equal(
              post?.text,
              'Synthetic student verification complete native publication',
            );
            const seen = f.providerExchanges();
            assert.ok(seen.identity >= 4);
            assert.equal(seen.phone, 1);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.once('exit', (code) => {
        if (!done) reject(Error(`Native child exited ${code}: ${logs}`));
      });
    });
    child.send({
      port: f.port,
      home: f.scope.home,
      png: png.toString('base64'),
    });
    await finished;
  },
);
