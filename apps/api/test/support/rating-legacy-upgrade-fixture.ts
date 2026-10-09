/** Historical protocol fixtures for 0051/0052 publication and 0052 upgrades.
 * It writes genuine historical commands through the original SQL guards/triggers and
 * canonical Review/Experience owners. It never invokes current command services,
 * suppresses a constraint, mocks a result, or permits a production missing table.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { INestApplication } from '@nestjs/common';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import type { RatingContentEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { AuthorDisplayService } from '../../src/profile/author-display.service.js';
import { RatingEffectsCapture } from '../../src/ratings/effects/capture.js';
import { ratingIso } from '../../src/ratings/repository.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { writeRatingApproval } from './rating-runtime-fixture.js';
import type { RatingDiscussionFixture } from './rating-discussion-fixture.js';

type Actor = Awaited<ReturnType<RatingDiscussionFixture['actor']>>;
type Catalog = Awaited<ReturnType<RatingDiscussionFixture['catalog']>>;
type Target = Catalog['targets'][number];

const open = async (
  tx: PoolClient,
  actor: { accountId: string },
  requestId: string,
  operation: string,
  intent: unknown,
  domain = 'whaleu:rating-command:v1',
) => {
  const hash = createHash('sha256')
    .update(domain + '\n' + canonicalJson({ operation, intent }))
    .digest('hex');
  await tx.query(
    'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
    [actor.accountId, requestId, operation, hash],
  );
};
const close = async <T extends { requestId: string }>(
  tx: PoolClient,
  actor: { accountId: string },
  receipt: T,
) => {
  await tx.query(
    'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
    [actor.accountId, receipt.requestId, canonicalJson(receipt)],
  );
  return receipt;
};
const bind = async (
  tx: PoolClient,
  kind: 'comment' | 'reply',
  id: string,
  envelope: RatingContentEnvelope,
) => {
  const approval = await writeRatingApproval(tx, envelope);
  await tx.query(
    `INSERT INTO whaleu_community.rating_approval_bindings(kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [
      kind,
      id,
      approval.decisionId,
      envelope.accountId,
      envelope.purpose,
      envelope.version,
      approval.digest,
      canonicalJson(envelope),
      canonicalJson(envelope.scope),
    ],
  );
};

/** Original v1 publication protocol at real 0051/0052, including v2 reply envelope.
 * Used during migration gaps; deliberately not a current HTTP compatibility claim.
 */
