import {
  preparationRows,
  recoverUnsentPreparation,
} from '../support/errand-group-preparation.js';
import { runRestartedGroupProcess } from '../support/errand-group-process.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { errandGroupFixture } from '../support/errand-group-runtime.js';
import { approveErrand } from '../support/errand-review-fixtures.js';
import { canonicalErrandEnvelope } from '../../src/community/content-review/errand-contracts.js';
import { ErrandAccessService } from '../../src/errands/access.js';
import { publishErrandSchema } from '../../src/errands/contracts.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { sha256 } from '../../src/media/processing/protocol.js';

test(
  'E4 emitted native v1/v2 publish → real AppModule/PG/Review → partial group ACK/restart/forum → actual native private-omitting detail',
  { timeout: 240000 },
  async (t) => {
    const png = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#385279' },
    })
      .png()
      .toBuffer();
    const f = await errandGroupFixture([
      { sha256: sha256(png), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actors = { publisher: await f.actor(), reader: await f.actor() },
      region = f.scope.related.regionId;
    f.authority.add(region, 'errand', 'native:one');
    const two = f.authority.add(region, 'errand', 'native:two');
    f.authority.add(region, 'forum', 'native:forum');
    const child = fork(
      fileURLToPath(
        new URL('../support/errand-group-native-worker.mjs', import.meta.url),
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
    const finished = new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure') throw Error(String(m['message']));
          if (m['event'] === 'checkpoint') {
            const name = String(m['name']);
            let locator: string | undefined;
            if (name === 'review-text') {
              const b = publishErrandSchema.parse(m['body']);
              const scope = await f.db.transaction(
                async (tx) => {
                  await lockSafetyPolicy(tx);
                  return f.app
                    .get(ErrandAccessService)
                    .scope(actors.publisher.accountId, b.targetRegionId, tx);
                },
                { isolationLevel: 'read committed' },
              );
              await approveErrand(f.pool, {
                version: 1,
                accountId: actors.publisher.accountId,
                purpose: 'publish_errand',
                title: b.title,
                publicText: b.publicText,
                privateText: b.privateText,
                expectedTimeText: b.expectedTimeText,
                reward: b.reward,
                publisherContacts: b.publisherContacts,
                publicAssetIds: [],
                privateAssetIds: [],
                scope,
              });
            } else if (name === 'process-images') {
              for (const kind of ['seal', 'process', 'review'] as const)
                assert.equal(await f.worker.runOne(kind), true);
            } else if (name === 'review-images') {
              const original = (
                await f.pool.query(
                  'SELECT i.*,d.scope FROM whaleu_errands.media_publication_intents i JOIN whaleu_errands.media_drafts d ON d.id=i.draft_id WHERE i.request_id=$1',
                  [m['requestId']],
                )
              ).rows[0];
              const {
                protocol: _p,
                clientRequestId: _k,
                targetRegionId: _t,
                ...body
              } = original.command;
              void _p;
              void _k;
              void _t;
              await approveErrand(
                f.pool,
                canonicalErrandEnvelope({
                  ...body,
                  version: 2,
                  accountId: original.actor_id,
                  purpose: 'publish_errand',
                  scope: original.scope,
                  mediaRevision: 1,
                }),
              );
            } else if (name === 'deliver') {
              const p = (
                await f.pool.query(
                  'SELECT * FROM whaleu_notifications.errand_group_publications WHERE order_id=$1',
                  [m['orderId']],
                )
              ).rows[0];
              assert.ok(p);
              assert.equal(p.target_region_id, region);
              const created = p.published_at.getTime();
              f.setTime(created);
              f.sender.actions.set(two.id, ['not_accepted']);
              const before = f.sender.attempts.length;
              await f.groups.discover();
              await f.groups.runOne();
              await f.groups.runOne();
              assert.equal(f.sender.attempts.length - before, 2);
              f.setTime(created + 1000);
              let restarted = await runRestartedGroupProcess(
                f.directory,
                [...f.authority.groups.values()],
                f.runtime.now(),
                false,
                m['version'] === 2,
              );
              if (m['version'] === 2) {
                assert.equal(restarted.attempts.length, 0);
                assert.equal(restarted.trace.dispatches, 0);
                assert.ok(
                  restarted.trace.observedAt >=
                    restarted.trace.prepared!.expiresAt,
                );
              }
              t.diagnostic(
                JSON.stringify({
                  phase: 'native-restarted-partial-ack',
                  businessNow: f.runtime.now(),
                  restarted,
                  rows: (await f.rows()).rows,
                  deliveryAttempts: (
                    await f.pool.query(
                      'SELECT * FROM whaleu_notifications.errand_group_attempts ORDER BY delivery_id, fence',
                    )
                  ).rows,
                }),
              );
              assert.notEqual(restarted.pid, process.pid);
              assert.equal(restarted.claimed, true);
              if (restarted.attempts.length !== 1) {
                const row = (await preparationRows(f.pool)).find(
                  (r) =>
                    r.event_id === p.event_id && r.destination_id === two.id,
                )!;
                await recoverUnsentPreparation({
                  pool: f.pool,
                  directory: f.directory,
                  row,
                  trace: restarted.trace,
                  senderAttempts: restarted.attempts,
                  latestBusinessTime: created + 960000,
                  setTime: f.setTime,
                  run: async () => {
                    const previousPid = restarted.pid;
                    restarted = await runRestartedGroupProcess(
                      f.directory,
                      [...f.authority.groups.values()],
                      f.runtime.now(),
                    );
                    assert.notEqual(restarted.pid, previousPid);
                    assert.notEqual(restarted.pid, process.pid);
                    return {
                      trace: restarted.trace,
                      senderAttempts: restarted.attempts,
                    };
                  },
                  diagnostic: (message) => t.diagnostic(message),
                });
              }
              assert.equal(restarted.attempts.length, 1);
              assert.equal(restarted.attempts[0]!.destination.id, two.id);
              f.setTime(created + 900000);
              const forum = await runRestartedGroupProcess(
                f.directory,
                [...f.authority.groups.values()],
                f.runtime.now(),
                true,
              );
              assert.notEqual(forum.pid, restarted.pid);
              assert.equal(forum.attempts.length, 1);
              assert.equal(forum.attempts[0]!.destination.stage, 'forum');
              const payload = f.sender.attempts[before]!.payload;
              locator = payload.locator;
              const text = JSON.stringify(
                [
                  ...f.sender.attempts.slice(before),
                  ...restarted.attempts,
                  ...forum.attempts,
                ].map((x) => x.payload),
              );
              for (const privateValue of [
                'PRIVATE_BODY',
                'PUBLIC_BODY',
                'PRIVATE_CONTACT',
                '12345678901',
                'privateMedia',
                'publicMedia',
                'assetId',
                'bindingId',
              ])
                assert.equal(text.includes(privateValue), false);
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_notifications.errand_group_receipts r JOIN whaleu_notifications.errand_group_deliveries d ON d.id=r.delivery_id WHERE d.event_id=$1',
                    [p.event_id],
                  )
                ).rowCount,
                3,
              );
            } else throw Error('Unknown checkpoint ' + name);
            child.send({
              event: 'continue',
              name,
              ...(locator ? { locator } : {}),
            });
          } else if (m['event'] === 'done') {
            assert.equal((m['orders'] as unknown[]).length, 2);
            assert.ok(Number(m['uploads']) >= 2);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!done) reject(Error(`Native worker exited ${code}: ${logs}`));
      });
    });
    child.send({
      port: Number(new URL(await f.app.getUrl()).port),
      actors,
      targetRegionId: region,
      png: png.toString('base64'),
    });
    await finished;
  },
);
