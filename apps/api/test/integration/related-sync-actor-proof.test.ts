import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { ApprovalRepository } from '../../src/community/content-review/approval.repository.js';
import {
  approvalDigest,
  canonicalEnvelope,
} from '../../src/community/content-review/contracts.js';
import type {
  AcceptedApproval,
  EffectiveContentEnvelope,
} from '../../src/community/content-review/contracts.js';
import { publicationHash } from '../../src/community/publication.repository.js';
import { replyIntent } from '../../src/community/discussion/publication.service.js';
import { relatedSyncRuntimeFixture } from '../support/related-sync-fixtures.js';
import {
  setRegionPolicy,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';

const violation = (message: RegExp) => (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  error.code === '23514' &&
  message.test(error.message);

test(
  'raw v4 bindings retain own actor authority and exact child intent through finalization',
  { timeout: 240000 },
  async (t) => {
    const f = await relatedSyncRuntimeFixture();
    try {
      await setRegionPolicy(f.pool, f.scope.home.regionId, {
        relatedSyncEnabled: true,
        unverifiedCommentEnabled: true,
      });
      const author = await f.actor(),
        commenter = await f.actor({ campusId: f.scope.related.campusId });
      type Actor = typeof author;
      const send = (path: string, actor: Actor, body: object) =>
        request(f.app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send(body);
      const stored = async (kind: string, id: string) =>
        (
          await f.pool.query<{
            envelope: EffectiveContentEnvelope;
            related_actor_fingerprint: string;
            related_actor_transaction: string;
          }>(
            'SELECT envelope,related_actor_fingerprint,related_actor_transaction::text FROM whaleu_community.content_approval_bindings WHERE content_kind=$1 AND content_id=$2',
            [kind, id],
          )
        ).rows[0]!;
      const root = async (authorMode: 'named' | 'anonymous') => {
        const input = {
          clientRequestId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          category: 'discussion',
          text: `Synthetic ${authorMode} actor-proof root`,
          authorMode,
          commentsPolicy: 'open',
          imageAssetIds: [],
          syncToRelatedCampuses: true,
        };
        const queued = await send('/v1/community/reviews/posts', author, input);
        assert.equal(queued.status, 200, JSON.stringify(queued.body));
        await f.decide(author.accountId, input.clientRequestId);
        const result = await send('/v1/community/posts', author, input);
        assert.equal(
          result.body.outcome,
          'created',
          JSON.stringify(result.body),
        );
        return {
          id: result.body.resourceId as string,
          input,
          receipt: result.body,
          ...(await stored('post', result.body.resourceId)),
        };
      };
      const named = await root('named'),
        anonymous = await root('anonymous');
      const queueChild = async (
        actor: Actor,
        postId = named.id,
        authorMode: 'named' | 'anonymous' = 'named',
      ) => {
        const input = {
          clientRequestId: randomUUID(),
          text: `Synthetic exact child ${randomUUID()}`,
          authorMode,
          imageAssetIds: [] as string[],
        };
        const queued = await send(
          `/v1/community/reviews/posts/${postId}/comments`,
          actor,
          input,
        );
        assert.equal(queued.status, 200, JSON.stringify(queued.body));
        await f.decide(actor.accountId, input.clientRequestId);
        const row = (
          await f.pool.query<{
            envelope: EffectiveContentEnvelope;
            decision_id: string;
            digest: string;
          }>(
            'SELECT envelope,decision_id,digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, input.clientRequestId],
          )
        ).rows[0]!;
        const approval: AcceptedApproval = {
          decisionId: row.decision_id,
          digest: row.digest,
          version: row.envelope.version,
          envelope: row.envelope,
        };
        return { actor, input, postId, approval };
      };
      const rawDecision = async (
        tx: PoolClient,
        envelope: EffectiveContentEnvelope,
      ): Promise<AcceptedApproval> => {
        const decisionId = randomUUID(),
          eventId = randomUUID(),
          digest = approvalDigest(envelope);
        await tx.query(
          `INSERT INTO whaleu_community.content_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model)
        VALUES($1,$2,$3,4,$4,$5::jsonb,$6,'allow','complete','accepted','synthetic:raw-actor-proof','Explicit disposable adversarial Review',clock_timestamp(),clock_timestamp()+interval '1 hour','durable')`,
          [
            decisionId,
            envelope.accountId,
            envelope.purpose,
            digest,
            JSON.stringify(envelope),
            f.relatedReviewPolicyId,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','complete','accepted','synthetic:raw-actor-proof','Explicit disposable adversarial Review',clock_timestamp())`,
          [eventId, decisionId],
        );
        await tx.query(
          'INSERT INTO whaleu_community.content_approval_heads(decision_id,event_id) VALUES($1,$2)',
          [decisionId, eventId],
        );
        return { decisionId, digest, version: 4, envelope };
      };
      const insertNode = async (
        tx: PoolClient,
        envelope: EffectiveContentEnvelope,
      ) => {
        const id = randomUUID();
        if (envelope.purpose === 'publish_post')
          await tx.query(
            `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,publication_envelope_version,allow_anonymous_dm) VALUES($1,$2,$3,$4,$5,$6,$7,4,$8)`,
            [
              id,
              envelope.spaceId,
              envelope.accountId,
              envelope.category,
              envelope.text,
              envelope.authorMode,
              envelope.commentsPolicy,
              envelope.version === 4 ? envelope.allowAnonymousDm : null,
            ],
          );
        else
          await tx.query(
            'INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,$5)',
            [
              id,
              envelope.postId,
              envelope.accountId,
              envelope.text,
              envelope.authorMode,
            ],
          );
        return id;
      };
      const rejectOwnActor = async (envelope: EffectiveContentEnvelope) => {
        let reachedBinding = false;
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            assert.equal(
              (
                await tx.query(
                  'SELECT whaleu_community.related_sync_actor_current($1::jsonb) AS allowed',
                  [JSON.stringify(envelope)],
                )
              ).rows[0].allowed,
              false,
            );
            const accepted = await rawDecision(tx, envelope),
              id = await insertNode(tx, envelope);
            reachedBinding = true;
            await f.app
              .get(ApprovalRepository)
              .bind(
                accepted,
                envelope.purpose === 'publish_post' ? 'post' : 'comment',
                id,
                tx,
              );
          }),
          violation(/Current own related actor authority required/),
        );
        assert.equal(reachedBinding, true);
      };
      const completeRawChild = async (
        tx: PoolClient,
        pending: Awaited<ReturnType<typeof queueChild>>,
        forgedHash?: string,
      ) => {
        const { envelope } = pending.approval;
        const requestId =
          forgedHash === undefined
            ? pending.input.clientRequestId
            : randomUUID();
        if (forgedHash !== undefined)
          await tx.query(
            "INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation) VALUES($1,$2,$3,'publish_comment')",
            [envelope.accountId, requestId, forgedHash],
          );
        const id = await insertNode(tx, envelope);
        await f.app
          .get(ApprovalRepository)
          .bind(pending.approval, 'comment', id, tx);
        const receipt = {
          requestId,
          operation: 'publish_comment',
          outcome: 'created',
          resourceId: id,
          createdAt: new Date().toISOString(),
        };
        await tx.query(
          "INSERT INTO whaleu_community.report_origins(kind,target_id,owner_account_id,provenance,source_request_id) VALUES('comment',$1,$2,'native_publication',$3)",
          [id, envelope.accountId, requestId],
        );
        await tx.query(
          'UPDATE whaleu_community.publication_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
          [envelope.accountId, requestId, JSON.stringify(receipt)],
        );
        return id;
      };

      await t.test(
        'root restricted comments require direct-original or global control; related-only grants do not grant it',
        async () => {
          const envelope = canonicalEnvelope({
            ...named.envelope,
            text: 'Synthetic restricted root without grant',
            commentsPolicy: 'restricted',
          });
          await rejectOwnActor(envelope);
          const grant = async (region: string | null, role: string) =>
            withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic-actor-proof') RETURNING id",
                [randomUUID(), author.accountId, role, region],
              ),
            );
          const remote = (await grant(f.scope.related.regionId, 'school_admin'))
            .rows[0]!.id;
          await rejectOwnActor(envelope);
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
              [remote],
            ),
          );
          for (const [region, role] of [
            [f.scope.home.regionId, 'school_admin'],
            [null, 'developer'],
          ] as const) {
            const id = (await grant(region, role)).rows[0]!.id;
            assert.equal(
              (
                await f.pool.query(
                  'SELECT whaleu_community.related_sync_actor_current($1::jsonb) AS allowed',
                  [JSON.stringify(envelope)],
                )
              ).rows[0].allowed,
              true,
            );
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
                [id],
              ),
            );
          }
        },
      );

      await t.test(
        'a child retains its own current scope; known unverified may publish named while unavailable cannot borrow it',
        async () => {
          const pending = await queueChild(commenter);
          assert.equal(
            pending.approval.envelope.scope.identityRegionId,
            f.scope.related.regionId,
          );
          const forged = canonicalEnvelope(
            JSON.parse(
              JSON.stringify({
                ...pending.approval.envelope,
                scope: {
                  ...named.envelope.scope,
                  sync: 'inherited_related',
                  configurationRevisionId: null,
                  syncPolicyId: undefined,
                  publicationGroupId: undefined,
                  publicationMembersDigest: undefined,
                  parentDistribution:
                    pending.approval.envelope.scope.sync === 'inherited_related'
                      ? pending.approval.envelope.scope.parentDistribution
                      : undefined,
                },
              }),
            ),
          );
          await rejectOwnActor(forged);
          const unverified = await f.actor({
            affiliation: 'unverified',
            identity: false,
          });
          const allowed = await queueChild(unverified);
          assert.equal(allowed.approval.envelope.scope.identityRegionId, null);
          assert.equal(
            allowed.approval.envelope.scope.affiliationAssertionId,
            null,
          );
          assert.ok(allowed.approval.envelope.scope.configurationRevisionId);
          const created = await send(
            `/v1/community/posts/${named.id}/comments`,
            unverified,
            allowed.input,
          );
          assert.equal(
            created.body.outcome,
            'created',
            JSON.stringify(created.body),
          );
          const unavailable = await f.actor({
            affiliation: 'unavailable',
            identity: false,
          });
          await rejectOwnActor(
            canonicalEnvelope({
              ...allowed.approval.envelope,
              accountId: unavailable.accountId,
              text: 'Unavailable affiliation cannot copy known unverified scope',
            }),
          );
        },
      );

      await t.test(
        'client-supplied actor proof is rejected and the new owner generation rejects all direct statements',
        async () => {
          const pending = await queueChild(commenter);
          for (const proof of ['fingerprint', 'transaction'] as const)
            await assert.rejects(
              withCommunityScopeWriter(f.pool, async (tx) => {
                const id = await insertNode(tx, pending.approval.envelope);
                await tx.query(
                  `INSERT INTO whaleu_community.content_approval_bindings(content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope,${proof === 'fingerprint' ? 'related_actor_fingerprint' : 'related_actor_transaction'})
          VALUES('comment',$1,1,$2,$3,'publish_comment',4,$4,$5::jsonb,$6::jsonb,${proof === 'fingerprint' ? "repeat('a',64)" : 'pg_current_xact_id()'})`,
                  [
                    id,
                    pending.approval.decisionId,
                    commenter.accountId,
                    pending.approval.digest,
                    JSON.stringify(pending.approval.envelope),
                    JSON.stringify(pending.approval.envelope.scope),
                  ],
                );
              }),
              violation(/Related actor proof is owner issued/),
            );
          const table = 'whaleu_community.related_sync_actor_generation';
          for (const sql of [
            `UPDATE ${table} SET generation=0`,
            `UPDATE ${table} SET generation=generation+1`,
            `UPDATE ${table} SET generation=generation WHERE false`,
            `DELETE FROM ${table} WHERE false`,
            `INSERT INTO ${table}(slot,generation) SELECT 0,1 WHERE false`,
            `DELETE FROM ${table}`,
            `TRUNCATE ${table}`,
          ])
            await assert.rejects(
              f.pool.query(sql),
              violation(/generation|immutable|truncate/i),
            );
        },
      );

      await t.test(
        'early constraint flush never launders source zero-row writes or actor ABA',
        async () => {
          const pending = await queueChild(commenter);
          for (const source of [
            'whaleu_verification.account_heads',
            'whaleu_authorization.role_grants',
            'whaleu_community.posts',
            'whaleu_community.content_approval_bindings',
            'whaleu_media.bindings',
          ]) {
            let flushed = false;
            await assert.rejects(
              withCommunityScopeWriter(f.pool, async (tx) => {
                await completeRawChild(tx, pending);
                await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
                flushed = true;
                await tx.query(`DELETE FROM ${source} WHERE false`);
              }),
              violation(/Original related actor publication proof changed/),
            );
            assert.equal(
              flushed,
              true,
              `${source} must fail only after a successful exact child finalization`,
            );
          }
          let restored = false;
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              await completeRawChild(tx, pending);
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              await tx.query('SET CONSTRAINTS ALL DEFERRED');
              await tx.query(
                'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
                [commenter.accountId],
              );
              await tx.query(
                'UPDATE whaleu_safety.account_heads SET actions_allowed=true WHERE account_id=$1',
                [commenter.accountId],
              );
              restored = true;
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            }),
            violation(/Original related actor publication proof changed/),
          );
          assert.equal(restored, true);
        },
      );

      await t.test(
        'a first lazy admission slot after successful early flush still rejects the original actor proof',
        async () => {
          const pending = await queueChild(commenter);
          const capacity = Number(
            (
              await f.pool.query<{ capacity: number }>(
                'SELECT whaleu_community.related_sync_generation_capacity() AS capacity',
              )
            ).rows[0]!.capacity,
          );
          let selected = false,
            flushed = false;
          // The fixture has touched only a small number of admission slots.
          // Advance real read-only transaction IDs to an unused natural slot;
          // never forge metadata or reserve another owner's advisory locks.
          assert.ok(
            (
              await f.pool.query(
                'SELECT slot FROM whaleu_community.related_sync_admission_generation',
              )
            ).rowCount! < capacity,
          );
          for (let attempt = 0; attempt < capacity && !selected; attempt++) {
            try {
              await withCommunityScopeWriter(f.pool, async (tx) => {
                const candidate = (
                  await tx.query<{ slot: number; exists: boolean }>(
                    `SELECT slot,EXISTS(SELECT 1 FROM whaleu_community.related_sync_admission_generation g WHERE g.slot=candidate.slot) AS exists
                   FROM (SELECT mod(pg_current_xact_id()::text::numeric,whaleu_community.related_sync_generation_capacity())::integer AS slot) candidate`,
                  )
                ).rows[0]!;
                if (candidate.exists) return;
                selected = true;
                await completeRawChild(tx, pending);
                await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
                flushed = true;
                assert.equal(
                  (
                    await tx.query(
                      'SELECT slot FROM whaleu_community.related_sync_admission_generation WHERE slot=$1',
                      [candidate.slot],
                    )
                  ).rowCount,
                  0,
                );
                assert.equal(
                  (
                    await tx.query(
                      `SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock' AND classid=1464356122::oid AND objsubid=2`,
                    )
                  ).rowCount,
                  0,
                );
                await tx.query(
                  'DELETE FROM whaleu_verification.account_heads WHERE false',
                );
              });
              assert.equal(
                selected,
                false,
                'The first lazy source INSERT must reject after exact child finalization',
              );
            } catch (error) {
              assert.equal(selected, true);
              assert.equal(flushed, true);
              assert.ok(
                violation(/Original related actor publication proof changed/)(
                  error,
                ),
              );
            }
          }
          assert.equal(
            selected,
            true,
            'A genuinely unused natural admission slot was exercised',
          );
          assert.equal(flushed, true);
        },
      );

      await t.test(
        'arbitrary child receipt hash cannot replace the unchanged native hash producers',
        async () => {
          const pending = await queueChild(commenter);
          const envelope = pending.approval.envelope;
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_child_intent_hash($1::jsonb,$2) AS hash',
                [JSON.stringify(envelope), pending.input.authorMode],
              )
            ).rows[0].hash,
            publicationHash('publish_comment', {
              postId: named.id,
              text: pending.input.text,
              imageAssetIds: pending.input.imageAssetIds,
              authorMode: pending.input.authorMode,
            }),
          );
          for (const targetReplyId of [null, randomUUID()])
            for (const authorMode of ['named', 'anonymous'] as const) {
              const rootCommentId = randomUUID();
              const reply = canonicalEnvelope({
                ...envelope,
                purpose: 'publish_reply',
                rootCommentId,
                targetReplyId,
                authorMode,
              });
              const body = {
                clientRequestId: randomUUID(),
                text: reply.text,
                imageAssetIds: [],
                authorMode,
                targetReplyId,
              };
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT whaleu_community.related_sync_child_intent_hash($1::jsonb,$2) AS hash',
                    [JSON.stringify(reply), authorMode],
                  )
                ).rows[0].hash,
                publicationHash(
                  'publish_reply',
                  replyIntent(rootCommentId, body),
                ),
              );
            }
          let bound = false;
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              await completeRawChild(tx, pending, 'a'.repeat(64));
              bound = true;
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            }),
            violation(
              /Related child requires its own exact inherited native approval/,
            ),
          );
          assert.equal(bound, true);
        },
      );

      await t.test(
        'anonymous root owner requested-named child remains forced anonymous with its original request hash',
        async () => {
          const pending = await queueChild(author, anonymous.id, 'named');
          assert.equal(pending.approval.envelope.authorMode, 'anonymous');
          const created = await send(
            `/v1/community/posts/${anonymous.id}/comments`,
            author,
            pending.input,
          );
          assert.equal(
            created.body.outcome,
            'created',
            JSON.stringify(created.body),
          );
          const binding = await stored('comment', created.body.resourceId);
          assert.equal(binding.envelope.authorMode, 'anonymous');
          assert.match(binding.related_actor_fingerprint, /^[a-f0-9]{64}$/);
          assert.ok(binding.related_actor_transaction);
          const storedHash = (
            await f.pool.query(
              'SELECT payload_hash FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
              [author.accountId, pending.input.clientRequestId],
            )
          ).rows[0].payload_hash;
          assert.equal(
            storedHash,
            publicationHash('publish_comment', {
              postId: anonymous.id,
              text: pending.input.text,
              imageAssetIds: [],
              authorMode: 'named',
            }),
          );
          assert.deepEqual(
            (
              await send(
                `/v1/community/posts/${anonymous.id}/comments`,
                author,
                pending.input,
              )
            ).body,
            created.body,
          );
          const reply = {
            clientRequestId: randomUUID(),
            text: 'Synthetic forced-anonymous reply',
            imageAssetIds: [],
            authorMode: 'named' as const,
            targetReplyId: null,
          };
          const reviewed = await send(
            `/v1/community/reviews/comments/${created.body.resourceId}/replies`,
            author,
            reply,
          );
          assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
          await f.decide(author.accountId, reply.clientRequestId);
          const replied = await send(
            `/v1/community/comments/${created.body.resourceId}/replies`,
            author,
            reply,
          );
          assert.equal(
            replied.body.outcome,
            'created',
            JSON.stringify(replied.body),
          );
          assert.equal(
            (await stored('reply', replied.body.resourceId)).envelope
              .authorMode,
            'anonymous',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT payload_hash FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
                [author.accountId, reply.clientRequestId],
              )
            ).rows[0].payload_hash,
            publicationHash(
              'publish_reply',
              replyIntent(created.body.resourceId, reply),
            ),
          );
        },
      );

      await t.test(
        'uppercase related UUID bytes fail explicitly before Review while stored recovery stays exact',
        async () => {
          const uppercaseImage = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
          const rootVariants = [
            {
              ...named.input,
              clientRequestId: randomUUID(),
              spaceId: named.input.spaceId.toUpperCase(),
            },
            {
              ...named.input,
              clientRequestId: randomUUID(),
              imageAssetIds: [uppercaseImage],
            },
          ];
          for (const input of rootVariants)
            for (const path of [
              '/v1/community/reviews/posts',
              '/v1/community/posts',
            ]) {
              const result = await send(path, author, {
                ...input,
                clientRequestId: randomUUID(),
              });
              assert.equal(result.status, 422, JSON.stringify(result.body));
              assert.equal(
                result.body.error?.code ?? result.body.code,
                'RELATED_CONTENT_CANONICAL_ID_REQUIRED',
              );
            }
          const commentInput = {
            clientRequestId: randomUUID(),
            text: 'Synthetic uppercase child',
            imageAssetIds: [],
            authorMode: 'named',
          };
          for (const review of ['', '/reviews'])
            for (const variant of ['path', 'image']) {
              const postId =
                variant === 'path' ? named.id.toUpperCase() : named.id;
              const result = await send(
                `/v1/community${review}/posts/${postId}/comments`,
                commenter,
                {
                  ...commentInput,
                  clientRequestId: randomUUID(),
                  ...(variant === 'image'
                    ? { imageAssetIds: [uppercaseImage] }
                    : {}),
                },
              );
              assert.equal(result.status, 422, JSON.stringify(result.body));
              assert.equal(
                result.body.error?.code ?? result.body.code,
                'RELATED_CONTENT_CANONICAL_ID_REQUIRED',
              );
            }
          const conflict = await send('/v1/community/posts', author, {
            ...named.input,
            spaceId: named.input.spaceId.toUpperCase(),
          });
          assert.equal(
            conflict.body.error?.code ?? conflict.body.code,
            'REQUEST_CONFLICT',
          );
          const lower = await root('named');
          assert.ok(lower.id);
          const pending = await queueChild(commenter);
          const created = await send(
            `/v1/community/posts/${named.id}/comments`,
            commenter,
            pending.input,
          );
          assert.equal(
            created.body.outcome,
            'created',
            JSON.stringify(created.body),
          );
          const childConflict = await send(
            `/v1/community/posts/${named.id.toUpperCase()}/comments`,
            commenter,
            pending.input,
          );
          assert.equal(
            childConflict.body.error?.code ?? childConflict.body.code,
            'REQUEST_CONFLICT',
          );
          const legacy = {
            ...named.input,
            clientRequestId: randomUUID(),
            text: 'Synthetic legacy none exact replay',
            syncToRelatedCampuses: false,
          };
          const queued = await send(
            '/v1/community/reviews/posts',
            author,
            legacy,
          );
          assert.equal(queued.status, 200, JSON.stringify(queued.body));
          await f.decide(author.accountId, legacy.clientRequestId);
          const receipt = await send('/v1/community/posts', author, legacy);
          assert.equal(
            receipt.body.outcome,
            'created',
            JSON.stringify(receipt.body),
          );
          const { syncToRelatedCampuses, ...omitted } = legacy;
          assert.equal(syncToRelatedCampuses, false);
          assert.deepEqual(
            (await send('/v1/community/posts', author, omitted)).body,
            receipt.body,
          );
        },
      );

      await t.test(
        'absent and withdrawn phone deny fresh raw actor proof without erasing historical binding or replay',
        async () => {
          // A committed exact child survives later loss of its creator's phone.
          const pending = await queueChild(commenter);
          const child = await send(
            `/v1/community/posts/${named.id}/comments`,
            commenter,
            pending.input,
          );
          assert.equal(
            child.body.outcome,
            'created',
            JSON.stringify(child.body),
          );
          await f.certify(commenter.accountId, {
            phone: 'unavailable',
            campusId: f.scope.related.campusId,
          });
          await rejectOwnActor(
            canonicalEnvelope({
              ...pending.approval.envelope,
              text: 'Previously approved actor lost phone',
            }),
          );
          assert.ok(
            (await stored('comment', child.body.resourceId))
              .related_actor_fingerprint,
          );
          assert.deepEqual(
            (
              await send(
                `/v1/community/posts/${named.id}/comments`,
                commenter,
                pending.input,
              )
            ).body,
            child.body,
          );
          const noPhone = await f.actor({ phone: 'unavailable' });
          const identity = (
            await f.pool.query<{ id: string }>(
              'SELECT selection_id AS id FROM whaleu_campus.community_identity_heads WHERE account_id=$1',
              [noPhone.accountId],
            )
          ).rows[0]!.id;
          const absent = canonicalEnvelope({
            ...named.envelope,
            accountId: noPhone.accountId,
            text: 'Own complete scope with no current phone',
            scope: {
              ...named.envelope.scope,
              identitySelectionId: identity,
              affiliationSnapshotId: noPhone.facts.snapshotId,
              affiliationAssertionId: noPhone.facts.assertionId,
            },
          });
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_root_admitted($1,$2::jsonb) AS allowed',
                [noPhone.accountId, JSON.stringify(absent.scope)],
              )
            ).rows[0].allowed,
            true,
            'No-phone attack retains an otherwise current own root scope',
          );
          await rejectOwnActor(absent);
          await f.certify(author.accountId, { phone: 'unverified' });
          await rejectOwnActor(
            canonicalEnvelope({
              ...named.envelope,
              text: 'Root actor phone withdrawn',
            }),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_binding_valid($1) AS valid',
                [named.id],
              )
            ).rows[0].valid,
            true,
          );
          assert.deepEqual(
            (await send('/v1/community/posts', author, named.input)).body,
            named.receipt,
          );
          const reader = await f.actor();
          assert.equal(
            (
              await request(f.app.getHttpServer())
                .get(`/v1/community/posts/${named.id}`)
                .set('Authorization', `Bearer ${reader.accessToken}`)
            ).status,
            200,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
