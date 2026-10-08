import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ExperienceIngressService } from '../../experience/ingress.js';
import { ApplicationError } from '../../http/application-error.js';
import { isRewardEventType, rewardBeneficiaries } from './contracts.js';
import type { CapturedResource, RewardEventType } from './contracts.js';

const actorSchema = z.uuid().transform((value) => value.toLowerCase());
const obligationIdsSchema = z
  .array(actorSchema)
  .min(1)
  .max(2)
  .refine((ids) => new Set(ids).size === ids.length);
const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');
interface Event {
  event_type: string;
  resource_id: string;
  context: Record<string, unknown>;
}
interface Obligation {
  id: string;
  action: 'saver_reward' | 'author_reward';
  recipient_account_id: string;
}

/** Called only by the fresh event writer, while its domain transaction owns all
 * resource/authorization locks. Settlers use the separate immutable facade. */
@Injectable()
export class CommunityExperienceSourceCapture {
  constructor(
    @Inject(ExperienceIngressService)
    private readonly ingress: ExperienceIngressService,
  ) {}

  private async resource(
    event: Event,
    tx: PoolClient,
  ): Promise<CapturedResource> {
    const kind = event.event_type.startsWith('reply_')
      ? 'reply'
      : event.event_type.startsWith('comment_')
        ? 'comment'
        : 'post';
    const id =
      event.event_type === 'post_saved'
        ? actorSchema.parse(event.context['postId'])
        : event.resource_id;
    const result =
      kind === 'post'
        ? await tx.query<CapturedResource>(
            `SELECT 'post' AS "resourceKind",p.id AS "postId",NULL::uuid AS "rootCommentId",NULL::uuid AS "replyId",NULL::uuid AS "targetReplyId",
         p.account_id AS "resourceAuthorId",p.author_mode AS "resourceAuthorMode",p.account_id AS "postAuthorId",NULL::uuid AS "rootAuthorId",NULL::uuid AS "targetReplyAuthorId",
         p.published_at::text AS "createdAt",p.deleted_at::text AS "deletedAt",coalesce(p.local_creation_transaction=pg_current_xact_id(),false) AS "creationFresh",
         coalesce(p.local_deletion_transaction=pg_current_xact_id(),false) AS "deletionFresh" FROM whaleu_community.posts p WHERE p.id=$1`,
            [id],
          )
        : kind === 'comment'
          ? await tx.query<CapturedResource>(
              `SELECT 'comment' AS "resourceKind",p.id AS "postId",c.id AS "rootCommentId",NULL::uuid AS "replyId",NULL::uuid AS "targetReplyId",
           c.account_id AS "resourceAuthorId",c.author_mode AS "resourceAuthorMode",p.account_id AS "postAuthorId",c.account_id AS "rootAuthorId",NULL::uuid AS "targetReplyAuthorId",
           c.created_at::text AS "createdAt",c.deleted_at::text AS "deletedAt",coalesce(c.local_creation_transaction=pg_current_xact_id(),false) AS "creationFresh",
           coalesce(c.local_deletion_transaction=pg_current_xact_id(),false) AS "deletionFresh"
           FROM whaleu_community.root_comments c JOIN whaleu_community.posts p ON p.id=c.post_id WHERE c.id=$1`,
              [id],
            )
          : await tx.query<CapturedResource>(
              `SELECT 'reply' AS "resourceKind",p.id AS "postId",c.id AS "rootCommentId",r.id AS "replyId",r.target_reply_id AS "targetReplyId",
           r.account_id AS "resourceAuthorId",r.author_mode AS "resourceAuthorMode",p.account_id AS "postAuthorId",c.account_id AS "rootAuthorId",t.account_id AS "targetReplyAuthorId",
           r.created_at::text AS "createdAt",r.deleted_at::text AS "deletedAt",coalesce(r.local_creation_transaction=pg_current_xact_id(),false) AS "creationFresh",
           coalesce(r.local_deletion_transaction=pg_current_xact_id(),false) AS "deletionFresh"
           FROM whaleu_community.replies r JOIN whaleu_community.root_comments c ON c.id=r.root_comment_id
           JOIN whaleu_community.posts p ON p.id=r.post_id LEFT JOIN whaleu_community.replies t ON t.id=r.target_reply_id WHERE r.id=$1`,
              [id],
            );
    if (!result.rows[0]) throw unavailable();
    return result.rows[0];
  }

