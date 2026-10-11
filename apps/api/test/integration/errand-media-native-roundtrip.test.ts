import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import {
  errandMediaFixture,
  errandMediaOk,
} from '../support/media/errand-runtime-fixture.js';
import { approveErrand } from '../support/errand-review-fixtures.js';
import { canonicalErrandEnvelope } from '../../src/community/content-review/errand-contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';

test(
  'E3 emitted App/Page/WXML → multipart/reencode/exact Review → 0/1/3 public plus private publication, original-key restart and current byte reads',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 48, height: 48, channels: 3, background: '#384f76' },
      })
        .png()
        .toBuffer(),
      f = await errandMediaFixture([{ sha256: sha256(png), verdict: 'allow' }]);
    t.after(() => f.close());
    const actors = {
      publisherFence: await f.actor(),
      publisher0: await f.actor(),
      publisher1: await f.actor(),
      publisher3: await f.actor(),
      stranger: await f.actor(),
      runner: await f.actor(),
    };
    const child = fork(
      fileURLToPath(
        new URL('../support/errand-media-native-worker.mjs', import.meta.url),
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
            if (name === 'lose-draft-scope') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_errands.media_drafts WHERE id=$1',
                    [m['draftId']],
                  )
                ).rowCount,
                0,
              );
              await f.certify(actors.publisherFence.accountId, {
                affiliation: 'unverified',
                phone: 'verified',
                identity: false,
              });
            } else if (name === 'restore-draft-scope') {
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_errands.media_draft_cancellations WHERE actor_id=$1 AND draft_id=$2',
                    [actors.publisherFence.accountId, m['draftId']],
                  )
                ).rowCount,
                1,
              );
              await f.certify(actors.publisherFence.accountId);
              const late = await request(f.app.getHttpServer())
                .post('/v2/errand-drafts')
                .set(
                  'Authorization',
                  `Bearer ${actors.publisherFence.accessToken}`,
                )
                .send({
                  protocol: 'errand-publication-v2',
                  draftId: m['draftId'],
                  targetRegionId: f.scope.home.regionId,
                });
              assert.notEqual(late.status, 200);
            } else if (name === 'verify-new-draft-target') {
              assert.equal(
                (
                  await f.pool.query(
                    "SELECT 1 FROM whaleu_errands.media_drafts WHERE actor_id=$1 AND target_region_id=$2 AND state='open'",
                    [actors.publisherFence.accountId, f.scope.related.regionId],
                  )
                ).rowCount,
                1,
              );
            } else if (name === 'process-images')
              for (const kind of ['seal', 'process', 'review'] as const)
                assert.equal(await f.worker.runOne(kind), true);
            else if (name === 'review-exact') {
              const original = (
                await f.pool.query(
                  'SELECT i.*,d.scope FROM whaleu_errands.media_publication_intents i JOIN whaleu_errands.media_drafts d ON d.id=i.draft_id WHERE i.request_id=$1',
                  [m['requestId']],
                )
              ).rows[0];
              assert.ok(original);
              const {
                protocol: _protocol,
                clientRequestId: _key,
                targetRegionId: _target,
                ...body
              } = original.command;
              void _protocol;
              void _key;
              void _target;
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
            } else if (name === 'verify-publication') {
              const count = Number(m['count']),
                row = (
                  await f.pool.query(
                    'SELECT s.*,p.request_id FROM whaleu_errands.media_sets s JOIN whaleu_errands.media_publications p ON p.order_id=s.order_id WHERE s.order_id=$1',
                    [m['orderId']],
                  )
                ).rows[0];
              assert.ok(row);
              assert.equal(row.public_media.length, count);
              assert.equal(row.private_media.length, count);
              if (count === 1) {
                const scopes = (
                  await f.pool.query(
                    `SELECT i.state FROM whaleu_media.errand_scopes s JOIN whaleu_media.upload_intents i ON i.resource_id=s.id JOIN whaleu_errands.media_publications p ON p.draft_id=s.draft_id WHERE p.order_id=$1`,
                    [m['orderId']],
                  )
                ).rows;
                assert.equal(
                  scopes.length,
                  3,
                  'Lost prepare/upload responses must recover the same original identities; only explicit replacement creates another',
                );
                assert.equal(
                  scopes.filter((x) => x.state === 'cleanup_pending').length,
                  1,
                  'Replacement durably closes the prior unbound asset',
                );
              }

              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_media.errand_appearances WHERE order_id=$1',
                    [m['orderId']],
                  )
                ).rowCount,
                count * 2,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_errands.transitions WHERE order_id=$1 AND operation=$2',
                    [m['orderId'], 'publish'],
                  )
                ).rowCount,
                1,
              );
            } else if (name === 'verify-bytes') {
              const row = (
                await f.pool.query(
                  `SELECT a.manifest FROM whaleu_media.errand_appearances p JOIN whaleu_media.assets a ON a.id=p.asset_id WHERE p.order_id=$1 AND p.slot='private0'`,
                  [m['orderId']],
                )
              ).rows[0];
              assert.ok(row);
              assert.equal(
                sha256(Buffer.from(String(m['bytes']), 'base64')),
                row.manifest.variants[1].sha256,
              );
            } else if (name === 'accept-complete') {
              const http = f.app.getHttpServer();
              let revision = (
                await f.pool.query(
                  'SELECT revision FROM whaleu_errands.orders WHERE id=$1',
                  [m['orderId']],
                )
              ).rows[0].revision;
              const accepted = await request(http)
                .post(`/v1/errands/${m['orderId']}/accept`)
                .set('Authorization', `Bearer ${actors.runner.accessToken}`)
                .send({
                  clientRequestId: randomUUID(),
                  expectedRevision: revision,
                  contacts: { wechat: 'synthetic_runner', phone: '' },
                });
              errandMediaOk(accepted);
              assert.equal(accepted.body.outcome, 'applied');
              revision = accepted.body.revision;
              const completed = await request(http)
                .post(`/v1/errands/${m['orderId']}/complete`)
                .set('Authorization', `Bearer ${actors.publisher3.accessToken}`)
                .send({
                  clientRequestId: randomUUID(),
                  expectedRevision: revision,
                });
              errandMediaOk(completed);
              assert.equal(completed.body.outcome, 'applied');
            } else throw Error('Unknown native checkpoint ' + name);
            child.send({ event: 'continue', name });
          } else if (m['event'] === 'done') {
            assert.equal(m['uploads'], 10);
            assert.ok(Number(m['reads']) >= 3);
            assert.equal((m['orders'] as unknown[]).length, 3);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!done) reject(Error(`Errand native exited ${code}: ${logs}`));
      });
    });
    child.send({
      port: f.port,
      actors,
      regionId: f.scope.home.regionId,
      relatedRegionId: f.scope.related.regionId,
      png: png.toString('base64'),
    });
    await finished;
  },
);
