import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpBatchGateway } from '../src/media/batch-gateway';
import { batchSession } from '../src/media/batch-runtime';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport, signedIn } from './helpers';
import {
  identity,
  ids,
  origin,
  readyBatch,
  uuid,
} from './support/media-batch-fixtures';
import { mediaPublicationReference } from '../src/media/upload-runtime';
import { attempt } from './support/media-batch-fixtures';
function fixture() {
  const sessions = signedIn(ids.actor),
    transport = new ScriptedTransport(),
    cancel = new Cancellation();
  let refreshes = 0;
  const gateway = new HttpBatchGateway(origin, transport, sessions, {
    async refresh() {
      refreshes++;
      return sessions.snapshot();
    },
  });
  return {
    sessions,
    transport,
    cancel,
    session: batchSession(sessions, cancel),
    gateway,
    refreshes: () => refreshes,
  };
}
test('batch transport uses fixed v3 routes with full metadata only and rejects DTO URLs', async () => {
  const h = fixture(),
    status = readyBatch(),
    publication = mediaPublicationReference(attempt());
  h.transport.reply(status);
  await h.gateway.prepare(identity, h.session, h.cancel);
  h.transport.reply({ version: 3, state: 'recorded', status });
  await h.gateway.recover(identity.batchRequestId, h.session, h.cancel);
  h.transport.reply({ version: 3, state: 'recorded', status });
  await h.gateway.recoverPublication(
    publication,
    status.orderedAssets.map((a) => a.assetId),
    h.session,
    h.cancel,
  );
  h.transport.reply({
    version: 3,
    status,
    cancellation: {
      requestId: publication.clientRequestId,
      operation: 'publish_post',
      outcome: 'cancelled',
      intentHash: publication.intentHash,
    },
  });
  await h.gateway.fencePublication(
    uuid(2),
    publication,
    status.orderedAssets.map((a) => a.assetId),
    h.session,
    h.cancel,
  );
  assert.deepEqual(
    h.transport.requests.map((r) => r.url),
    [
      `${origin}/v3/media/batches/prepare`,
      `${origin}/v3/media/batches/requests/${identity.batchRequestId}`,
      `${origin}/v3/media/batches/recover-publication`,
      `${origin}/v3/media/batches/${uuid(2)}/fence-publication`,
    ],
  );
  assert.equal(
    JSON.stringify(h.transport.requests).includes('Original body'),
    false,
  );
  h.transport.reply({ ...status, url: 'https://bad.invalid/image' });
  await assert.rejects(h.gateway.prepare(identity, h.session, h.cancel));
});
test('v3 mutations and explicit fence never auto replay authentication failures', async () => {
  const h = fixture();
  for (const action of [
    () => h.gateway.prepare(identity, h.session, h.cancel),
    () =>
      h.gateway.fencePublication(
        uuid(2),
        mediaPublicationReference(attempt()),
        readyBatch().orderedAssets.map((a) => a.assetId),
        h.session,
        h.cancel,
      ),
  ]) {
    h.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
    await assert.rejects(action());
  }
  assert.equal(h.transport.requests.length, 2);
  assert.equal(h.refreshes(), 0);
});
