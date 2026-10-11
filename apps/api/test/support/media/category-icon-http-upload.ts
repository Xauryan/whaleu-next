/** TEST ONLY transport helper. The caller must obtain an actual authorized
 * Category owner scope and explicitly install synthetic Media storage/worker DI.
 * This helper never creates an owner scope, Review approval or a ready row. */
import assert from 'node:assert/strict';
import request from 'supertest';
import type { SyntheticMediaWorker } from './synthetic-worker.js';
import {
  prepareCategoryIconMediaSchema,
  categoryIconMediaGrantSchema,
  categoryIconMediaStatusSchema,
  categoryIconMediaRecoverySchema,
  categoryIconMediaUploadObservedSchema,
} from '../../../src/media/contracts-category-icon.js';
import { sha256 } from '../../../src/media/processing/protocol.js';

export async function uploadCategoryIconViaHttp(input: {
  http: Parameters<typeof request>[0];
  accessToken: string;
  prepare: unknown;
  bytes: Buffer;
  worker: Pick<SyntheticMediaWorker, 'runOne'>;
}) {
  const prepare = prepareCategoryIconMediaSchema.parse(input.prepare);
  assert.equal(prepare.declaration.bytes, input.bytes.length);
  assert.equal(prepare.declaration.sha256, sha256(input.bytes));
  const base = '/v3/media/ratings-category-icon';
  const auth = (r: request.Test) =>
    r.set('Authorization', `Bearer ${input.accessToken}`);
  const ok = (response: { status: number; body: unknown }) =>
    assert.equal(response.status, 200, JSON.stringify(response.body));
  const prepared = await auth(
    request(input.http).post(`${base}/upload-scopes`),
  ).send(prepare);
  ok(prepared);
  const pending = categoryIconMediaStatusSchema.parse(prepared.body);
  assert.equal(pending.editScopeId, prepare.editScopeId);
  const recovered = await auth(
    request(input.http).get(
      `${base}/upload-requests/${prepare.clientRequestId}`,
    ),
  );
  ok(recovered);
  const history = categoryIconMediaRecoverySchema.parse(recovered.body);
  assert.equal(history.state, 'recorded');
  assert.equal(history.requestHash, pending.requestHash);
  const granted = await auth(
    request(input.http).post(
      `${base}/upload-scopes/${prepare.editScopeId}/grant`,
    ),
  ).send({});
  ok(granted);
  const grant = categoryIconMediaGrantSchema.parse(granted.body);
  const uploaded = await auth(
    request(input.http).post(
      `${base}/upload-scopes/${prepare.editScopeId}/uploads/${grant.grantId}`,
    ),
  ).attach('file', input.bytes, {
    filename: 'synthetic-category-icon',
    contentType: prepare.declaration.mime,
  });
  ok(uploaded);
  const observed = categoryIconMediaUploadObservedSchema.parse(uploaded.body);
  assert.equal(observed.sha256, prepare.declaration.sha256);
  assert.equal(observed.editScopeId, prepare.editScopeId);
  ok(
    await auth(
      request(input.http).post(
        `${base}/upload-scopes/${prepare.editScopeId}/finalize`,
      ),
    ).send({}),
  );
  for (const stage of ['seal', 'process', 'review'] as const)
    assert.equal(
      await input.worker.runOne(stage),
      true,
      `${stage} processed one exact registered fixture`,
    );
  const result = await auth(
    request(input.http).get(`${base}/upload-scopes/${prepare.editScopeId}`),
  );
  ok(result);
  const status = categoryIconMediaStatusSchema.parse(result.body);
  if (status.status !== 'ready_unbound') assert.fail(JSON.stringify(status));
  return { prepare, status };
}
