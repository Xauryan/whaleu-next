/** Emitted native pages -> actual HTTP/AppModule -> disposable PostgreSQL.
 * Every punishment is created by a real same-transaction content removal. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { accountAppealsFixture } from '../support/account-appeals-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

test(
  'emitted restricted account and private appeal journey retains original receipts across a newer punishment',
  { timeout: 300000 },
  async (t) => {
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor(),
      host = await f.actor();
    await f.grant(admin, 'super_admin', null);
    // Publish all causal material before either punishment. Issuance never
    // manufactures posting permission for a muted/suspended subject.
    const mutePost = await f.publish(owner),
      suspensionPost = await f.publish(owner),
      replacementPost = await f.publish(owner),
      browsePost = await f.publish(host);
    const mute = await f.issue(admin, owner, mutePost, 'interaction_mute');
    const suspension = await f.issue(
      admin,
      owner,
      suspensionPost,
      'access_suspension',
    );
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/account-moderation-native-child.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
      },
    );
    t.after(() => {
      if (child.connected) child.disconnect();
      if (child.exitCode === null) child.kill();
    });
    child.stdout?.resume();
    let log = '';
    child.stderr?.on('data', (data) => {
      log += String(data);
    });
    let replacementId: string | null = null;
    const result = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        let completed = false;
        const fail = (error: unknown) => {
          if (!completed) {
            completed = true;
            reject(error);
          }
        };
        child.on('message', (raw: unknown) => {
          if (!raw || typeof raw !== 'object') return;
          const message = raw as Record<string, unknown>;
          if (message['event'] === 'failed' || message['event'] === 'error') {
            fail(
              new Error(
                String(message['error'] ?? message['message']) + '\n' + log,
              ),
            );
            return;
          }
          if (message['event'] === 'done') {
            if (!completed) {
              completed = true;
              resolve(message);
            }
            return;
          }
          if (
            message['event'] === 'checkpoint' &&
            message['name'] === 'decision-applied-reissue'
          )
            void (async () => {
              const newer = await f.issue(
                admin,
                owner,
                replacementPost,
                'access_suspension',
                '1',
              );
              replacementId = newer.punishmentId;
              child.send({
                event: 'continue',
                name: message['name'],
                checkpointId: message['checkpointId'],
                newSuspensionId: newer.punishmentId,
              });
            })().catch(fail);
        });
        child.on('error', fail);
        child.on('exit', (code) => {
          if (!completed)
            fail(
              new Error(
                `Native child exited ${String(code)} without complete journey. ${log}`,
              ),
            );
        });
        const server = f.http as { address(): { port: number } };
        child.send({
          port: server.address().port,
          owner,
          admin,
          browsePath: `/v1/community/posts/${browsePost.id}`,
          muteId: mute.punishmentId,
          suspensionId: suspension.punishmentId,
          reissueAfterDecision: true,
        });
      },
    );
    assert.ok(
      replacementId,
      'Actual newer causal suspension was issued at the lost-response checkpoint',
    );
    assert.ok(Array.isArray(result['commands']));
    const current = await f.get(owner, '/v1/me/safety/status');
    profileOk(current);
    assert.equal(current.body.effective, 'clear');
    const records = (
      await f.pool.query<{ id: string; cause: string }>(
        `SELECT p.id,t.cause FROM whaleu_safety.account_punishments p
    JOIN whaleu_safety.account_punishment_terminals t ON t.punishment_id=p.id WHERE p.subject_id=$1 ORDER BY p.recorded_at,p.id`,
        [owner.accountId],
      )
    ).rows;
    assert.equal(records.length, 3);
    assert.equal(
      records.find((r) => r.id === suspension.punishmentId)?.cause,
      'appeal_released',
    );
    assert.equal(
      records.find((r) => r.id === replacementId)?.cause,
      'manually_released',
    );
    assert.equal(
      records.find((r) => r.id === mute.punishmentId)?.cause,
      'manually_released',
    );
    const notices = await f.get(owner, '/v1/me/system-notices');
    profileOk(notices);
    const items = notices.body.items as { noticeId: string; kind: string }[];
    assert.equal(
      new Set(items.map((item) => item.noticeId)).size,
      items.length,
    );
    assert.equal(
      items.filter((item) => item.kind === 'account_appeal_decided').length,
      1,
    );
    assert.equal(
      items.filter((item) => item.kind === 'account_punishment_issued').length,
      3,
    );
    assert.equal(
      items.filter((item) => item.kind === 'account_punishment_released')
        .length,
      3,
    );
  },
);
