import { SchoolConfigurationAccess } from '../../src/school-configuration/access.js';
import { StudentVerificationAccess } from '../../src/verification/student/access.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import request from 'supertest';
import {
  schoolQrFixture,
  grantSchool,
  schoolData,
  qrOk,
} from '../support/media/school-qr-runtime-fixture.js';
import { seedErrandFeature } from '../support/errand-runtime-fixture.js';
import { approveErrand } from '../support/errand-review-fixtures.js';
import { ErrandAccessService } from '../../src/errands/access.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { DatabaseService } from '../../src/database/database.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { publishErrandSchema } from '../../src/errands/contracts.js';

test(
  'E4a emitted App/Page/WXML: order-target group configuration, exact QR bytes, narrow preference CAS and lifecycle isolation through ordinary AppModule/PG',
  { timeout: 300000 },
  async (t) => {
    const picture = (background: string) =>
      sharp({ create: { width: 48, height: 48, channels: 3, background } })
        .png()
        .toBuffer();
    const png = await picture('#314d80'),
      replacement = await picture('#c07f48');
    const f = await schoolQrFixture(
      [png, replacement].map((bytes) => ({
        sha256: sha256(bytes),
        verdict: 'allow' as const,
      })),
    );
    t.after(() => f.close());
    // Both composed owners consume one narrow authority provider. Importing the
    // whole School Configuration module from Verification previously formed an
    // ESM cycle through Errands; no forwardRef or duplicate policy is allowed.
    const schoolAccess = f.app.get(SchoolConfigurationAccess);
    assert.equal(f.qr.access, schoolAccess);
    assert.equal(f.app.get(StudentVerificationAccess).school, schoolAccess);
    const actors = {
      owner: await f.actor(),
      publisher: await f.actor(),
      reader: await f.actor(),
      other: await f.actor(),
    };
    for (const actor of Object.values(actors))
      await seedErrandFeature(f.pool, actor.accountId);
    await grantSchool(
      f,
      actors.owner,
      'school_admin',
      f.scope.related.regionId,
    );
    const http = f.app.getHttpServer();
    const authorized = (call: request.Test, actor = actors.reader) =>
      call.set('Authorization', `Bearer ${actor.accessToken}`);
    async function publish(targetRegionId: string) {
      const input = publishErrandSchema.parse({
        clientRequestId: randomUUID(),
        targetRegionId,
        title: 'Synthetic target group order',
        publicText: 'Synthetic delivery',
        privateText: 'Synthetic private instructions',
        expectedTimeText: 'Tomorrow',
        reward: '1',
        publisherContacts: {
          wechat: 'synthetic_publisher',
          phone: '12345678901',
        },
        publicAssetIds: [],
        privateAssetIds: [],
      });
      const scope = await f.app.get(DatabaseService).transaction(
        async (tx) => {
          await lockSafetyPolicy(tx);
          return f.app
            .get(ErrandAccessService)
            .scope(actors.publisher.accountId, targetRegionId, tx);
        },
        { isolationLevel: 'read committed' },
      );
      await approveErrand(f.pool, {
        version: 1,
        accountId: actors.publisher.accountId,
        purpose: 'publish_errand',
        title: input.title,
        publicText: input.publicText,
        privateText: input.privateText,
        expectedTimeText: input.expectedTimeText,
        reward: input.reward,
        publisherContacts: input.publisherContacts,
        publicAssetIds: [],
        privateAssetIds: [],
        scope,
      });
      const result = await authorized(
        request(http).post('/v1/errands'),
        actors.publisher,
      ).send(input);
      qrOk(result);
      return result.body as { orderId: string; revision: string };
    }
    const order = await publish(f.scope.related.regionId),
      wrongOrder = await publish(f.scope.home.regionId);
    const profile = await authorized(request(http).get('/v1/me/profile'));
    qrOk(profile);
    qrOk(
      await authorized(request(http).put('/v1/me/campus')).send({
        expectedRevision: profile.body.revision,
        campusId: f.scope.foreign.campusId,
      }),
    );
    const target = (
      await f.pool.query(
        'SELECT name FROM whaleu_campus.operating_regions WHERE id=$1',
        [f.scope.related.regionId],
      )
    ).rows[0].name;
    const descriptor = (revision: number) =>
      authorized(
        request(http).get(
          `/v3/media/school-configuration/errands/${order.orderId}/descriptor`,
        ),
      ).query({ entryRevision: revision });
    const imagePath = (binding: string, orderId = order.orderId) =>
      `/v3/media/school-configuration/errands/${orderId}/bindings/${binding}/display-v1`;
    let initialBinding = '',
      currentBinding = '';
    async function save(revision: number, enabled: boolean) {
      const result = await authorized(
        request(http).post(
          `/v1/me/school-configuration/${f.scope.related.regionId}/entries/errand`,
        ),
        actors.owner,
      ).send({
        clientRequestId: randomUUID(),
        expectedRevision: revision,
        entry: schoolData('errand', enabled),
        qrcode: { action: 'keep' },
      });
      qrOk(result);
    }
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/errand-target-services-native-worker.mjs',
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
    const finished = new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure') throw Error(String(m['message']));
          if (m['event'] === 'checkpoint') {
            const name = m['name'];
            if (name === 'process-images') {
              for (const kind of ['seal', 'process', 'review'] as const)
                assert.equal(await f.worker.runOne(kind), true);
            } else if (
              name === 'verify-initial' ||
              name === 'verify-replacement'
            ) {
              const revision = name === 'verify-initial' ? 1 : 3;
              const desc = await descriptor(revision);
              qrOk(desc);
              assert.equal(desc.body.regionId, f.scope.related.regionId);
              assert.equal(desc.body.entryKey, 'errand');
              const binding = String(desc.body.bindingId);
              if (revision === 1) initialBinding = binding;
              else {
                currentBinding = binding;
                assert.notEqual(binding, initialBinding);
              }
              const image = await authorized(
                request(http).get(imagePath(binding)),
              ).query({ entryRevision: revision });
              qrOk(image);
              assert.ok(image.headers['cache-control']?.includes('no-store'));
              assert.deepEqual(
                Buffer.from(String(m['bytes']), 'base64'),
                image.body,
              );
              const asset = (
                await f.pool.query(
                  'SELECT a.manifest FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id WHERE b.id=$1',
                  [binding],
                )
              ).rows[0];
              assert.equal(
                sha256(image.body),
                asset.manifest.variants.find(
                  (v: { name: string }) => v.name === 'display-v1',
                ).sha256,
              );
              if (revision === 1) {
                qrOk(
                  await request(http).get(
                    `/v1/school-services/errands/${order.orderId}`,
                  ),
                  401,
                );
                qrOk(
                  await request(http)
                    .get(`/v1/school-services/errands/${order.orderId}`)
                    .set('Authorization', 'Bearer invalid'),
                  401,
                );
                qrOk(
                  await authorized(
                    request(http).get(
                      `/v1/school-services/errands/${order.orderId}`,
                    ),
                  ).query({ campusId: f.scope.foreign.campusId }),
                  400,
                );
                qrOk(
                  await authorized(
                    request(http).get(
                      `/v3/media/school-configuration/errands/${order.orderId}/descriptor`,
                    ),
                  ).query({
                    entryRevision: 1,
                    regionId: f.scope.home.regionId,
                  }),
                  400,
                );
                qrOk(
                  await request(http)
                    .get(imagePath(binding))
                    .set('Authorization', 'Bearer invalid')
                    .query({ entryRevision: 1 }),
                  401,
                );
                qrOk(
                  await authorized(
                    request(http).get(imagePath(binding, wrongOrder.orderId)),
                  ).query({ entryRevision: 1 }),
                  503,
                );
                qrOk(
                  await authorized(request(http).get(imagePath(binding))).query(
                    { entryRevision: 2 },
                  ),
                  503,
                );
                qrOk(
                  await authorized(request(http).get(imagePath(binding)))
                    .set('Range', 'bytes=0-4')
                    .query({ entryRevision: 1 }),
                  503,
                );
                qrOk(
                  await authorized(
                    request(http).get(
                      `/v3/media/school-configuration/management/regions/${f.scope.related.regionId}/entries/errand/descriptor`,
                    ),
                  ).query({ entryRevision: 1 }),
                  403,
                );
                qrOk(
                  await authorized(
                    request(http).get(
                      `/v1/school-services/errands/${randomUUID()}`,
                    ),
                  ),
                  404,
                );
              } else {
                qrOk(
                  await authorized(
                    request(http).get(imagePath(initialBinding)),
                  ).query({ entryRevision: 3 }),
                  503,
                );
                qrOk(
                  await authorized(request(http).get(imagePath(binding))).query(
                    { entryRevision: 1 },
                  ),
                  503,
                );
              }
            } else if (name === 'profile-conflict') {
              const now = await authorized(request(http).get('/v1/me/profile'));
              qrOk(now);
              qrOk(
                await authorized(
                  request(http).patch('/v1/me/preferences'),
                ).send({
                  expectedRevision: now.body.revision,
                  preferences: { showHotTopic: false },
                }),
              );
            } else if (name === 'verify-dismiss') {
              const now = await authorized(request(http).get('/v1/me/profile'));
              qrOk(now);
              assert.equal(now.body.preferences.showErrandGroupNotice, false);
              assert.equal(now.body.preferences.showHotTopic, false);
              const other = await authorized(
                request(http).get('/v1/me/profile'),
                actors.other,
              );
              qrOk(other);
              assert.equal(other.body.preferences.showErrandGroupNotice, true);
            } else if (name === 'verify-disabled') {
              qrOk(await descriptor(2), 503);
              qrOk(
                await authorized(
                  request(http).get(imagePath(initialBinding)),
                ).query({ entryRevision: 1 }),
                503,
              );
            } else throw Error('Unknown checkpoint');
            child.send({ event: 'continue', name });
          } else if (m['event'] === 'done') {
            assert.ok(Number(m['requests']) > 20);
            assert.equal(m['uploads'], 2);
            assert.ok(Number(m['reads']) >= 5);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!done)
          reject(Error(`Native errand target worker exited ${code}: ${logs}`));
      });
    });
    child.send({
      port: f.port,
      actors,
      orderId: order.orderId,
      regionId: f.scope.related.regionId,
      target,
      png: png.toString('base64'),
      replacement: replacement.toString('base64'),
    });
    await finished;
    // Revoke entry while object open is paused. No byte may escape the second guard.
    const originalOpen = f.storage.openExact.bind(f.storage);
    let changed = false;
    f.storage.openExact = async (object, maximum) => {
      const opened = await originalOpen(object, maximum);
      if (!changed) {
        changed = true;
        await save(3, false);
      }
      return opened;
    };
    const blocked = await authorized(
      request(http).get(imagePath(currentBinding)),
    ).query({ entryRevision: 3 });
    qrOk(blocked, 503);
    assert.ok(!Buffer.isBuffer(blocked.body));
    f.storage.openExact = originalOpen;
    await save(4, true);
    // Losing the order itself between object open and second authorization also blocks bytes.
    changed = false;
    f.storage.openExact = async (object, maximum) => {
      const opened = await originalOpen(object, maximum);
      if (!changed) {
        changed = true;
        qrOk(
          await authorized(
            request(http).post(`/v1/errands/${order.orderId}/delete`),
            actors.publisher,
          ).send({
            clientRequestId: randomUUID(),
            expectedRevision: order.revision,
          }),
        );
      }
      return opened;
    };
    const deleted = await authorized(
      request(http).get(imagePath(currentBinding)),
    ).query({ entryRevision: 5 });
    assert.notEqual(deleted.status, 200);
    assert.ok(!Buffer.isBuffer(deleted.body));
    f.storage.openExact = originalOpen;
    qrOk(
      await authorized(
        request(http).get(`/v1/school-services/errands/${order.orderId}`),
      ),
      404,
    );
  },
);
