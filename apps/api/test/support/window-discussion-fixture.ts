/** Synthetic explicit provenance only. No runtime issuer, seed or provider. */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { windowRatingFixture } from './window-rating-fixture.js';
import type {
  WindowRootPublish,
  WindowReplyPublish,
} from '../../src/ratings/windows/discussion/contracts.js';
import { windowDiscussionReviewDigest } from '../../src/community/content-review/window-discussion-review.facade.js';
export async function discussionHistory(
  pool: Pool,
  windowId: string,
  kind: 'population' | 'likes',
  coverage: 'accepted_empty' | 'unknown' = 'accepted_empty',
  until = new Date(Date.now() + 3600000),
) {
  return inTransaction(pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO whaleu_ratings.window_discussion_history_assertions(id,window_id,kind,coverage,source_reference,policy_reference,valid_until) VALUES($1,$2,$3,$4,'synthetic:independent-window-discussion-reconciliation','synthetic:accepted-empty-only',$5)",
      [id, windowId, kind, coverage, until],
    );
    await tx.query(
      'INSERT INTO whaleu_ratings.window_discussion_history_heads(window_id,kind,assertion_id) VALUES($1,$2,$3) ON CONFLICT(window_id,kind) DO UPDATE SET assertion_id=EXCLUDED.assertion_id',
      [windowId, kind, id],
    );
    return id;
  });
}
export async function reviewWindowDiscussion(
  pool: Pool,
  actorId: string,
  windowId: string,
  command: WindowRootPublish | WindowReplyPublish,
  rootId: string | null = null,
  verdict: 'allow' | 'reject' = 'allow',
  options: {
    consumeUntil?: Date;
    visibilityUntil?: Date;
    issuedAt?: Date;
  } = {},
) {
  return inTransaction(pool, async (tx) => {
    const id = randomUUID(),
      policy = randomUUID(),
      target = 'replyToReplyId' in command ? command.replyToReplyId : null,
      replyToActorId = target
        ? ((
            await tx.query<{ actor_id: string }>(
              'SELECT actor_id FROM whaleu_ratings.window_discussion_comments WHERE id=$1',
              [target],
            )
          ).rows[0]?.actor_id ?? null)
        : null,
      envelope = {
        version: 1 as const,
        purpose: rootId
          ? ('window.discussion.reply.v1' as const)
          : ('window.discussion.root.v1' as const),
        actorId,
        requestId: command.clientRequestId,
        windowId,
        catalogRevision: command.expectedCatalogRevision,
        windowRevision: command.expectedWindowRevision,
        body: command.body,
        rootId,
        replyToReplyId: target,
        replyToActorId,
      };
    await tx.query(
      "INSERT INTO whaleu_community.window_discussion_review_policies(id,issuer,source_reference,coverage,valid_from,valid_until) VALUES($1,'synthetic:local-window-discussion-review','synthetic:no-live-provider','complete',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '2 hours')",
      [policy],
    );
    await tx.query(
      'INSERT INTO whaleu_community.window_discussion_review_decisions(id,actor_id,request_id,window_id,catalog_id,window_revision,purpose,root_id,reply_to_reply_id,reply_to_actor_id,body,policy_id,verdict,digest,issued_at,consume_until,visibility_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,coalesce($15::timestamptz,clock_timestamp()),$16,$17)',
      [
        id,
        actorId,
        command.clientRequestId,
        windowId,
        command.expectedCatalogRevision,
        command.expectedWindowRevision,
        envelope.purpose,
        rootId,
        target,
        replyToActorId,
        command.body,
        policy,
        verdict,
        windowDiscussionReviewDigest(envelope),
        options.issuedAt ?? null,
        options.consumeUntil ?? new Date(Date.now() + 3600000),
        options.visibilityUntil ?? new Date(Date.now() + 3600000),
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_community.window_discussion_review_heads(actor_id,request_id,decision_id,state) VALUES($1,$2,$3,'active') ON CONFLICT(actor_id,request_id) DO UPDATE SET decision_id=EXCLUDED.decision_id,state='active'",
      [actorId, command.clientRequestId, id],
    );
    return id;
  });
}
export async function revokeWindowDiscussionReview(
  pool: Pool,
  decisionId: string,
) {
  await pool.query(
    "UPDATE whaleu_community.window_discussion_review_heads SET state='revoked' WHERE decision_id=$1",
    [decisionId],
  );
}
export async function windowDiscussionFixture(
  base?: Parameters<typeof windowRatingFixture>[0],
) {
  const f = await windowRatingFixture(base);
  const acceptDiscussion = async (ids: string[]) => {
    for (const id of ids) {
      await discussionHistory(f.pool, id, 'population');
      await discussionHistory(f.pool, id, 'likes');
    }
  };
  const root = (
    catalog: string,
    window: { revision: string },
    body = 'Synthetic discussion',
  ) => ({
    clientRequestId: randomUUID(),
    expectedCatalogRevision: catalog,
    expectedWindowRevision: window.revision,
    body,
  });
  const reply = (
    catalog: string,
    window: { revision: string },
    body: string,
    replyToReplyId: string | null = null,
  ) => ({ ...root(catalog, window, body), replyToReplyId });
  const like = (
    catalog: string,
    window: { revision: string },
    active = true,
    expectedMembershipRevision: string | null = null,
  ) => ({
    clientRequestId: randomUUID(),
    expectedCatalogRevision: catalog,
    expectedWindowRevision: window.revision,
    active,
    expectedMembershipRevision,
  });
  return { ...f, acceptDiscussion, root, reply, like };
}
