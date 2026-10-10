import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { MediaUploadController } from '../src/media/upload-controller';
import { decodeUploadStatus } from '../src/media/upload-contracts';
import { credentials, deferred, flush } from './helpers';
import {
  bound,
  hash,
  ids,
  prepare,
  prepared,
  ready,
  recovery,
  terminal,
  uploaded,
  uploadHarness,
} from './support/media-upload-fixtures';
const target = { draftId: ids.draft, spaceId: ids.space };

test('select durably freezes exact prepare before first HTTP write and 100% is never ready', async () => {
  const h = uploadHarness();
  let uploadView = '';
  const upload = h.transfer.upload;
  h.transfer.upload = async (...args) => {
    const result = await upload(...args);
    uploadView = h.controller.snapshot().status;
    assert.equal(h.pending.load(ids.actor)?.phase, 'upload_uncertain');
    return result;
  };
  await h.controller.select(target);
  assert.equal(h.pending.load(ids.actor)?.phase, 'prepare_uncertain');
  assert.equal(h.calls.includes('prepare'), false);
  const first = h.controller.start(),
    second = h.controller.start();
  assert.equal(first, second);
  await first;
  assert.equal(uploadView, 'uploading');
  assert.equal(h.controller.snapshot().status, 'ready');
  assert.equal(h.controller.snapshot().assetId, ids.asset);
  assert.equal(h.pending.load(ids.actor)?.phase, 'ready_hint');
  assert.equal(h.calls.filter((c) => c === 'prepare').length, 1);
  assert.equal(h.calls.filter((c) => c === 'upload').length, 1);
  h.controller.dispose();
  assert.ok(h.pending.load(ids.actor));
});
test('journal write failure prevents prepare and a second selection cannot replace unresolved image', async () => {
  const h = uploadHarness();
  h.storage.failWrite = true;
  await assert.rejects(h.controller.select(target));
  assert.equal(h.calls.includes('prepare'), false);
  assert.equal(h.pending.load(ids.actor), null);
  h.storage.failWrite = false;
  await h.controller.select(target);
  await assert.rejects(h.controller.select(target));
  assert.equal(h.calls.filter((c) => c === 'pick').length, 2);
  assert.equal(h.pending.load(ids.actor)?.clientRequestId, ids.request);
  h.controller.dispose();
});
test('prepare response loss and controller restart recover same request without local-path resurrection', async () => {
  const h = uploadHarness();
  h.failPrepare();
  await h.controller.select(target);
  await assert.rejects(h.controller.start());
  assert.equal(h.pending.load(ids.actor)?.intentId, null);
  h.controller.dispose();
  const restarted = h.create();
  await restarted.recover();
  assert.equal(restarted.snapshot().status, 'needs_reselection');
  assert.equal(h.calls.filter((c) => c === 'prepare').length, 1);
  assert.equal(h.calls.includes('upload'), false);
  await restarted.cancelOriginal();
  assert.equal(restarted.snapshot().status, 'terminal');
  assert.equal(restarted.snapshot().cleanup, 'retained');
  assert.equal(h.pending.load(ids.actor), null);
  restarted.dispose();
});
test('prepared request not yet recorded is cancelled by durable key fence, not erased on not_recorded', async () => {
  const h = uploadHarness();
  await h.controller.select(target);
  const cancel = h.gateway.cancelRequest;
  h.gateway.cancelRequest = async (...args) => {
    assert.equal(h.pending.load(ids.actor)?.phase, 'cancel_uncertain');
    return cancel(...args);
  };
  await h.controller.cancelOriginal();
  assert.equal(h.calls.includes('prepare'), false);
  assert.equal(h.calls.filter((c) => c === 'cancel').length, 1);
  assert.equal(h.pending.load(ids.actor), null);
  h.controller.dispose();
});
test('unknown cancel retains pending across restart and retries only original key', async () => {
  const h = uploadHarness();
  await h.controller.select(target);
  h.failCancel();
  await assert.rejects(h.controller.cancelOriginal());
  assert.equal(h.pending.load(ids.actor)?.phase, 'cancel_uncertain');
  h.controller.dispose();
  const restarted = h.create();
  await assert.rejects(restarted.recover());
  assert.equal(h.calls.includes('prepare'), false);
  assert.equal(h.pending.load(ids.actor)?.requestHash, hash);
  restarted.dispose();
});
test('A → B → A/new epoch clears Work and old callbacks cannot settle a newer journal', async () => {
  const h = uploadHarness(),
    gate = deferred<ReturnType<typeof prepared>>();
  h.gateway.prepare = async () => {
    h.calls.push('prepare');
    h.setState(recovery(prepared()));
    return gate.promise;
  };
  await h.controller.select(target);
  const old = assert.rejects(h.controller.start());
  await flush();
  h.sessions.completeLogin(h.sessions.beginLogin(), credentials(ids.other));
  assert.equal(h.controller.snapshot().assetId, null);
  const count = h.calls.length;
  await h.controller.recover();
  assert.equal(h.calls.length, count);
  assert.equal(h.pending.load(ids.other), null);
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials(ids.actor, 'new'),
  );
  await h.controller.recover();
  assert.equal(h.controller.snapshot().status, 'needs_reselection');
  assert.equal(h.calls.includes('upload'), false);
  await h.controller.cancelOriginal();
  h.pending.freeze(ids.actor, { ...prepare, clientRequestId: ids.other }, 2000);
  gate.resolve(prepared());
  await old;
  await flush();
  assert.equal(h.pending.load(ids.actor)?.clientRequestId, ids.other);
  h.controller.dispose();
});
test('same-account relogin and process reconstruction use current token, no old file or grant', async () => {
  const h = uploadHarness();
  await h.controller.select(target);
  h.setState(recovery(uploaded()));
  h.controller.dispose();
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials(ids.actor, 'new'),
  );
  const finalize = h.gateway.finalize;
  h.gateway.finalize = async (...args) => {
    assert.equal(
      args[1].current().credentials?.accessToken,
      'synthetic-access-new',
    );
    return finalize(...args);
  };
  const fresh = h.create();
  await fresh.recover();
  assert.equal(fresh.snapshot().status, 'ready');
  assert.equal(h.calls.includes('pick'), true);
  assert.equal(h.calls.includes('grant'), false);
  assert.equal(h.calls.includes('upload'), false);
  fresh.dispose();
});
test('same dimensions and bytes but changed SHA cannot reuse immutable prepare/grant', async () => {
  const h = uploadHarness();
  await h.controller.select(target);
  h.setInspect({
    ...prepare.declaration,
    sha256: 'b'.repeat(64),
    width: 80,
    height: 60,
    frameCount: 'unknown',
  });
  await assert.rejects(h.controller.start());
  assert.equal(h.calls.includes('grant'), false);
  assert.equal(
    h.pending.load(ids.actor)?.prepare.declaration.sha256,
    'a'.repeat(64),
  );
  h.controller.dispose();
});
test('uploaded recovery finalizes without uploading and finalize response loss retains original journal', async () => {
  const h = uploadHarness();
  h.pending.freeze(ids.actor, prepare, 1000);
  h.setState(recovery(uploaded()));
  h.failFinalize();
  await assert.rejects(h.controller.recover());
  assert.equal(h.pending.load(ids.actor)?.phase, 'processing');
  assert.equal(h.calls.includes('upload'), false);
  await h.controller.recover();
  assert.equal(h.controller.snapshot().status, 'ready');
  assert.equal(h.calls.filter((c) => c === 'finalize').length, 1);
  h.controller.dispose();
});
test('ready retention is not expired using old operation deadline or client clock; unavailable is not terminal', async () => {
  const h = uploadHarness();
  const saved = h.pending.freeze(ids.actor, prepare, 1000);
  h.pending.update(saved, {
    intentId: ids.intent,
    phase: 'processing',
    operationDeadlineAt: 1500,
  });
  h.clock.advance(2000000);
  h.setState(recovery(ready()));
  await h.controller.recover();
  assert.equal(h.controller.snapshot().status, 'ready');
  assert.ok(h.pending.load(ids.actor));
  h.setState(
    recovery(
      decodeUploadStatus({
        version: 2,
        intentId: ids.intent,
        requestId: ids.request,
        requestHash: hash,
        serverNow: 2001000,
        status: 'unavailable',
        reason: 'MEDIA_UNAVAILABLE',
        retryable: true,
      }),
    ),
  );
  await h.controller.recover();
  assert.equal(h.controller.snapshot().status, 'unavailable');
  assert.ok(h.pending.load(ids.actor));
  h.controller.dispose();
});
test('publication uncertain asks receipt owner first; created detached binding forbids media cancel', async () => {
  const calls: string[] = [];
  const h = uploadHarness({
    async receipt() {
      calls.push('receipt');
      return {
        requestId: ids.publication,
        operation: 'publish_post',
        outcome: 'created',
        resourceId: ids.other,
        createdAt: '2026-10-10T00:00:00Z',
      };
    },
  });
  const saved = h.pending.freeze(ids.actor, prepare, 1000);
  h.pending.update(saved, {
    intentId: ids.intent,
    assetId: ids.asset,
    phase: 'publication_uncertain',
    publication: {
      clientRequestId: ids.publication,
      operation: 'publish_post',
      intentHash: 'b'.repeat(64),
    },
  });
  h.setState(recovery(bound()));
  const status = h.gateway.status;
  h.gateway.status = async (...args) => {
    calls.push('status');
    return status(...args);
  };
  await h.controller.cancelOriginal();
  assert.deepEqual(calls, ['receipt', 'status']);
  assert.equal(h.calls.includes('cancel'), false);
  assert.equal(h.controller.snapshot().status, 'bound_history');
  assert.equal(h.pending.load(ids.actor), null);
  h.controller.dispose();
});
test('missing publication receipt is uncertainty; explicit cancel may then race bind through original key fence', async () => {
  let receipts = 0;
  const h = uploadHarness({
    async receipt() {
      receipts++;
      throw new ClientError('http', 'Not yet recorded', {
        serverCode: 'REQUEST_NOT_FOUND',
      });
    },
  });
  const saved = h.pending.freeze(ids.actor, prepare, 1000);
  h.pending.update(saved, {
    intentId: ids.intent,
    assetId: ids.asset,
    phase: 'publication_uncertain',
    publication: {
      clientRequestId: ids.publication,
      operation: 'publish_post',
      intentHash: 'b'.repeat(64),
    },
  });
  await h.controller.recover();
  assert.equal(h.controller.snapshot().status, 'publication_pending');
  assert.equal(h.calls.includes('cancel'), false);
  assert.ok(h.pending.load(ids.actor));
  h.setState(recovery(bound()));
  await h.controller.cancelOriginal();
  assert.equal(receipts, 2);
  assert.equal(h.controller.snapshot().status, 'bound_history');
  h.controller.dispose();
});
test('late progress/ready callback after hide cannot repaint; terminal settlement failure stays recoverable', async () => {
  const h = uploadHarness(),
    gate = deferred<ReturnType<typeof ready>>();
  h.gateway.finalize = async () => gate.promise;
  await h.controller.select(target);
  const old = assert.rejects(h.controller.start());
  await flush();
  h.controller.hide();
  gate.resolve(ready());
  await old;
  assert.equal(h.controller.snapshot().status, 'idle');
  assert.ok(h.pending.load(ids.actor));
  h.setState(recovery(terminal()));
  h.storage.failRemove = true;
  await assert.rejects(h.controller.recover());
  assert.ok(h.pending.load(ids.actor));
  h.storage.failRemove = false;
  await h.controller.recover();
  assert.equal(h.pending.load(ids.actor), null);
  h.controller.dispose();
});
test('default controller without native transfer cannot select or send upload traffic', async () => {
  const h = uploadHarness();
  const closed = new MediaUploadController(
    h.sessions,
    h.pending,
    h.gateway,
    undefined,
    h.clock,
    async () => ids.request,
  );
  await assert.rejects(closed.select(target));
  assert.deepEqual(h.calls, []);
  assert.equal(closed.available, false);
  closed.dispose();
  h.controller.dispose();
});