export async function publishLegacyRating(
  runtime: { app: INestApplication; pool: Pool },
  envelope: RatingContentEnvelope,
  intent: unknown,
) {
  if (envelope.purpose === 'publish_rating_target')
    throw new Error('Legacy publication fixture requires a comment or reply');
  assert.equal(envelope.authorMode, 'named');
  const id = randomUUID(),
    revision = randomUUID();
  const kind =
    envelope.purpose === 'publish_rating_comment' ? 'comment' : 'reply';
  const operation = kind === 'comment' ? 'create_comment' : 'create_reply';
  const receipt = await withCommunityScopeWriter(runtime.pool, async (tx) => {
    assert.match(
      (
        await tx.query<{ name: string }>(
          'SELECT max(name) name FROM whaleu_meta.schema_migrations',
        )
      ).rows[0]!.name,
      /^005[12]_/,
      'Legacy SQL publication requires the real 0051 or 0052 prefix',
    );
    await runtime.app.get(AuthorDisplayService).prepare(envelope.accountId, tx);
    const actor = { accountId: envelope.accountId };
    await open(
      tx,
      actor,
      envelope.clientRequestId,
      operation,
      intent,
      kind === 'comment'
        ? 'whaleu:rating-command:v1'
        : 'whaleu:rating-reply-command:v1',
    );
    const row =
      envelope.purpose === 'publish_rating_comment'
        ? (
            await tx.query<{ occurred_at: string }>(
              `INSERT INTO whaleu_ratings.comments(id,target_id,account_id,author_mode,body,revision,request_id,envelope) VALUES($1,$2,$3,'named',$4,$5,$6,$7::jsonb) RETURNING ${ratingIso('created_at')} occurred_at`,
              [
                id,
                envelope.targetId,
                envelope.accountId,
                envelope.body,
                revision,
                envelope.clientRequestId,
                canonicalJson(envelope),
              ],
            )
          ).rows[0]!
        : (
            await tx.query<{ occurred_at: string }>(
              `INSERT INTO whaleu_ratings.replies(id,target_id,root_id,reply_to_id,account_id,author_mode,body,revision,request_id,envelope) VALUES($1,$2,$3,$4,$5,'named',$6,$7,$8,$9::jsonb) RETURNING ${ratingIso('created_at')} occurred_at`,
              [
                id,
                envelope.targetId,
                envelope.rootId,
                envelope.replyTo?.replyId ?? null,
                envelope.accountId,
                envelope.body,
                revision,
                envelope.clientRequestId,
                canonicalJson(envelope),
              ],
            )
          ).rows[0]!;
    await bind(tx, kind, id, envelope);
    await runtime.app
      .get(RatingEffectsCapture)
      .captureCreated(envelope.accountId, envelope.clientRequestId, tx);
    const result =
      envelope.purpose === 'publish_rating_comment'
        ? {
            requestId: envelope.clientRequestId,
            operation: 'create_comment' as const,
            outcome: 'applied' as const,
            targetId: envelope.targetId,
            subjectId: id,
            revision,
            occurredAt: row.occurred_at,
          }
        : {
            requestId: envelope.clientRequestId,
            operation: 'create_reply' as const,
            outcome: 'applied' as const,
            targetId: envelope.targetId,
            rootId: envelope.rootId,
            replyId: id,
            revision,
            occurredAt: row.occurred_at,
          };
    return close(tx, actor, result);
  });
  return { id, revision, receipt };
}
export async function seedRating0052Upgrade(
  f: RatingDiscussionFixture,
  owner: Actor,
  other: Actor,
  catalog: Catalog,
  target: Target,
) {
  assert.match(
    (
      await f.pool.query<{ name: string }>(
        'SELECT max(name) name FROM whaleu_meta.schema_migrations',
      )
    ).rows[0]!.name,
    /^0052_/,
    'Historical seed must run against actual 0052, before any later migration',
  );
  const effects = f.app.get(RatingEffectsCapture);
  const publish = async (actor: Actor) => {
    const input = f.body(catalog, target);
    return {
      ...(await publishLegacyRating(
        f,
        f.envelope(actor, catalog, target, input),
        { targetId: target.id, ...input },
      )),
      input,
    };
  };
  const root = await publish(owner);
  const replyInput = f.replyBody(catalog, target, root);
  const reply = {
    ...(await publishLegacyRating(
      f,
      f.replyEnvelope(other, catalog, target, root, replyInput),
      { rootId: root.id, ...replyInput },
    )),
    input: replyInput,
  };
  const deletedRoot = await publish(owner);
  const deletion = await withCommunityScopeWriter(f.pool, async (tx) => {
    const input = {
      clientRequestId: randomUUID(),
      regionId: catalog.regionId,
      targetId: target.id,
      expectedTargetRevision: target.revision,
      expectedRevision: deletedRoot.revision,
    };
    await open(tx, owner, input.clientRequestId, 'delete_comment', {
      commentId: deletedRoot.id,
      ...input,
    });
    const row = (
      await tx.query<{ revision: string; occurred_at: string }>(
        `UPDATE whaleu_ratings.comments SET deleted_at=clock_timestamp(),delete_request_id=$2,revision=$3 WHERE id=$1 RETURNING revision,${ratingIso('deleted_at')} occurred_at`,
        [deletedRoot.id, input.clientRequestId, randomUUID()],
      )
    ).rows[0]!;
    return close(tx, owner, {
      requestId: input.clientRequestId,
      operation: 'delete_comment' as const,
      outcome: 'applied' as const,
      targetId: target.id,
      subjectId: deletedRoot.id,
      revision: row.revision,
      occurredAt: row.occurred_at,
    });
  });
  const score = await withCommunityScopeWriter(f.pool, async (tx) => {
    const input = {
      clientRequestId: randomUUID(),
      regionId: null,
      expectedTargetRevision: target.revision,
      expectedRevision: null,
      score: 4,
    };
    await open(tx, owner, input.clientRequestId, 'set_score', {
      targetId: target.id,
      ...input,
    });
    const row = (
      await tx.query<{ revision: string; occurred_at: string }>(
        `INSERT INTO whaleu_ratings.scores(target_id,account_id,score,revision,request_id) VALUES($1,$2,4,$3,$4) RETURNING revision,${ratingIso('updated_at')} occurred_at`,
        [target.id, owner.accountId, randomUUID(), input.clientRequestId],
      )
    ).rows[0]!;
    return close(tx, owner, {
      requestId: input.clientRequestId,
      operation: 'set_score' as const,
      outcome: 'applied' as const,
      targetId: target.id,
      subjectId: target.id,
      revision: row.revision,
      occurredAt: row.occurred_at,
    });
  });
  const liked = await withCommunityScopeWriter(f.pool, async (tx) => {
    const before = (
      await tx.query<{ baseline_id: string }>(
        'SELECT baseline_id FROM whaleu_ratings.like_subjects WHERE id=$1',
        [root.id],
      )
    ).rows[0]!;
    const input = {
      clientRequestId: randomUUID(),
      regionId: null,
      targetId: target.id,
      expectedTargetRevision: target.revision,
      expectedRevision: root.revision,
      expectedLikeRevision: before.baseline_id,
      liked: true,
    };
    await open(
      tx,
      other,
      input.clientRequestId,
      'set_comment_like',
      { rootId: root.id, ...input },
      'whaleu:rating-like-command:v1',
    );
    const row = (
      await tx.query<{ revision: string; occurred_at: string }>(
        `INSERT INTO whaleu_ratings.like_memberships(subject_id,account_id,liked,request_id,expected_revision) VALUES($1,$2,true,$3,$4) RETURNING revision,${ratingIso('updated_at')} occurred_at`,
        [root.id, other.accountId, input.clientRequestId, before.baseline_id],
      )
    ).rows[0]!;
    await effects.captureLiked(other.accountId, input.clientRequestId, tx);
    return close(tx, other, {
      requestId: input.clientRequestId,
      operation: 'set_comment_like' as const,
      outcome: 'applied' as const,
      targetId: target.id,
      rootId: root.id,
      replyId: null,
      liked: true,
      revision: row.revision,
      occurredAt: row.occurred_at,
    });
  });
  return { root, reply, deletedRoot, deletion, score, liked };
}
