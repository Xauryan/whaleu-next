import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import {
  ratingScopedCommandFixture,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import {
  ratingScopedIntentSchema,
  type RatingScopedIntent,
} from '../../src/ratings/scoped/contracts.js';
import { ratingScopedCommandHash } from '../../src/ratings/scoped/protocol-registry.js';
import { ratingIso } from '../../src/ratings/repository.js';

// Hostile SQL deliberately uses real tables with ALL constraints enabled. A
// syntax error, missing function/table, or infrastructure error is never a pass.
test(
  'M3B raw SQL requires exact scoped request/outcome/domain/Review causes in both directions',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingScopedCommandFixture();
    t.after(() => f.close());
    const actor = f.creator,
      other = await f.actor();
    const target = await f.createScopedTarget(actor);
    const base = {
      targetId: target.id,
      expectedTargetRevision: target.revision,
    };
    const rootCommand = await f.executeCommand(
      actor,
      await f.commandIntent(actor, 'create_comment_scoped', {
        ...base,
        authorMode: 'named',
        body: 'Causality root',
        assetIds: [],
      }),
    );
    const rootReceipt = scopedSuccess(rootCommand.receipt);
    const root = {
      id: String(rootReceipt.result['subjectId']),
      revision: String(rootReceipt.result['revision']),
    };
    const replyCommand = await f.executeCommand(
      actor,
      await f.commandIntent(actor, 'create_reply_scoped', {
        ...base,
        rootId: root.id,
        expectedRootRevision: root.revision,
        replyTo: null,
        authorMode: 'named',
        body: 'Causality reply',
        assetIds: [],
      }),
    );
    const replyReceipt = scopedSuccess(replyCommand.receipt);
    const reply = {
      id: String(replyReceipt.result['replyId']),
      revision: String(replyReceipt.result['revision']),
    };
    const snapshot = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'requests',(SELECT count(*) FROM whaleu_ratings.requests),
    'claims',(SELECT count(*) FROM whaleu_ratings.command_claims),
    'causes',(SELECT count(*) FROM whaleu_ratings.scoped_command_causes),
    'outcomes',(SELECT count(*) FROM whaleu_ratings.scoped_command_outcomes),
    'scores',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY target_id,account_id),'[]') FROM whaleu_ratings.scores s),
    'summaries',(SELECT jsonb_agg(to_jsonb(s) ORDER BY target_id) FROM whaleu_ratings.score_summaries s),
    'bindings',(SELECT count(*) FROM whaleu_community.rating_scoped_content_bindings),
    'definitions',(SELECT count(*) FROM whaleu_ratings.target_definition_versions),
    'sourceEpoch',(SELECT epoch FROM whaleu_ratings.scoped_source_epoch WHERE singleton),
    'randomEpoch',(SELECT epoch FROM whaleu_ratings.random_pool_epoch WHERE singleton),
    'reviewEpoch',(SELECT epoch FROM whaleu_community.rating_review_binding_epoch WHERE singleton)) state`)
      ).rows[0]!.state;
    const reject = async (
      label: string,
      work: (tx: PoolClient) => Promise<unknown>,
    ) => {
      const before = await snapshot();
      await assert.rejects(
        withCommunityScopeWriter(f.pool, async (tx) => {
          await work(tx);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        }),
        (error: unknown) =>
          !!error &&
          typeof error === 'object' &&
          'code' in error &&
          ['23514', '23503', '23505'].includes(String(error.code)),
        label,
      );
      assert.deepEqual(
        await snapshot(),
        before,
        `${label}: all artifacts and writer epochs roll back`,
      );
    };
    const newRequest = (
      tx: PoolClient,
      input: RatingScopedIntent,
      accountId = actor.accountId,
    ) =>
      tx.query(
        'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
        [
          accountId,
          input.payload.clientRequestId,
          input.operation,
          ratingScopedCommandHash(input),
        ],
      );
    const execution = (
      tx: PoolClient,
      input: RatingScopedIntent,
      extra: Record<string, unknown> = {},
    ) =>
      tx.query(
        `
    INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof)
    SELECT account_id,request_id,'execution',context_id,target_revision,
      jsonb_build_object('intentHash',intent_hash,'operation',operation,'contextId',context_id,'contextRevision',context_revision)||$3::jsonb
    FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2`,
        [actor.accountId, input.payload.clientRequestId, canonicalJson(extra)],
      );
    const outcome = async (
      tx: PoolClient,
      input: RatingScopedIntent,
      kind: 'applied' | 'noop' | 'closed',
      value: unknown,
    ) => {
      const hash = ratingScopedCommandHash(input);
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_command_outcomes(account_id,request_id,operation,intent_hash,intent,outcome,result,code)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,
        [
          actor.accountId,
          input.payload.clientRequestId,
          input.operation,
          hash,
          canonicalJson(input),
          kind,
          kind === 'closed' ? null : canonicalJson(value),
          kind === 'closed' ? value : null,
        ],
      );
      await tx.query(
        'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
        [
          actor.accountId,
          input.payload.clientRequestId,
          canonicalJson({
            protocolVersion: 2,
            requestId: input.payload.clientRequestId,
            operation: input.operation,
            intentHash: hash,
            outcome: kind,
            ...(kind === 'closed' ? { code: value } : { result: value }),
          }),
        ],
      );
    };
    const commentBinding = async (
      tx: PoolClient,
      review: Awaited<ReturnType<typeof f.approveCommand>>,
      changed: unknown = review.envelope,
    ) => {
      const envelope = changed as Record<string, unknown>;
      await tx.query(
        `INSERT INTO whaleu_community.rating_scoped_content_bindings
      (kind,subject_id,subject_revision,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
      VALUES($1,$2,$3,1,$4,$5,$6,5,$7,$8::jsonb,$9::jsonb)`,
        [
          review.envelope.purpose === 'publish_rating_reply_scoped'
            ? 'reply'
            : 'comment',
          envelope['subjectId'],
          envelope['subjectRevision'],
          review.decisionId,
          actor.accountId,
          review.envelope.purpose,
          review.digest,
          canonicalJson(changed),
          canonicalJson(envelope['scope']),
        ],
      );
    };
    const definitionBinding = (
      tx: PoolClient,
      review: Awaited<ReturnType<typeof f.approveCommand>>,
      changed: unknown = review.envelope,
    ) => {
      const e = changed as Record<string, unknown>;
      return tx.query(
        `INSERT INTO whaleu_community.rating_scoped_target_definition_bindings
      (target_id,content_version,definition_revision,applied_target_revision,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
      VALUES($1,$2,$3,$4,$5,$6,$7,5,$8,$9::jsonb,$10::jsonb)`,
        [
          e['targetId'],
          e['contentVersion'],
          e['definitionRevision'],
          e['targetRevision'],
          review.decisionId,
          actor.accountId,
          review.envelope.purpose,
          review.digest,
          canonicalJson(changed),
          canonicalJson(e['scope']),
        ],
      );
    };
    const operations = async () => {
      const like = await f.scopedRead(
        actor,
        `/v2/ratings/comments/${root.id}/like`,
      );
      const replyLike = await f.scopedRead(
        actor,
        `/v2/ratings/replies/${reply.id}/like`,
      );
      const subscription = await f.scopedRead(
        actor,
        `/v2/ratings/targets/${target.id}/subscription`,
      );
      return [
        await f.commandIntent(actor, 'set_score_scoped', {
          ...base,
          expectedRevision: null,
          score: 4,
        }),
        await f.commandIntent(actor, 'create_comment_scoped', {
          ...base,
          authorMode: 'named',
          body: 'Exact comment',
          assetIds: [],
        }),
        await f.commandIntent(actor, 'create_reply_scoped', {
          ...base,
          rootId: root.id,
          expectedRootRevision: root.revision,
          replyTo: { replyId: reply.id, expectedRevision: reply.revision },
          authorMode: 'named',
          body: 'Exact reply',
          assetIds: [],
        }),
        await f.commandIntent(actor, 'set_comment_like_scoped', {
          ...base,
          rootId: root.id,
          expectedRevision: root.revision,
          expectedLikeRevision: like.revision,
          liked: true,
        }),
        await f.commandIntent(actor, 'set_reply_like_scoped', {
          ...base,
          rootId: root.id,
          replyId: reply.id,
          expectedRootRevision: root.revision,
          expectedRevision: reply.revision,
          expectedLikeRevision: replyLike.revision,
          liked: true,
        }),
        await f.commandIntent(actor, 'set_target_subscription_scoped', {
          ...base,
          expectedSubscriptionRevision: subscription.revision,
          subscribed: true,
        }),
        await f.commandIntent(actor, 'create_target_scoped', {
          name: 'Never partially created',
          description: '',
          assetIds: [],
        }),
        await f.scopedEditIntent(actor, target.id, {
          name: 'Never partially edited',
        }),
      ];
    };
    const inputs = await operations();
    for (const input of inputs) {
      await f.prepareCommand(actor, input);
      await t.test(
        `${input.operation}: orphan request, outcome and execution cannot commit`,
        async () => {
          await reject('request without immutable outcome', (tx) =>
            newRequest(tx, input),
          );
          await reject('outcome without request', (tx) =>
            outcome(tx, input, 'closed', 'RATING_NOT_FOUND'),
          );
          await reject('execution without outcome', async (tx) => {
            await newRequest(tx, input);
            await execution(tx, input);
          });
          await reject('samehash is not an execution proof', async (tx) => {
            await newRequest(tx, input);
            await execution(tx, input, { extra: true });
          });
          await reject(
            'a closed receipt cannot hide a typed execution',
            async (tx) => {
              await newRequest(tx, input);
              await execution(tx, input);
              await outcome(tx, input, 'closed', 'RATING_NOT_FOUND');
            },
          );
          await reject(
            'invented applied receipt without actual business mutation',
            async (tx) => {
              await newRequest(tx, input);
              await execution(tx, input);
              await outcome(tx, input, 'applied', {
                targetId: target.id,
                revision: target.revision,
                occurredAt: new Date().toISOString(),
              });
            },
          );
        },
      );
    }

    await t.test(
      'raw score update cannot substitute different desired state, CAS, outcome or a second cause',
      async () => {
        const input = inputs[0]!;
        for (const attack of [
          'no-execution',
          'no-outcome',
          'wrong-desired',
          'wrong-result',
          'extra-cause',
          'closed-with-score',
        ] as const)
          await reject(attack, async (tx) => {
            await newRequest(tx, input);
            if (attack !== 'no-execution') await execution(tx, input);
            const revision = randomUUID();
            const score = attack === 'wrong-desired' ? 2 : 4;
            const row = (
              await tx.query<{ occurred_at: string }>(
                `INSERT INTO whaleu_ratings.scores(target_id,account_id,score,revision,request_id)
          VALUES($1,$2,$3,$4,$5) RETURNING ${ratingIso('updated_at')} occurred_at`,
                [
                  target.id,
                  actor.accountId,
                  score,
                  revision,
                  input.payload.clientRequestId,
                ],
              )
            ).rows[0]!;
            if (attack === 'no-outcome') return;
            if (attack === 'extra-cause')
              await tx.query(
                `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof)
          VALUES($1,$2,'domain_transition',$3,$4,'{}')`,
                [
                  actor.accountId,
                  input.payload.clientRequestId,
                  randomUUID(),
                  revision,
                ],
              );
            if (attack === 'closed-with-score')
              await outcome(tx, input, 'closed', 'RATING_REVISION_CONFLICT');
            else
              await outcome(tx, input, 'applied', {
                targetId: target.id,
                subjectId: target.id,
                revision: attack === 'wrong-result' ? randomUUID() : revision,
                occurredAt: row.occurred_at,
              });
          });
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.scores WHERE target_id=$1 AND account_id=$2',
              [target.id, actor.accountId],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      'accepted Review samekey/samehash cannot substitute body, mode, ancestor, placement or definition version',
      async () => {
        for (const input of inputs.filter((i) =>
          [
            'create_comment_scoped',
            'create_reply_scoped',
            'create_target_scoped',
            'edit_target_scoped',
          ].includes(i.operation),
        )) {
          const accepted = await f.approveCommand(actor, input);
          const original = accepted.envelope as unknown as Record<
            string,
            unknown
          >;
          const changes: Array<[string, Record<string, unknown>]> = [
            [
              'missing-required-field',
              Object.fromEntries(
                Object.entries(original).filter(([key]) => key !== 'assetIds'),
              ),
            ],
            ['extra-field', { ...original, unreviewed: true }],
            ['wrong-version', { ...original, version: 4 }],
            ['other-actor', { ...original, accountId: other.accountId }],
            [
              'other-placement',
              {
                ...original,
                scope: {
                  ...(original['scope'] as object),
                  selector: { kind: 'campus', campusId: f.campusB },
                },
              },
            ],
            [
              'other-origin',
              {
                ...original,
                targetOrigin: {
                  regionId: f.regionId,
                  originCampusId: f.campusB,
                },
              },
            ],
          ];
          if ('body' in original)
            changes.push(
              [
                'different-body',
                { ...original, body: 'Unreviewed replacement body' },
              ],
              [
                'different-author-mode',
                { ...original, authorMode: 'anonymous' },
              ],
              [
                'different-target-definition',
                { ...original, targetDefinitionRevision: randomUUID() },
              ],
              [
                'different-content-version',
                { ...original, targetContentVersion: 2 },
              ],
            );
          else
            changes.push(
              [
                'different-name',
                { ...original, name: 'Unreviewed replacement definition' },
              ],
              [
                'different-definition',
                { ...original, definitionRevision: randomUUID() },
              ],
              ['different-content-version', { ...original, contentVersion: 2 }],
            );
          if ('rootId' in original)
            changes.push(
              ['different-root', { ...original, rootId: randomUUID() }],
              [
                'different-root-revision',
                { ...original, rootRevision: randomUUID() },
              ],
              [
                'different-parent',
                {
                  ...original,
                  replyTo: { replyId: randomUUID(), revision: reply.revision },
                },
              ],
            );
          for (const [label, changed] of changes)
            await reject(
              `${input.operation} ${label} retains approved digest and request key`,
              (tx) =>
                'body' in original
                  ? commentBinding(tx, accepted, changed)
                  : definitionBinding(tx, accepted, changed),
            );
          await reject(
            `${input.operation} exact binding alone requires reverse business artifact`,
            (tx) =>
              'body' in original
                ? commentBinding(tx, accepted)
                : definitionBinding(tx, accepted),
          );
        }
      },
    );

    await t.test(
      'raw content with exact preparation/execution but missing Review cannot commit, nor can mismatched body reuse accepted Review',
      async () => {
        const input = inputs.find(
          (i) => i.operation === 'create_comment_scoped',
        )!;
        const preparation = (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, input.payload.clientRequestId],
          )
        ).rows[0]!;
        for (const changed of [false, true])
          await reject(
            changed
              ? 'raw mismatched body'
              : 'raw missing binding/effects/outcome',
            async (tx) => {
              await newRequest(tx, input);
              await execution(tx, input);
              await tx.query(
                `INSERT INTO whaleu_ratings.comments(id,target_id,account_id,author_mode,body,revision,request_id,envelope)
        VALUES($1,$2,$3,'named',$4,$5,$6,$7::jsonb)`,
                [
                  preparation.subject_id,
                  target.id,
                  actor.accountId,
                  changed
                    ? 'Same key but replaced body'
                    : preparation.envelope.body,
                  preparation.subject_revision,
                  input.payload.clientRequestId,
                  canonicalJson(preparation.envelope),
                ],
              );
            },
          );
      },
    );

    await t.test(
      'SQL and HTTP both enforce exact field sets and typed v2 purpose/context',
      async () => {
        const input = inputs[0]!;
        const malformed = [
          { ...input, protocolVersion: 1 },
          { ...input, extra: true },
          { ...input, context: { ...input.context, mode: 'admin_preview' } },
          { ...input, payload: { ...input.payload, extra: true } },
          {
            ...input,
            payload: Object.fromEntries(
              Object.entries(input.payload).filter(
                ([key]) => key !== 'expectedRevision',
              ),
            ),
          },
        ];
        for (const value of malformed) {
          assert.equal(
            ratingScopedIntentSchema.safeParse(value).success,
            false,
          );
          const sql = await f.pool.query<{ valid: boolean }>(
            'SELECT whaleu_ratings.scoped_intent_valid($1::jsonb) valid',
            [canonicalJson(value)],
          );
          assert.equal(sql.rows[0]!.valid, false);
          const response = await f
            .auth(
              request(f.http).put(`/v2/ratings/targets/${target.id}/my-score`),
              actor,
            )
            .send(value);
          assert.equal(response.status, 400, JSON.stringify(response.body));
        }
        const current = await f.scopedContext(
          actor,
          { kind: 'global' },
          'read',
        );
        const forged = ratingScopedIntentSchema.parse({
          ...input,
          context: {
            ...input.context,
            id: current.id,
            token: current.token,
            tokenDigest: current.tokenDigest,
          },
          payload: { ...input.payload, clientRequestId: randomUUID() },
        });
        const response = await f.sendCommand(actor, forged);
        assert.equal(
          response.body.outcome,
          'closed',
          JSON.stringify(response.body),
        );
        assert.equal(response.body.code, 'RATING_SCOPED_CONTEXT_CHANGED');
        const digest = await f.pool.query<{ digest: string }>(
          'SELECT whaleu_ratings.scoped_intent_hash($1::jsonb) digest',
          [canonicalJson(input)],
        );
        assert.equal(digest.rows[0]!.digest, ratingScopedCommandHash(input));
      },
    );

    await t.test(
      'all v1–v8 command families and v9 share one bidirectional namespace even with the same hash',
      async () => {
        const oldOperations = [
          'set_score',
          'create_reply',
          'set_target_subscription',
          'admin_delete_comment',
          'create_target',
          'delete_target',
          'edit_target',
          'create_categories',
        ];
        for (const operation of oldOperations) {
          const input = ratingScopedIntentSchema.parse({
            ...inputs[0]!,
            payload: { ...inputs[0]!.payload, clientRequestId: randomUUID() },
          });
          const digest = ratingScopedCommandHash(input);
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'INSERT INTO whaleu_ratings.command_claims(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
              [
                actor.accountId,
                input.payload.clientRequestId,
                operation,
                digest,
              ],
            ),
          );
          const collision = await f.sendCommand(actor, input);
          assert.equal(
            collision.body.error.code,
            'REQUEST_CONFLICT',
            JSON.stringify(collision.body),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
                [actor.accountId, input.payload.clientRequestId],
              )
            ).rowCount,
            0,
          );
          await reject(
            `scoped reservation blocks old ${operation} with equal hash`,
            (tx) =>
              tx.query(
                'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
                [
                  actor.accountId,
                  inputs[0]!.payload.clientRequestId,
                  operation,
                  ratingScopedCommandHash(inputs[0]!),
                ],
              ),
          );
        }
        // The same key with altered bytes is a conflict even within one operation.
        const replaced = ratingScopedIntentSchema.parse({
          ...inputs[0]!,
          payload: { ...inputs[0]!.payload, score: 3 },
        });
        assert.notEqual(
          ratingScopedCommandHash(replaced),
          ratingScopedCommandHash(inputs[0]!),
        );
        const collision = await f.sendCommand(actor, replaced);
        assert.equal(collision.body.error.code, 'REQUEST_CONFLICT');
      },
    );

    await t.test(
      'history, binding and preparation tables resist mutation and retain deferred reverse guards',
      async () => {
        for (const table of [
          'scoped_contexts',
          'scoped_command_preparations',
          'scoped_command_outcomes',
          'scoped_command_causes',
        ]) {
          const triggers = (
            await f.pool.query(
              `SELECT t.tgname,c.condeferrable,c.condeferred FROM pg_trigger t
        LEFT JOIN pg_constraint c ON c.oid=t.tgconstraint WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal`,
              [`whaleu_ratings.${table}`],
            )
          ).rows;
          assert.ok(
            triggers.some((row) => row.tgname === 'scoped_retain'),
            table,
          );
          if (table !== 'scoped_contexts')
            assert.ok(
              triggers.some((row) => row.condeferrable && row.condeferred),
              table,
            );
          await reject(`retain ${table}`, (tx) =>
            tx.query(`TRUNCATE whaleu_ratings.${table} CASCADE`),
          );
        }
        await reject('immutable content binding', (tx) =>
          tx.query(
            'UPDATE whaleu_community.rating_scoped_content_bindings SET envelope=envelope WHERE subject_id=$1',
            [root.id],
          ),
        );
        await reject('immutable scoped preparation', (tx) =>
          tx.query(
            'DELETE FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, inputs[0]!.payload.clientRequestId],
          ),
        );
        // Intentionally untouched: legacy envelope/command hash implementations and
        // their pre-existing golden tests remain the source of fixed v1–v8 bytes.
        assert.equal(
          canonicalRatingScopedEnvelope(rootCommand.approved!.envelope).version,
          5,
        );
      },
    );
  },
);