  async enroll(eventId: string, tx: PoolClient): Promise<void> {
    const event = (
      await tx.query<Event>(
        'SELECT event_type,resource_id,context FROM whaleu_community.outbox WHERE id=$1',
        [eventId],
      )
    ).rows[0];
    if (!event || !isRewardEventType(event.event_type)) return;
    const eventType: RewardEventType = event.event_type;
    const parsedActor = actorSchema.safeParse(event.context['actorAccountId']);
    if (event.context['experienceSourceVersion'] !== 1 || !parsedActor.success)
      throw unavailable();
    const actorId = parsedActor.data;
    const source = await this.resource(event, tx);
    const interaction =
      eventType.endsWith('_liked') || eventType === 'post_saved';
    const actorMode = interaction ? null : source.resourceAuthorMode;
    if (
      event.context['actorAuthorMode'] !== actorMode ||
      event.context['resourceAuthorMode'] !== source.resourceAuthorMode
    )
      throw unavailable();
    if (!interaction && actorId !== source.resourceAuthorId)
      throw unavailable();
    let occurredAt = source.createdAt;
    let likeId: string | null = null;
    let saveEpochId: string | null = null;
    let obligations: Obligation[] = [];
    if (eventType.endsWith('_created')) {
      if (!source.creationFresh) throw unavailable();
    } else if (eventType.endsWith('_deleted')) {
      if (!source.deletionFresh || !source.deletedAt) throw unavailable();
      occurredAt = source.deletedAt;
    } else if (eventType.endsWith('_liked')) {
      const parsed = actorSchema.safeParse(event.context['likeId']);
      if (!parsed.success) throw unavailable();
      likeId = parsed.data;
      const kind = source.resourceKind;
      const membership = (
        await tx.query<{ liked_at: string }>(
          `SELECT liked_at::text AS liked_at FROM whaleu_community.${kind}_likes WHERE like_id=$1 AND ${kind}_id=$2 AND account_id=$3 AND local_creation_transaction=pg_current_xact_id()`,
          [likeId, event.resource_id, actorId],
        )
      ).rows[0];
      if (!membership) throw unavailable();
      occurredAt = membership.liked_at;
    } else {
      saveEpochId = event.resource_id;
      const epoch = (
        await tx.query<{ started_at: string }>(
          'SELECT started_at::text AS started_at FROM whaleu_community.saved_epochs WHERE id=$1 AND account_id=$2 AND post_id=$3 AND local_creation_transaction=pg_current_xact_id()',
          [saveEpochId, actorId, source.postId],
        )
      ).rows[0];
      const ids = obligationIdsSchema.safeParse(
        event.context['rewardObligationIds'],
      );
      if (!epoch || !ids.success) throw unavailable();
      occurredAt = epoch.started_at;
      obligations = (
        await tx.query<Obligation>(
          `SELECT id,action,recipient_account_id FROM whaleu_community.saved_obligations WHERE id=ANY($1::uuid[]) AND epoch_id=$2 AND transition='saved' AND delta=1
         AND action IN ('saver_reward','author_reward') AND status='pending' AND local_creation_transaction=pg_current_xact_id()`,
          [ids.data, saveEpochId],
        )
      ).rows;
      if (obligations.length !== ids.data.length) throw unavailable();
    }
    const beneficiaries = rewardBeneficiaries({
      eventType,
      actorId,
      ...source,
    });
    if (
      eventType === 'post_saved' &&
      (obligations.length !== beneficiaries.length ||
        beneficiaries.some(
          (unit) =>
            !obligations.some(
              (obligation) =>
                obligation.recipient_account_id === unit.beneficiaryId &&
                obligation.action ===
                  (unit.action === 'like_save'
                    ? 'saver_reward'
                    : 'author_reward'),
            ),
        ))
    )
      throw unavailable();
    const { enrollmentOrder } = await this.ingress.reserve(
      tx,
      beneficiaries.map((unit) => unit.beneficiaryId),
    );
    const groupId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.reward_source_groups(id,event_id,event_type,resource_kind,post_id,root_comment_id,reply_id,target_reply_id,save_epoch_id,like_id,
       actor_account_id,actor_author_mode,resource_author_id,resource_author_mode,post_author_id,root_author_id,target_reply_author_id,occurred_at,enrollment_order,expected_unit_count)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        groupId,
        eventId,
        eventType,
        source.resourceKind,
        source.postId,
        source.rootCommentId,
        source.replyId,
        source.targetReplyId,
        saveEpochId,
        likeId,
        actorId,
        actorMode,
        source.resourceAuthorId,
        source.resourceAuthorMode,
        source.postAuthorId,
        source.rootAuthorId,
        source.targetReplyAuthorId,
        occurredAt,
        enrollmentOrder,
        beneficiaries.length,
      ],
    );
    const units = [];
    for (const beneficiary of beneficiaries) {
      const unitId = randomUUID();
      const obligation =
        eventType === 'post_saved'
          ? obligations.find(
              (item) =>
                item.recipient_account_id === beneficiary.beneficiaryId &&
                item.action ===
                  (beneficiary.action === 'like_save'
                    ? 'saver_reward'
                    : 'author_reward'),
            )!
          : null;
      await tx.query(
        `INSERT INTO whaleu_community.reward_source_units(id,group_id,beneficiary_id,action,enrollment_order,outbox_event_id,saved_obligation_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          unitId,
          groupId,
          beneficiary.beneficiaryId,
          beneficiary.action,
          enrollmentOrder,
          obligation ? null : eventId,
          obligation?.id ?? null,
        ],
      );
      units.push({ unitId, groupId, ...beneficiary, enrollmentOrder });
    }
    await this.ingress.enqueue(tx, units);
  }
}
