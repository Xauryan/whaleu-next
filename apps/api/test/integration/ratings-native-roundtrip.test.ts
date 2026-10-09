import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  ratingRuntimeFixture,
  approveRating,
} from '../support/rating-runtime-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  HttpRatingsGateway,
} = require('../../../wechat/src/ratings/gateway.ts');
test('actual native ratings gateway decodes default AppModule and recovers lost score/text/delete responses', async () => {
  const f = await ratingRuntimeFixture();
  try {
    const actor = await f.actor(),
      c = await f.catalog(actor),
      target = c.targets[0]!,
      cancel = new Cancellation(),
      transport = new DirectoryHttpTransport(f.port),
      sessions = new SessionStore();
    sessions.completeLogin(sessions.beginLogin(), actor);
    const auth = new AuthService(
        sessions,
        new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
        {
          login: async () => {
            throw new Error('No provider calls');
          },
        },
        systemClock,
      ),
      api = new ApiClient(directoryNativeOrigin, transport, sessions, auth),
      gateway = new HttpRatingsGateway(api);
    const context = await gateway.context(cancel);
    assert.equal(context.homeRegion.id, f.scope.home.regionId);
    const categories = await gateway.categories(null, null, null, cancel);
    assert.equal(categories.items[0].id, c.rootId);
    const targets = await gateway.targets(null, c.categoryId, null, cancel);
    assert.equal(targets.items[0].id, target.id);
    const detail = await gateway.detail(null, target.id, cancel);
    assert.deepEqual(detail.allowedActions.authorModes, ['named', 'anonymous']);
    assert.equal(
      (await gateway.myScore(null, target.id, cancel)).myScore,
      null,
    );
    assert.equal((await gateway.summary(null, target.id, cancel)).count, 0);
    const score = {
      operation: 'set_score',
      targetId: target.id,
      payload: {
        clientRequestId: randomUUID(),
        regionId: null,
        expectedTargetRevision: target.revision,
        expectedRevision: null,
        score: 4,
      },
    };
    transport.dropSuccess = {
      path: `/v1/ratings/targets/${target.id}/my-score`,
      method: 'PUT',
    };
    await assert.rejects(gateway.command(score, cancel));
    const receipt = await gateway.receipt(
      score.payload.clientRequestId,
      cancel,
    );
    assert.equal(receipt.outcome, 'applied');
    assert.deepEqual(await gateway.command(score, cancel), receipt);
    assert.equal(
      (await gateway.myScore(null, target.id, cancel)).myScore.score,
      4,
    );
    assert.equal((await gateway.summary(null, target.id, cancel)).sum, 4);
    const noop = await gateway.command(
      {
        ...score,
        payload: {
          ...score.payload,
          clientRequestId: randomUUID(),
          expectedRevision: receipt.revision,
        },
      },
      cancel,
    );
    assert.equal(noop.outcome, 'noop');
    assert.equal(noop.revision, receipt.revision);
    assert.equal(noop.occurredAt, receipt.occurredAt);
    const body = f.body(c, target, {
        authorMode: 'anonymous',
        body: '😀 Native reviewed text',
      }),
      intent = {
        operation: 'create_comment',
        targetId: target.id,
        payload: body,
      };
    await approveRating(f.pool, f.envelope(actor, c, target, body));
    transport.dropSuccess = {
      path: `/v1/ratings/targets/${target.id}/comments`,
      method: 'POST',
    };
    await assert.rejects(gateway.command(intent, cancel));
    const created = await gateway.receipt(body.clientRequestId, cancel);
    assert.equal(created.outcome, 'applied');
    assert.deepEqual(await gateway.command(intent, cancel), created);
    const root = await gateway.comment(null, created.subjectId, cancel);
    assert.equal(root.author.mode, 'anonymous');
    assert.equal(root.author.targetId, target.id);
    assert.equal(root.isMine, true);
    const list = await gateway.comments(null, target.id, null, cancel);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].body, body.body);
    const deletion = {
      operation: 'delete_comment',
      commentId: root.id,
      payload: {
        clientRequestId: randomUUID(),
        regionId: null,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        expectedRevision: root.revision,
      },
    };
    transport.dropSuccess = {
      path: `/v1/ratings/comments/${root.id}`,
      method: 'DELETE',
    };
    await assert.rejects(gateway.command(deletion, cancel));
    const deleted = await gateway.receipt(
      deletion.payload.clientRequestId,
      cancel,
    );
    assert.equal(deleted.outcome, 'applied');
    assert.deepEqual(await gateway.command(deletion, cancel), deleted);
    await assert.rejects(gateway.comment(null, root.id, cancel));
    assert.equal(
      (await gateway.comments(null, target.id, null, cancel)).items.length,
      0,
    );
    assert.equal(
      (await gateway.myScore(null, target.id, cancel)).myScore.score,
      4,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.score_transitions',
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.comment_transitions',
        )
      ).rows[0]!.n,
      2,
    );
    transport.corruptNext = {
      path: `/v1/ratings/targets/${target.id}/my-score`,
      transform: () => ({ myScore: { score: 0, revision: receipt.revision } }),
    };
    await assert.rejects(gateway.myScore(null, target.id, cancel));
    const h = await f.catalog(actor, { baseline: false });
    const unknown = await gateway.summary(null, h.targets[0]!.id, cancel);
    assert.deepEqual(unknown, { status: 'unavailable' });
    await assert.rejects(gateway.myScore(null, h.targets[0]!.id, cancel));
  } finally {
    await f.close();
  }
});
