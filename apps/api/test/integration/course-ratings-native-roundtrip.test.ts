import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { courseRatingFixture } from '../support/course-rating-fixture.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
function credentials(a: SessionCredentials): SessionCredentials {
  return {
    accountId: a.accountId,
    sessionId: a.sessionId,
    accessToken: a.accessToken,
    refreshToken: a.refreshToken,
    expiresAt: a.expiresAt,
    refreshExpiresAt: a.refreshExpiresAt,
  };
}
test(
  'emitted native course discovery → independent first tuple → response loss/restart → source-withdrawn receipt → exact own/summary and lifecycle fences',
  { timeout: 180000 },
  async (t) => {
    const f = await courseRatingFixture();
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor({ affiliation: 'unverified', identity: false });
    const course = f.add({ name: 'Synthetic Native Course', department: 1 }),
      legacy = f.add({ name: 'Synthetic Legacy Group', department: 90 }),
      unknown = f.add({
        name: 'Synthetic Unknown History',
        history: 'unknown',
      });
    await f.accept([course, legacy, unknown]);
    const child = fork(
      fileURLToPath(
        new URL('../support/course-ratings-native-worker.mjs', import.meta.url),
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
    let requestId: string | undefined;
    const finished = new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure')
            throw Error(String(m['message']) + '\n' + logs);
          if (m['event'] === 'checkpoint') {
            const name = String(m['name']);
            checkpoints.push(name);
            if (name === 'course-score-committed') {
              requestId = String(m['requestId']);
              assert.equal(m['courseId'], course.id);
              assert.deepEqual(m['tuple'], {
                gradeScore: 0.5,
                abilityScore: 4.5,
                overallScore: 1.5,
              });
              const rows = (
                await f.pool.query(
                  'SELECT actor_id,request_id,grade_half_units,ability_half_units,overall_half_units FROM whaleu_ratings.course_scores WHERE course_id=$1',
                  [course.id],
                )
              ).rows;
              assert.deepEqual(rows, [
                {
                  actor_id: actor.accountId,
                  request_id: requestId,
                  grade_half_units: 1,
                  ability_half_units: 9,
                  overall_half_units: 3,
                },
              ]);
              await f.pool.query(
                "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
              );
            } else if (name === 'course-recovery-confirmed') {
              assert.equal(m['requestId'], requestId);
              await f.pool.query(
                "UPDATE whaleu_ratings.course_catalog_head SET state='accepted'",
              );
            } else throw Error('Unknown native checkpoint ' + name);
            child.send({ event: 'continue', name });
          } else if (m['event'] === 'done') {
            assert.equal(m['requestId'], requestId);
            assert.equal(m['commands'], 1);
            assert.deepEqual(checkpoints, [
              'course-score-committed',
              'course-recovery-confirmed',
            ]);
            const score = (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_scores WHERE course_id=$1',
                [course.id],
              )
            ).rows[0];
            assert.equal(score.n, 1);
            const ledger = (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_commands WHERE actor_id=$1',
                [actor.accountId],
              )
            ).rows[0];
            assert.equal(ledger.n, 1);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!done)
          reject(Error(`Native course worker exited ${code}: ${logs}`));
      });
    });
    child.send({
      port: f.port,
      actor: credentials(actor),
      other: credentials(other),
      courseId: course.id,
      unknownId: unknown.id,
      legacyId: legacy.id,
      expectedSummary: {
        kind: 'known',
        count: 1,
        gradeScore: 0.5,
        abilityScore: 4.5,
        overallScore: 1.5,
      },
    });
    await finished;
  },
);
