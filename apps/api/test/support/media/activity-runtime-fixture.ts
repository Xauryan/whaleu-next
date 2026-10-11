/** Typed11 activity helper. The caller owns real organization and publication
 * fixture setup; only immutable byte storage and processing adapters are fake. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  ACTIVITY_MEDIA_PROTOCOL,
  activityMediaStatusSchema,
  activityMediaGrantSchema,
  activityMediaUploadObservedSchema,
} from '../../../src/media/contracts-activity.js';
import type { ActivityMediaSlot } from '../../../src/media/contracts-activity.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
export const activityMediaPrefix = '/v3/media/activities';
export function activityMediaOk(
  response: { status: number; body: unknown },
  status = 200,
) {
  assert.equal(response.status, status, JSON.stringify(response.body));
}
export async function readyActivityImage(
  f: {
    app: INestApplication;
    worker: { runOne(kind: 'seal' | 'process' | 'review'): Promise<boolean> };
  },
  actor: { accessToken: string },
  activityId: string,
  slot: ActivityMediaSlot,
  revision: number,
  bytes: Buffer,
) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`;
  const input = {
    protocol: ACTIVITY_MEDIA_PROTOCOL,
    clientRequestId: randomUUID(),
    activityId,
    slot,
    revision,
    declaration: {
      mime: 'image/png',
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
  };
  const prepared = await request(http)
    .post(`${activityMediaPrefix}/upload-intents`)
    .set('Authorization', auth)
    .send(input);
  activityMediaOk(prepared);
  const initial = activityMediaStatusSchema.parse(prepared.body);
  const granted = await request(http)
    .post(`${activityMediaPrefix}/upload-intents/${initial.intentId}/grant`)
    .set('Authorization', auth)
    .send({});
  activityMediaOk(granted);
  const grant = activityMediaGrantSchema.parse(granted.body);
  const uploaded = await request(http)
    .post(
      `${activityMediaPrefix}/upload-intents/${initial.intentId}/uploads/${grant.grantId}`,
    )
    .set('Authorization', auth)
    .attach('file', bytes, {
      filename: 'ignored-activity-image',
      contentType: 'image/png',
    });
  activityMediaOk(uploaded);
  assert.equal(
    activityMediaUploadObservedSchema.parse(uploaded.body).sha256,
    sha256(bytes),
  );
  activityMediaOk(
    await request(http)
      .post(
        `${activityMediaPrefix}/upload-intents/${initial.intentId}/finalize`,
      )
      .set('Authorization', auth)
      .send({}),
  );
  for (const kind of ['seal', 'process', 'review'] as const)
    assert.equal(await f.worker.runOne(kind), true);
  const response = await request(http)
    .get(`${activityMediaPrefix}/upload-intents/${initial.intentId}`)
    .set('Authorization', auth);
  activityMediaOk(response);
  return { input, status: activityMediaStatusSchema.parse(response.body) };
}
