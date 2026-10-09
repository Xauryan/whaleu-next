import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  ratingEditFixture,
  ratingEditPrefix as prefix,
} from '../support/rating-edit-fixture.js';
import {
  approveRating,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { ratingTargetEditReceiptSchema } from '../../src/ratings/management/target-edit/contracts.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';

// Disposable canonical facts and real AppModule HTTP only. This suite does not
// replace Review, identity, grants, scope, command claims or SQL causality.
// Dedicated race/history suites own deferred waits and complete effect digests.
test('M2B creator text editing, exact Review, version CAS and private durable recovery', async (t) => {
  const f = await ratingEditFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    outsider = await f.actor();
  const catalog = await f.catalog(owner, { count: 12 });
  const targets = catalog.targets;
  assert.equal(targets.length, 12);
  type Actor = typeof owner;
  const context = (targetId: string, actor = owner) =>
    f.auth(request(f.http).get(`${prefix}/targets/${targetId}/context`), actor);
  const post = (route: string, body: object, actor = owner) =>
    f.auth(request(f.http).post(`${prefix}/${route}`), actor).send(body);
  const recover = (key: string, actor = owner) =>
    f.auth(request(f.http).get(`${prefix}/requests/${key}`), actor);
  const success = (response: request.Response, outcome: 'applied' | 'noop') => {
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const receipt = ratingTargetEditReceiptSchema.parse(response.body);
    if (receipt.outcome === 'rejected') assert.fail(JSON.stringify(receipt));
    assert.equal(receipt.outcome, outcome);
    return receipt;
  };
  const rejected = (response: request.Response, key: string, code: string) => {
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, {
      requestId: key,
      operation: 'edit_target',
      outcome: 'rejected',
      code,
    });
  };
  const noArtifacts = async (key: string, actor = owner) => {
    for (const [table, actorColumn] of [
      ['requests', 'account_id'],
      ['target_edit_transitions', 'actor_account_id'],
      ['target_edit_noops', 'actor_account_id'],
      ['target_edit_closures', 'actor_account_id'],
    ])
      assert.equal(
        (
          await f.pool.query(
            `SELECT 1 FROM whaleu_ratings.${table} WHERE ${actorColumn}=$1 AND request_id=$2`,
            [actor.accountId, key],
          )
        ).rowCount,
        0,
        table,
      );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE account_id=$1 AND envelope->>'clientRequestId'=$2",
          [actor.accountId, key],
        )
      ).rowCount,
      0,
    );
  };
  const epochs = async () =>
    (
      await f.pool.query(
        'SELECT n.epoch::text navigation,p.epoch::text pool,r.epoch::text review,b.epoch::text binding FROM whaleu_ratings.navigation_epoch n CROSS JOIN whaleu_ratings.random_pool_epoch p CROSS JOIN whaleu_community.rating_review_epoch r CROSS JOIN whaleu_community.rating_review_binding_epoch b',
      )
    ).rows[0];
  const versionState = async (targetId: string) => {
    const result: Record<string, unknown> = {};
    for (const [schema, table, key, order] of [
      ['whaleu_ratings', 'targets', 'id', 'id'],
      ['whaleu_ratings', 'target_definition_heads', 'target_id', 'target_id'],
      [
        'whaleu_ratings',
        'target_definition_versions',
        'target_id',
        'content_version',
      ],
      ['whaleu_ratings', 'target_state_revisions', 'target_id', 'revision'],
      [
        'whaleu_ratings',
        'target_definition_lifecycles',
        'target_id',
        'target_revision',
      ],
      [
        'whaleu_community',
        'rating_target_definition_bindings',
        'target_id',
        'content_version',
      ],
    ])
      result[table!] = (
        await f.pool.query(
          `SELECT to_jsonb(r) value FROM ${schema}.${table} r WHERE ${key}=$1 ORDER BY ${order}`,
          [targetId],
        )
      ).rows;
    return result;
  };
  const newSession = async (actor: Actor) => {
    const identity = (
      await f.pool.query<{
        provider: 'wechat';
        app_id: string;
        subject: string;
      }>(
        'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
        [actor.accountId],
      )
    ).rows[0]!;
    const accessToken = mintToken('access');
    const session = await f.app.get(IdentityRepository).createSession(
      {
        provider: identity.provider,
        appId: identity.app_id,
        subject: identity.subject,
      },
      {
        access: hashToken(accessToken),
        refresh: hashToken(mintToken('refresh')),
      },
    );
    return { ...actor, ...session, accessToken };
  };

  await t.test(
    'strict DTOs and visible context expose only current edit fields',
    async () => {
      const target = targets[0]!,
        response = await context(target.id);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(Object.keys(response.body).sort(), [
        'catalogRevision',
        'categoryId',
        'categoryRevision',
        'contentVersion',
        'definitionRevision',
        'description',
        'name',
        'regionId',
        'revision',
        'targetId',
      ]);
      assert.equal(response.body.contentVersion, 1);
      assert.equal(
        response.body.definitionRevision,
        target.approval.envelope.targetRevision,
      );
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(response.headers['vary'] ?? '', /Authorization/i);
      assert.equal(
        (await context(target.id).query({ regionId: f.scope.home.regionId }))
          .status,
        400,
      );
      for (const patch of [
        { creatorId: owner.accountId },
        { role: 'super_admin' },
        { accepted: true },
        { reviewDecisionId: randomUUID() },
        { sourceId: randomUUID() },
        { campusId: f.scope.home.campusId },
        { assetIds: [randomUUID()] },
        { expectedContentVersion: 1.5 },
        { previousDefinitionRevision: randomUUID() },
      ]) {
        const input = {
          ...f.editIntent(response.body, { name: 'Strict edited name' }),
          ...patch,
        };
        assert.equal(
          (await post('prepare', input)).status,
          400,
          JSON.stringify(input),
        );
        await noArtifacts(input.clientRequestId);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_edit_preparations WHERE account_id=$1 AND request_id=$2',
              [owner.accountId, input.clientRequestId],
            )
          ).rowCount,
          0,
        );
      }
    },
  );

  await t.test(
    'non-creators including all administrator roles cannot read or edit owner text',
    async () => {
      const target = targets[0]!,
        before = await f.editContext(owner, target.id);
      const actors: Actor[] = [outsider];
      for (const role of [
        'super_admin',
        'developer',
        'school_admin',
      ] as const) {
        const actor = await f.actor();
        await f.grant(
          actor,
          role,
          role === 'school_admin' ? f.scope.home.regionId : null,
        );
        actors.push(actor);
      }
      for (const actor of actors) {
        const response = await context(target.id, actor);
        assert.equal(
          response.body.error?.code,
          'RATING_NOT_FOUND',
          JSON.stringify(response.body),
        );
        assert.equal(
          JSON.stringify(response.body).includes(before.name),
          false,
        );
        assert.equal(
          JSON.stringify(response.body).includes(owner.accountId),
          false,
        );
        const input = f.editIntent(before, { name: 'Unauthorized rename' });
        const denial = await post('prepare', input, actor);
        rejected(denial, input.clientRequestId, 'RATING_NOT_FOUND');
        assert.deepEqual(
          (await recover(input.clientRequestId, actor)).body,
          denial.body,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_edit_preparations WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, input.clientRequestId],
            )
          ).rowCount,
          0,
        );
      }
      assert.equal((await f.editContext(owner, target.id)).contentVersion, 1);
    },
  );

  await t.test(
    'creator publishes v1 to v2 to v3 while original definition and creation source remain immutable',
    async () => {
      const target = targets[0]!;
      const original = (
        await f.pool.query(
          "SELECT to_jsonb(t)-'revision' value FROM whaleu_ratings.targets t WHERE id=$1",
          [target.id],
        )
      ).rows[0]!.value;
      const source = (
        await f.pool.query(
          'SELECT to_jsonb(s) value FROM whaleu_ratings.target_sources s WHERE target_id=$1',
          [target.id],
        )
      ).rows;
      const first = await f.edit(owner, target.id, {
        name: 'First edited name',
        description: 'First edited description',
      });
      assert.equal(first.receipt.contentVersion, 2);
      assert.notEqual(first.receipt.revision, first.before.revision);
      assert.notEqual(
        first.receipt.definitionRevision,
        first.before.definitionRevision,
      );
      const second = await f.edit(owner, target.id, {
        name: 'Second edited name',
        description: '',
      });
      assert.equal(second.receipt.contentVersion, 3);
      assert.equal(
        (await f.editContext(owner, target.id)).name,
        'Second edited name',
      );
      const detail = await f.auth(
        request(f.http).get(`/v1/ratings/targets/${target.id}`),
        owner,
      );
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(detail.body.name, 'Second edited name');
      assert.equal(detail.body.description, '');
      assert.equal(detail.body.revision, second.receipt.revision);
      assert.deepEqual(
        (
          await f.pool.query(
            "SELECT to_jsonb(t)-'revision' value FROM whaleu_ratings.targets t WHERE id=$1",
            [target.id],
          )
        ).rows[0]!.value,
        original,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT to_jsonb(s) value FROM whaleu_ratings.target_sources s WHERE target_id=$1',
            [target.id],
          )
        ).rows,
        source,
      );
      const versions = (
        await f.pool.query<{
          content_version: number;
          protocol: number;
          exact: boolean;
        }>(
          `SELECT v.content_version,(v.envelope->>'version')::integer protocol,
       v.applied_target_revision::text=v.envelope->>'targetRevision' AND
       (v.content_version=1 OR (v.definition_revision::text=v.envelope->>'definitionRevision' AND b.envelope=v.envelope AND b.publication_transaction=v.publication_transaction)) exact
       FROM whaleu_ratings.target_definition_versions v LEFT JOIN whaleu_community.rating_target_definition_bindings b ON b.target_id=v.target_id AND b.content_version=v.content_version
       WHERE v.target_id=$1 ORDER BY v.content_version`,
          [target.id],
        )
      ).rows;
      assert.deepEqual(
        versions.map((v) => [v.content_version, v.protocol, v.exact]),
        [
          [1, 1, true],
          [2, 3, true],
          [3, 3, true],
        ],
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.target_creations WHERE target_id=$1',
            [target.id],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.score_baselines WHERE target_id=$1',
            [target.id],
          )
        ).rowCount,
        1,
      );
    },
  );

  await t.test(
    'exact new Review cannot be replaced by original or other edit-context approvals; revoke never falls back',
    async () => {
      const target = targets[1]!,
        before = await f.editContext(owner, target.id);
      const input = f.editIntent(before, { name: 'Precisely reviewed edit' }),
        prepared = await f.prepareEdit(owner, input);
      const envelope = canonicalRatingEnvelope(
        (
          await f.pool.query<{ envelope: unknown }>(
            'SELECT envelope FROM whaleu_ratings.target_edit_preparations WHERE account_id=$1 AND request_id=$2',
            [owner.accountId, input.clientRequestId],
          )
        ).rows[0]!.envelope,
      );
      const missing = await f.commitEdit(
        owner,
        input,
        prepared.contextRevision,
      );
      assert.equal(missing.body.error?.code, 'CONTENT_REVIEW_UNAVAILABLE');
      await noArtifacts(input.clientRequestId);
      for (const patch of [
        { accountId: outsider.accountId },
        { clientRequestId: randomUUID() },
        { targetId: randomUUID() },
        { previousTargetRevision: randomUUID() },
        { previousDefinitionRevision: randomUUID() },
        { targetRevision: randomUUID() },
        { definitionRevision: randomUUID() },
        { contentVersion: 3 },
        { categoryRevision: randomUUID() },
        { catalogRevision: randomUUID() },
        { scope: { regionId: f.scope.home.regionId } },
        { name: 'Other reviewed text' },
      ]) {
        await approveRating(
          f.pool,
          canonicalRatingEnvelope({ ...envelope, ...patch }),
        );
        const mismatch = await f.commitEdit(
          owner,
          input,
          prepared.contextRevision,
        );
        assert.equal(
          mismatch.body.error?.code,
          'CONTENT_REVIEW_UNAVAILABLE',
          JSON.stringify(mismatch.body),
        );
        await noArtifacts(input.clientRequestId);
      }
      const approved = await f.approveEdit(owner, input);
      success(
        await f.commitEdit(owner, input, prepared.contextRevision),
        'applied',
      );
      await setRatingReviewState(f.pool, approved.decisionId, 'revoked');
      assert.equal(
        (await context(target.id)).body.error?.code,
        'RATING_NOT_FOUND',
      );
      assert.equal(
        (
          await f.auth(
            request(f.http).get(`/v1/ratings/targets/${target.id}`),
            owner,
          )
        ).body.error?.code,
        'RATING_NOT_FOUND',
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_community.rating_approval_bindings b JOIN whaleu_community.rating_approval_heads h ON h.decision_id=b.decision_id JOIN whaleu_community.rating_approval_events e ON e.id=h.event_id WHERE b.kind='target' AND b.subject_id=$1 AND e.state='allow'",
            [target.id],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (await recover(input.clientRequestId)).body.outcome,
        'applied',
      );
    },
  );

  await t.test(
    'same text requires complete preparation and exact CAS but consumes no next binding or public epoch',
    async () => {
      const target = targets[2]!,
        current = await f.editContext(owner, target.id);
      const noPrepare = f.editIntent(current);
      rejected(
        await f.commitEdit(owner, noPrepare, 'x'.repeat(43)),
        noPrepare.clientRequestId,
        'RATING_EDIT_CONTEXT_CHANGED',
      );
      const input = f.editIntent(current),
        beforePrepare = await epochs(),
        prepared = await f.prepareEdit(owner, input);
      assert.deepEqual(await epochs(), beforePrepare);
      const unusedApproval = await f.approveEdit(owner, input);
      const before = await versionState(target.id),
        beforeCommit = await epochs();
      const noop = success(
        await f.commitEdit(owner, input, prepared.contextRevision),
        'noop',
      );
      assert.equal(noop.revision, current.revision);
      assert.equal(noop.definitionRevision, current.definitionRevision);
      assert.equal(noop.contentVersion, current.contentVersion);
      assert.deepEqual(await versionState(target.id), before);
      assert.deepEqual(await epochs(), beforeCommit);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_community.rating_target_definition_bindings WHERE decision_id=$1',
            [unusedApproval.decisionId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.target_edit_noops WHERE actor_account_id=$1 AND request_id=$2',
            [owner.accountId, input.clientRequestId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.target_edit_transitions WHERE actor_account_id=$1 AND request_id=$2',
            [owner.accountId, input.clientRequestId],
          )
        ).rowCount,
        0,
      );
      const stale = f.editIntent(current),
        stalePrepared = await f.prepareEdit(owner, stale);
      await f.edit(owner, target.id, {
        description: 'Temporary distinct description',
      });
      await f.edit(owner, target.id, { description: current.description });
      const sameAgain = await f.editContext(owner, target.id);
      assert.equal(sameAgain.name, stale.name);
      assert.equal(sameAgain.description, stale.description);
      assert.notEqual(sameAgain.revision, stale.expectedTargetRevision);
      const beforeStale = await versionState(target.id);
      rejected(
        await f.commitEdit(owner, stale, stalePrepared.contextRevision),
        stale.clientRequestId,
        'RATING_EDIT_CONTEXT_CHANGED',
      );
      assert.deepEqual(await versionState(target.id), beforeStale);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.target_edit_noops WHERE actor_account_id=$1 AND request_id=$2',
            [owner.accountId, stale.clientRequestId],
          )
        ).rowCount,
        0,
      );
    },
  );

  await t.test(
    'same key freezes original intent and conflicts with score, create and delete namespaces in both directions',
    async () => {
      const target = targets[3]!,
        current = await f.editContext(owner, target.id);
      const input = f.editIntent(current, { name: 'Reserved edit name' }),
        prepared = await f.prepareEdit(owner, input);
      assert.deepEqual(await f.prepareEdit(owner, input), prepared);
      assert.equal(
        (await post('prepare', { ...input, name: 'Changed key content' })).body
          .error?.code,
        'REQUEST_CONFLICT',
      );
      assert.equal(
        (
          await f.commitEdit(
            owner,
            { ...input, description: 'Changed key content' },
            prepared.contextRevision,
          )
        ).body.error?.code,
        'REQUEST_CONFLICT',
      );
      const score = (key: string) =>
        f
          .auth(
            request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
            owner,
          )
          .send({
            clientRequestId: key,
            regionId: null,
            expectedTargetRevision: current.revision,
            expectedRevision: null,
            score: 4,
          });
      const createIntent = (key: string) => ({
        clientRequestId: key,
        regionId: null,
        categoryId: current.categoryId,
        expectedCategoryRevision: current.categoryRevision,
        expectedCatalogRevision: current.catalogRevision,
        name: 'Cancelled creation',
        description: '',
        assetIds: [],
      });
      const createCancel = (key: string) =>
        f
          .auth(request(f.http).post('/v1/ratings/management/cancel'), owner)
          .send(createIntent(key));
      const deleteCancel = (key: string) =>
        f
          .auth(
            request(f.http).post(
              '/v1/ratings/management/owner-deletion/cancel',
            ),
            owner,
          )
          .send({
            clientRequestId: key,
            targetId: target.id,
            expectedTargetRevision: current.revision,
          });
      for (const operation of [score, createCancel, deleteCancel])
        assert.equal(
          (await operation(input.clientRequestId)).body.error?.code,
          'REQUEST_CONFLICT',
        );
      for (const operation of [score, createCancel, deleteCancel]) {
        const key = randomUUID(),
          original = await operation(key);
        assert.equal(original.status, 200, JSON.stringify(original.body));
        assert.equal(
          (await post('prepare', { ...input, clientRequestId: key })).body.error
            ?.code,
          'REQUEST_CONFLICT',
        );
        assert.equal(
          (await recover(key)).body.error?.code,
          'REQUEST_NOT_FOUND',
        );
      }
    },
  );

  await t.test(
    'discarded success recovers in a new session before present phone, scope or Review eligibility',
    async () => {
      const target = targets[4]!,
        current = await f.editContext(owner, target.id);
      const input = f.editIntent(current, { name: 'Lost response edit' }),
        prepared = await f.prepareEdit(owner, input),
        approved = await f.approveEdit(owner, input);
      // Intentionally do not retain the successful command response.
      await f.commitEdit(owner, input, prepared.contextRevision);
      const receiptResponse = await recover(input.clientRequestId),
        receipt = success(receiptResponse, 'applied');
      assert.deepEqual(Object.keys(receipt).sort(), [
        'contentVersion',
        'definitionRevision',
        'occurredAt',
        'operation',
        'outcome',
        'requestId',
        'revision',
        'targetId',
      ]);
      const refreshed = await newSession(owner);
      await f.certify(owner.accountId, {
        affiliation: 'unavailable',
        phone: 'unavailable',
        identity: false,
      });
      await setRatingReviewState(f.pool, approved.decisionId, 'revoked');
      assert.deepEqual(
        (await recover(input.clientRequestId, refreshed)).body,
        receipt,
      );
      assert.deepEqual(
        (await f.commitEdit(refreshed, input, prepared.contextRevision)).body,
        receipt,
      );
      assert.deepEqual((await post('cancel', input, refreshed)).body, receipt);
      assert.equal(
        (await recover(input.clientRequestId, outsider)).body.error?.code,
        'REQUEST_NOT_FOUND',
      );
      assert.equal((await context(target.id, refreshed)).status, 503);
      owner.accessToken = refreshed.accessToken;
      await f.certify(owner.accountId);
    },
  );

  await t.test(
    'a new session can close old preparation but cannot publish its old context',
    async () => {
      const target = targets[5]!,
        current = await f.editContext(owner, target.id);
      const input = f.editIntent(current, {
          name: 'Session-bound preparation',
        }),
        prepared = await f.prepareEdit(owner, input);
      await f.approveEdit(owner, input);
      const before = await versionState(target.id),
        refreshed = await newSession(owner);
      rejected(
        await f.commitEdit(refreshed, input, prepared.contextRevision),
        input.clientRequestId,
        'RATING_EDIT_CONTEXT_CHANGED',
      );
      assert.deepEqual(await versionState(target.id), before);
      assert.equal(
        (await recover(input.clientRequestId, refreshed)).body.code,
        'RATING_EDIT_CONTEXT_CHANGED',
      );
      owner.accessToken = refreshed.accessToken;
    },
  );

  await t.test(
    'cancel before prepare or after an unresolved preparation closes only that exact original key',
    async () => {
      const target = targets[6]!,
        current = await f.editContext(owner, target.id);
      for (const prepareFirst of [false, true]) {
        const input = f.editIntent(current, {
          description: 'Cancelled edited text',
        });
        const prepared = prepareFirst
          ? await f.prepareEdit(owner, input)
          : null;
        if (prepareFirst) await f.approveEdit(owner, input);
        assert.equal(
          (await recover(input.clientRequestId)).body.error?.code,
          'REQUEST_NOT_FOUND',
        );
        const before = await versionState(target.id),
          beforeEpoch = await epochs();
        const cancelled = await post('cancel', input);
        rejected(cancelled, input.clientRequestId, 'RATING_EDIT_CANCELLED');
        assert.deepEqual(
          (
            await f.commitEdit(
              owner,
              input,
              prepared?.contextRevision ?? 'x'.repeat(43),
            )
          ).body,
          cancelled.body,
        );
        assert.deepEqual((await post('prepare', input)).body, cancelled.body);
        assert.deepEqual((await post('cancel', input)).body, cancelled.body);
        assert.deepEqual(
          (await recover(input.clientRequestId)).body,
          cancelled.body,
        );
        assert.deepEqual(await versionState(target.id), before);
        assert.deepEqual(await epochs(), beforeEpoch);
        assert.equal(
          (
            await post('cancel', {
              ...input,
              name: 'Different original intent',
            })
          ).body.error?.code,
          'REQUEST_CONFLICT',
        );
      }
    },
  );

  await t.test(
    'missing, pending, failed and expired Review or unknown phone remain retryable without durable rejection',
    async () => {
      // Keep the real shared 120/minute account guard enabled. This independent
      // retry matrix uses its own actor; preserve the next scenario's old target
      // as a legitimate membership in the newly current global catalog.
      const actor = await f.actor();
      const retryCatalog = await f.catalog(actor, {
        categoryIds: catalog.categoryIds,
        sharedTargets: [{ id: targets[8]!.id, categoryId: catalog.categoryId }],
      });
      const target = retryCatalog.targets[0]!;
      for (const kind of [
        'missing',
        'pending',
        'failed',
        'expired',
        'phone',
      ] as const) {
        const current = await f.editContext(actor, target.id),
          input = f.editIntent(current, { name: `Recovered ${kind} edit` }),
          prepared = await f.prepareEdit(actor, input);
        if (kind === 'pending' || kind === 'failed')
          await f.approveEdit(actor, input, { result: kind });
        if (kind === 'expired')
          await f.approveEdit(actor, input, {
            consumeUntil: new Date(Date.now() - 1),
          });
        if (kind === 'phone') {
          await f.approveEdit(actor, input);
          await f.certify(actor.accountId, { phone: 'unavailable' });
        }
        const unknown = await f.commitEdit(
          actor,
          input,
          prepared.contextRevision,
        );
        assert.equal(unknown.status, 503, JSON.stringify(unknown.body));
        assert.equal(
          unknown.body.error?.code,
          kind === 'phone'
            ? 'VERIFICATION_UNAVAILABLE'
            : 'CONTENT_REVIEW_UNAVAILABLE',
        );
        await noArtifacts(input.clientRequestId, actor);
        assert.equal(
          (await recover(input.clientRequestId, actor)).body.error?.code,
          'REQUEST_NOT_FOUND',
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_edit_preparations WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, input.clientRequestId],
            )
          ).rowCount,
          1,
        );
        if (kind === 'phone') await f.certify(actor.accountId);
        else {
          // The synthetic issuer truncates evaluated_at to milliseconds. Make
          // the replacement strictly later, independent of random UUID ordering.
          await f.pool.query('SELECT pg_sleep(0.002)');
          await f.approveEdit(actor, input);
        }
        success(
          await f.commitEdit(actor, input, prepared.contextRevision),
          'applied',
        );
      }
    },
  );

  await t.test(
    'explicit new Review reject or revocation makes only a durable CONTENT_REJECTED closure',
    async () => {
      const target = targets[8]!;
      for (const revoked of [false, true]) {
        const current = await f.editContext(owner, target.id),
          input = f.editIntent(current, {
            description: 'Rejected exact next definition',
          }),
          prepared = await f.prepareEdit(owner, input);
        const decision = await f.approveEdit(
          owner,
          input,
          revoked ? {} : { result: 'reject' },
        );
        if (revoked)
          await setRatingReviewState(f.pool, decision.decisionId, 'revoked');
        const before = await versionState(target.id);
        const denied = await f.commitEdit(
          owner,
          input,
          prepared.contextRevision,
        );
        rejected(denied, input.clientRequestId, 'CONTENT_REJECTED');
        assert.deepEqual(
          (await recover(input.clientRequestId)).body,
          denied.body,
        );
        assert.deepEqual(await versionState(target.id), before);
      }
    },
  );

  await t.test(
    'canonical regional editing uses ordinary affiliation equally with no grant and every administrator grant',
    async () => {
      for (const role of [
        null,
        'super_admin',
        'developer',
        'school_admin',
      ] as const) {
        const actor = await f.actor();
        if (role)
          await f.grant(
            actor,
            role,
            role === 'school_admin' ? f.scope.foreign.regionId : null,
          );
        const regional = await f.catalog(actor, {
          regionId: f.scope.home.regionId,
        });
        const target = regional.targets[0]!,
          current = await f.editContext(actor, target.id);
        assert.equal(current.regionId, f.scope.home.regionId);
        await f.certify(actor.accountId, {
          affiliation: 'unverified',
          identity: false,
        });
        assert.equal(
          (await context(target.id, actor)).body.error?.code,
          'AFFILIATION_VERIFICATION_REQUIRED',
        );
        const input = f.editIntent(current, {
          name: 'Grant cannot substitute affiliation',
        });
        rejected(
          await post('prepare', input, actor),
          input.clientRequestId,
          'AFFILIATION_VERIFICATION_REQUIRED',
        );
        await f.certify(actor.accountId);
        assert.equal((await f.editContext(actor, target.id)).contentVersion, 1);
        const edited = await f.edit(actor, target.id, {
          name: `Ordinary regional ${role ?? 'creator'}`,
        });
        assert.equal(edited.receipt.contentVersion, 2);
      }
    },
  );

  await t.test(
    'global target keeps canonical global scope even when also visible in a regional catalog',
    async () => {
      const actor = await f.actor(),
        global = await f.catalog(actor),
        target = global.targets[0]!;
      const regional = await f.catalog(actor, {
        regionId: f.scope.home.regionId,
        count: 0,
        categoryIds: global.categoryIds,
        sharedTargets: [{ id: target.id, categoryId: global.categoryId }],
      });
      const current = await f.editContext(actor, target.id);
      assert.equal(current.regionId, null);
      assert.equal(current.catalogRevision, global.catalogId);
      const wrongScope = f.editIntent(current, {
        regionId: f.scope.home.regionId,
        expectedCategoryRevision: regional.categoryRevision,
        expectedCatalogRevision: regional.catalogId,
        name: 'Cannot move canonical scope',
      });
      rejected(
        await post('prepare', wrongScope, actor),
        wrongScope.clientRequestId,
        'RATING_EDIT_CONTEXT_CHANGED',
      );
      await f.certify(actor.accountId, {
        affiliation: 'unverified',
        identity: false,
      });
      const edited = await f.edit(actor, target.id, {
        name: 'Still globally scoped',
      });
      assert.equal(edited.receipt.contentVersion, 2);
      assert.equal((await f.editContext(actor, target.id)).regionId, null);
      await f.catalog(actor, { count: 0 });
      assert.equal(
        (await context(target.id, actor)).body.error?.code,
        'RATING_NOT_FOUND',
      );
      const viewer = await f.actor();
      const visibleRegionally = await f
        .auth(request(f.http).get(`/v1/ratings/targets/${target.id}`), viewer)
        .query({ regionId: f.scope.home.regionId });
      assert.equal(
        visibleRegionally.status,
        200,
        JSON.stringify(visibleRegionally.body),
      );
      assert.equal(visibleRegionally.body.name, 'Still globally scoped');
    },
  );

  await t.test(
    'a non-general current category cannot gain editing through a valid old target Review',
    async () => {
      const actor = await f.actor(),
        original = await f.catalog(actor),
        target = original.targets[0]!;
      const current = await f.editContext(actor, target.id),
        next = randomUUID();
      await withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          "INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,NULL,'complete','accepted','synthetic-non-general-catalog','synthetic-non-general-policy',clock_timestamp())",
          [next],
        );
        await tx.query(
          "INSERT INTO whaleu_ratings.categories(catalog_id,id,revision,parent_id,level,origin_kind,kind,system_key,name,description,active,hidden,ordinal) SELECT $1,id,revision,parent_id,level,origin_kind,'course',system_key,name,description,active,hidden,ordinal FROM whaleu_ratings.categories WHERE catalog_id=$2",
          [next, original.catalogId],
        );
        await tx.query(
          'INSERT INTO whaleu_ratings.target_memberships(catalog_id,target_id,category_id,ordinal) VALUES($1,$2,$3,0)',
          [next, target.id, original.categoryId],
        );
        await tx.query(
          'UPDATE whaleu_ratings.catalogs SET sealed=true WHERE id=$1',
          [next],
        );
        await tx.query(
          "UPDATE whaleu_ratings.catalog_heads SET catalog_id=$1 WHERE scope_key='global'",
          [next],
        );
      });
      assert.equal(
        (await context(target.id, actor)).body.error?.code,
        'RATING_NOT_FOUND',
      );
      const input = f.editIntent(current, {
        expectedCatalogRevision: next,
        name: 'Unsupported course editing',
      });
      rejected(
        await post('prepare', input, actor),
        input.clientRequestId,
        'RATING_NOT_FOUND',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT content_version FROM whaleu_ratings.target_definition_heads WHERE target_id=$1',
            [target.id],
          )
        ).rows[0]!.content_version,
        1,
      );
    },
  );
});
