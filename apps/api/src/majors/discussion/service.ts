import { noticeContentAllowed } from '../../safety/account-policy/notice-projection.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { RatingAuthorizationFacade } from '../../authorization/rating-grants.facade.js';
import { MajorDiscussionMediaService } from './media/facade.js';
import { MajorDiscussionMediaOwner } from './media-owner.js';
import { MajorDiscussionMediaReviewFacade } from '../../community/content-review/major-discussion-media-review.facade.js';
import {
  MAJOR_DISCUSSION_V2,
  majorDiscussionIntentHashV2,
  majorDiscussionReceiptV2Schema,
  majorDiscussionPageV2Schema,
  majorDiscussionNoticePageV2Schema,
} from './contracts-v2.js';
import type {
  MajorRootPublishV2,
  MajorReplyPublishV2,
  MajorDiscussionOperationV2,
  MajorDiscussionReceiptV2,
  MajorDiscussionCancelV2,
  MajorDiscussionItemV2,
} from './contracts-v2.js';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { RatingVerificationFacade } from '../../verification/rating-eligibility.facade.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { AuthorDisplayService } from '../../profile/author-display.service.js';
import { profileCountProofOwner } from '../../profile/count-epochs.js';
import { requiredOwnerEpoch } from '../../database/required-owner-proof.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { MajorDiscussionReviewFacade } from '../../community/content-review/major-discussion-review.facade.js';
import { MajorDiscussionNoticeOwner } from '../../notifications/major-discussion/owner.js';
import type { MajorNoticeRow } from '../../notifications/major-discussion/owner.js';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import {
  majorDiscussionPageSchema,
  majorDiscussionReceiptSchema,
  majorDiscussionOwnSchema,
  majorDiscussionNoticePageSchema,
  majorDiscussionTargetSchema,
  majorDiscussionNoticeReadSchema,
} from './contracts.js';
import type {
  MajorDiscussionQuery,
  MajorRootPublish,
  MajorReplyPublish,
  MajorDiscussionLike,
  MajorDiscussionReceipt,
  MajorDiscussionOperation,
  MajorDiscussionCancel,
  MajorDiscussionItem,
} from './contracts.js';
import {
  discussionSource,
  discussionEpoch,
  retainDiscussion,
} from './proof.js';
import type { DiscussionSource } from './proof.js';
import { MajorDiscussionCursors, discussionCursorScope } from './cursor.js';
const profiles = requiredOwnerEpoch(
  profileCountProofOwner,
  'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
);
type MajorDirectorySummary =
  | { kind: 'unavailable' }
  | {
      kind: 'known';
      rootCount: number;
      hotComment: { id: string; body: string; likes: number } | null;
    };
type LegacyCommand = MajorRootPublish | MajorReplyPublish | MajorDiscussionLike;
type Command = LegacyCommand | MajorRootPublishV2 | MajorReplyPublishV2;
type Operation = MajorDiscussionOperation | MajorDiscussionOperationV2;
type Receipt = MajorDiscussionReceipt | MajorDiscussionReceiptV2;
const receiptSchema = (operation: string) =>
  operation.endsWith('.v2')
    ? majorDiscussionReceiptV2Schema
    : majorDiscussionReceiptSchema;
const intentHash = (
  actor: string,
  major: string,
  subject: string | null,
  operation: Operation,
  command: Command,
) =>
  operation.endsWith('.v2')
    ? majorDiscussionIntentHashV2(
        actor,
        major,
        subject,
        operation as MajorDiscussionOperationV2,
        command as MajorRootPublishV2 | MajorReplyPublishV2,
      )
    : majorDiscussionIntentHash(
        actor,
        major,
        subject,
        operation as MajorDiscussionOperation,
        command as LegacyCommand,
      );
export function majorDiscussionIntentHash(
  actorId: string,
  majorId: string,
  subjectId: string | null,
  operation: MajorDiscussionOperation,
  command: LegacyCommand,
) {
  return createHash('sha256')
    .update(
      'whaleu:major-discussion-command:v1\n' +
        canonicalJson({ actorId, majorId, subjectId, operation, command }),
    )
    .digest('hex');
}
interface Row {
  id: string;
  major_id: string;
  root_id: string | null;
  reply_to_reply_id: string | null;
  reply_to_actor_id: string | null;
  actor_id: string;
  body: string;
  created_at: Date;
  time: string;
  status: string;
  publication_version: number;
  likes: string;
  own_revision: string | null;
  own_active: boolean | null;
}
interface Own {
  id: string;
  active: boolean;
  recorded_at: Date;
  catalog_id: string;
  major_revision: string;
}
@Injectable()
export class MajorDiscussionService {
  constructor(
    @Inject(MajorDiscussionMediaService)
    private readonly media: MajorDiscussionMediaService,
    @Inject(MajorDiscussionMediaOwner)
    private readonly mediaOwner: MajorDiscussionMediaOwner,
    @Inject(MajorDiscussionMediaReviewFacade)
    private readonly mediaReview: MajorDiscussionMediaReviewFacade,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(RatingAuthorizationFacade)
    private readonly authorization: RatingAuthorizationFacade,
    @Inject(AuthorDisplayService)
    private readonly authors: AuthorDisplayService,
    @Inject(MajorDiscussionReviewFacade)
    private readonly review: MajorDiscussionReviewFacade,
    @Inject(MajorDiscussionCursors)
    private readonly cursors: MajorDiscussionCursors,
    @Inject(MajorDiscussionNoticeOwner)
    private readonly notices: MajorDiscussionNoticeOwner,
  ) {}
  private run<T>(f: (tx: PoolClient) => Promise<T>) {
    return this.db
      .transaction(f, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              ['major_discussion_causal', 'major_catalog_causal'].includes(
                String(error.constraint),
              )))
        )
          throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
        throw error;
      });
  }
  private async session(token: string, tx: PoolClient, mediaWrite = false) {
    await lockSafetyPolicy(tx, mediaWrite);
    return this.identity.session(token, tx);
  }
  private async eligible(actor: string, tx: PoolClient, publish = false) {
    const phone = await this.verification.phone(actor, tx);
    if (phone.status !== 'verified')
      throw new ApplicationError(
        phone.status === 'unverified'
          ? 'PHONE_VERIFICATION_REQUIRED'
          : 'VERIFICATION_UNAVAILABLE',
      );
    await this.safety.requireAllowed(actor, tx);
    if (publish) {
      const affiliation = await this.verification.affiliation(actor, tx);
      if (affiliation.status !== 'verified') {
        const temporary = await this.verification.temporary(actor, tx);
        if (
          temporary.status !== 'verified' &&
          !(await this.authorization.majorDiscussionBase(actor, tx)).allowed
        )
          throw new ApplicationError('MAJOR_BASE_REQUIRED');
      }
      const until = (
        await tx.query<{ until: string | null }>(
          'SELECT whaleu_majors.major_publish_deadline($1,clock_timestamp())::text until',
          [actor],
        )
      ).rows[0]!.until;
      registerTransactionExactDeadline(tx, until, 'MAJOR_BASE_REQUIRED');
    }
    return {
      phone: phone.fingerprint,
      safety: await this.safety.navigation(tx),
    };
  }
  private async prior(actor: string, key: string, tx: PoolClient) {
    return (
      await tx.query<{ intent_hash: string; receipt: unknown }>(
        'SELECT intent_hash,receipt FROM whaleu_majors.major_discussion_commands WHERE actor_id=$1 AND request_id=$2',
        [actor, key],
      )
    ).rows[0];
  }
  private async membership(
    actor: string,
    id: string,
    comment: string,
    tx: PoolClient,
  ) {
    return (
      await tx.query<Own>(
        `SELECT e.id,e.active,e.recorded_at,coalesce(e.catalog_id,p.catalog_id) catalog_id,coalesce(e.major_revision,p.major_revision) major_revision FROM whaleu_majors.major_discussion_like_heads h JOIN whaleu_majors.major_discussion_like_events e ON e.id=h.revision LEFT JOIN whaleu_majors.major_discussion_like_events p ON p.id=e.previous_revision WHERE h.actor_id=$1 AND h.major_id=$2 AND h.comment_id=$3`,
        [actor, id, comment],
      )
    ).rows[0];
  }
  private async history(id: string, tx: PoolClient) {
    const row = (
      await tx.query<{ history: string | null; until: string | null }>(
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_majors.major_discussion_history($1,'likes',instant.now)::text history,(SELECT min(boundary.value)::text FROM whaleu_majors.major_discussion_history_heads h JOIN whaleu_majors.major_discussion_history_assertions a ON a.id=h.assertion_id CROSS JOIN LATERAL(VALUES(a.accepted_at),(a.valid_until)) boundary(value) WHERE h.major_id=$1 AND h.kind='likes' AND boundary.value>instant.now) until FROM instant`,
        [id],
      )
    ).rows[0]!;
    registerTransactionExactDeadline(
      tx,
      row.until,
      'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
    );
    return row.history;
  }
  @AccountPolicy('browse', 'entry')
  own(token: string, id: string, comment: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        epoch = await discussionEpoch(tx),
        own = await this.membership(session.accountId, id, comment, tx),
        history = own ? null : await this.history(id, tx);
      await retainDiscussion(session.accountId, session.sessionId, id, tx, {
        epoch,
        ...(history ? { history } : {}),
      });
      await this.identity.session(token, tx);
      return majorDiscussionOwnSchema.parse(
        own
          ? {
              kind: 'recorded',
              active: own.active,
              revision: own.id,
              recordedAt: own.recorded_at.toISOString(),
              catalogRevision: own.catalog_id,
              majorRevision: own.major_revision,
            }
          : { kind: history ? 'not_liked' : 'unavailable' },
      );
    });
  }
  private async rows(actor: string, id: string, tx: PoolClient) {
    const result = (
      await tx.query<{ rows: unknown[]; until: string }>(
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now), candidates AS MATERIALIZED(SELECT c.* FROM whaleu_majors.major_discussion_comments c WHERE c.major_id=$1 ORDER BY c.id LIMIT 1001) SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'major_id',c.major_id,'root_id',c.root_id,'reply_to_reply_id',c.reply_to_reply_id,'reply_to_actor_id',c.reply_to_actor_id,'actor_id',c.actor_id,'publication_version',c.publication_version,'body',c.body,'created_at',c.created_at,'time',(extract(epoch FROM c.created_at)*1000000)::bigint::text,'status',whaleu_majors.major_discussion_visibility(c.id,$2,instant.now),'likes',(SELECT count(*)::text FROM whaleu_majors.major_discussion_like_heads h JOIN whaleu_majors.major_discussion_like_events e ON e.id=h.revision WHERE h.major_id=c.major_id AND h.comment_id=c.id AND e.active),'own_revision',(SELECT h.revision FROM whaleu_majors.major_discussion_like_heads h WHERE h.major_id=c.major_id AND h.comment_id=c.id AND h.actor_id=$2),'own_active',(SELECT e.active FROM whaleu_majors.major_discussion_like_heads h JOIN whaleu_majors.major_discussion_like_events e ON e.id=h.revision WHERE h.major_id=c.major_id AND h.comment_id=c.id AND h.actor_id=$2)) ORDER BY c.id) FROM candidates c),'[]'::jsonb) rows,least(instant.now+interval '10 minutes',whaleu_majors.major_discussion_deadline($1,instant.now))::text until FROM instant`,
        [id, actor],
      )
    ).rows[0]!;
    if (result.rows.length > 1000)
      throw new ApplicationError('MAJOR_DISCUSSION_BUDGET_UNAVAILABLE');
    const rows = result.rows as (Omit<Row, 'created_at'> & {
      created_at: string;
    })[];
    if (rows.some((row) => row.status === 'unavailable'))
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    registerTransactionExactDeadline(
      tx,
      result.until,
      'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
    );
    return {
      rows: rows.map((row) => ({
        ...row,
        created_at: new Date(row.created_at),
      })),
      until: result.until,
    };
  }
  private async author(actor: string, tx: PoolClient) {
    const display = await this.authors.findRatingPublic(actor, tx);
    if (!display)
      throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
    return { mode: 'named' as const, ...display };
  }
  private async project(
    row: Row,
    rows: Row[],
    tx: PoolClient,
    v2 = false,
  ): Promise<MajorDiscussionItem | MajorDiscussionItemV2> {
    const target = row.reply_to_reply_id
      ? rows.find(
          (r) =>
            r.id === row.reply_to_reply_id &&
            r.root_id === row.root_id &&
            r.status === 'allow',
        )
      : undefined;
    return {
      ...(v2
        ? {
            protocol: MAJOR_DISCUSSION_V2,
            images: await this.imageReferences(row, tx),
          }
        : {}),
      id: row.id,
      majorId: row.major_id,
      rootId: row.root_id,
      replyToReplyId: target ? target.id : null,
      body: row.body,
      author: await this.author(row.actor_id, tx),
      addressedAuthor: target ? await this.author(target.actor_id, tx) : null,
      createdAt: row.created_at.toISOString(),
      likes: Number(row.likes),
      replyCount: row.root_id
        ? 0
        : rows.filter((r) => r.root_id === row.id && r.status === 'allow')
            .length,
      isLiked: row.own_active ?? false,
      myMembershipRevision: row.own_revision,
    };
  }
  private async imageReferences(
    row: Pick<Row, 'id' | 'major_id' | 'publication_version'>,
    tx: PoolClient,
  ) {
    if (row.publication_version !== 2) return [];
    return (
      await tx.query<{
        majorId: string;
        commentId: string;
        bindingId: string;
        ordinal: number;
      }>(
        `SELECT major_id "majorId",comment_id "commentId",binding_id "bindingId",ordinal FROM whaleu_media.major_discussion_appearances WHERE comment_id=$1 AND major_id=$2 ORDER BY ordinal`,
        [row.id, row.major_id],
      )
    ).rows;
  }
  @AccountPolicy('browse', 'entry')
  page(
    token: string,
    id: string,
    query: MajorDiscussionQuery,
    rootId: string | null = null,
    v2 = false,
  ) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        access = await this.eligible(session.accountId, tx),
        source = await discussionSource(id, tx),
        epoch = await discussionEpoch(tx),
        profile = await profiles(tx),
        mediaEpoch = await this.media.retainCurrent(tx),
        topology = v2 ? await this.mediaOwner.retainTopology(tx) : null,
        snapshot = await this.rows(session.accountId, id, tx);
      if (!v2 && snapshot.rows.some((r) => r.publication_version === 2))
        throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
      const root = rootId
        ? snapshot.rows.find(
            (r) =>
              r.id === rootId && r.root_id === null && r.status === 'allow',
          )
        : null;
      if (rootId && !root)
        throw new ApplicationError('MAJOR_DISCUSSION_NOT_FOUND');
      const scope = discussionCursorScope([
        v2 ? 'major-discussion-v2' : 'major-discussion-v1',
        mediaEpoch,
        topology,
        session.accountId,
        session.sessionId,
        id,
        rootId,
        source,
        epoch,
        profile,
        access,
        query.sort,
        query.limit,
      ]);
      const after = query.cursor
        ? await this.cursors.get(query.cursor, scope, tx)
        : null;
      const candidates = snapshot.rows.filter(
        (r) => r.root_id === rootId && r.status === 'allow',
      );
      const compare = (a: Row, b: Row) =>
        rootId
          ? a.created_at.getTime() - b.created_at.getTime() ||
            a.id.localeCompare(b.id)
          : (query.sort === 'likes' ? Number(b.likes) - Number(a.likes) : 0) ||
            b.created_at.getTime() - a.created_at.getTime() ||
            b.id.localeCompare(a.id);
      candidates.sort(compare);
      const remaining = after
        ? candidates.filter((r) =>
            rootId
              ? BigInt(r.time) > BigInt(after.time) ||
                (r.time === after.time && r.id > after.id)
              : query.sort === 'likes' &&
                  Number(r.likes) !== Number(after.likes)
                ? Number(r.likes) < Number(after.likes)
                : BigInt(r.time) < BigInt(after.time) ||
                  (r.time === after.time && r.id < after.id),
          )
        : candidates;
      const more = remaining.length > query.limit,
        chosen = remaining.slice(0, query.limit),
        last = chosen.at(-1),
        nextCursor =
          more && last
            ? await this.cursors.create(
                session.accountId,
                scope,
                {
                  v: 1,
                  kind: 'major-discussion-v1',
                  id: last.id,
                  time: last.time,
                  likes: last.likes,
                  validUntil: snapshot.until,
                },
                tx,
              )
            : null;
      const items: (MajorDiscussionItem | MajorDiscussionItemV2)[] = [];
      for (const row of chosen)
        items.push(await this.project(row, snapshot.rows, tx, v2));
      const rootView = root
        ? await this.project(root, snapshot.rows, tx, v2)
        : null;
      await retainDiscussion(session.accountId, session.sessionId, id, tx, {
        source,
        epoch,
      });
      await this.identity.session(token, tx);
      return (
        v2 ? majorDiscussionPageV2Schema : majorDiscussionPageSchema
      ).parse({
        ...(v2 ? { protocol: MAJOR_DISCUSSION_V2 } : {}),
        majorId: id,
        catalogRevision: source.catalog,
        majorRevision: source.revision,
        discussionRevision: epoch.content,
        root: rootView,
        items,
        totalCount: candidates.length,
        nextCursor,
        continuation: more ? 'more' : 'end',
      });
    });
  }
  async summary(actor: string, session: string, id: string, tx: PoolClient) {
    return (await this.summaries(actor, session, [id], tx)).get(id)!;
  }
  async summaries(
    actor: string,
    session: string,
    ids: readonly string[],
    tx: PoolClient,
  ) {
    const result = new Map<string, MajorDirectorySummary>();
    if (ids.length > 50 || new Set(ids).size !== ids.length)
      throw new ApplicationError('MAJOR_DISCUSSION_BUDGET_UNAVAILABLE');
    if (!ids.length) return result;
    const epoch = await discussionEpoch(tx);
    await this.media.retainCurrent(tx);
    await this.mediaOwner.retainTopology(tx);
    await profiles(tx);
    const captures = (
      await tx.query<{
        ordinal: string;
        major_id: string;
        source: DiscussionSource | null;
      }>(
        'WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT s.ordinal::text ordinal,s.major_id,s.source FROM instant CROSS JOIN LATERAL whaleu_majors.major_discussion_sources($1::uuid[],instant.now) s ORDER BY s.ordinal',
        [ids],
      )
    ).rows;
    if (captures.length !== ids.length)
      throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
    for (const [index, id] of ids.entries()) {
      const capture = captures[index]!;
      if (capture.ordinal !== String(index + 1) || capture.major_id !== id)
        throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
      const observation = capture.source;
      let summary: MajorDirectorySummary = { kind: 'unavailable' };
      if (observation?.population && observation.likes) {
        try {
          const snapshot = await this.rows(actor, id, tx);
          const roots = snapshot.rows.filter(
            (row) => row.root_id === null && row.status === 'allow',
          );
          roots.sort(
            (a, b) =>
              Number(b.likes) - Number(a.likes) ||
              b.created_at.getTime() - a.created_at.getTime() ||
              b.id.localeCompare(a.id),
          );
          const hot = roots[0];
          summary = {
            kind: 'known',
            rootCount: roots.length,
            hotComment: hot
              ? { id: hot.id, body: hot.body, likes: Number(hot.likes) }
              : null,
          };
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            ![
              'CONTENT_REVIEW_UNAVAILABLE',
              'MAJOR_DISCUSSION_BUDGET_UNAVAILABLE',
            ].includes(error.code)
          )
            throw error;
        }
      }
      await retainDiscussion(actor, session, id, tx, { observation, epoch });
      result.set(id, summary);
    }
    return result;
  }
  private async target(
    actor: string,
    id: string,
    subject: string,
    tx: PoolClient,
    rootId?: string | null,
  ) {
    const row = (
      await tx.query<Row>(
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT c.*,whaleu_majors.major_discussion_visibility(c.id,$1,instant.now) status FROM whaleu_majors.major_discussion_comments c CROSS JOIN instant WHERE c.major_id=$2 AND c.id=$3`,
        [actor, id, subject],
      )
    ).rows[0];
    if (
      !row ||
      row.status === 'deny' ||
      (rootId !== undefined && row.root_id !== rootId)
    )
      throw new ApplicationError('MAJOR_DISCUSSION_NOT_FOUND');
    if (row.status !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return row;
  }
  private async record(
    actor: string,
    session: string,
    id: string,
    subject: string | null,
    operation: Operation,
    command: Command,
    receipt: Receipt,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_majors.major_discussion_commands(actor_id,request_id,session_id,major_id,subject_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        actor,
        command.clientRequestId,
        session,
        id,
        subject,
        operation,
        command,
        intentHash(actor, id, subject, operation, command),
        receipt,
      ],
    );
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  publish(token: string, id: string, command: MajorRootPublish) {
    return this.mutate(
      token,
      id,
      null,
      'major.discussion.root.v1',
      command,
      false,
    );
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  reply(token: string, id: string, root: string, command: MajorReplyPublish) {
    return this.mutate(
      token,
      id,
      root,
      'major.discussion.reply.v1',
      command,
      false,
    );
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  like(
    token: string,
    id: string,
    subject: string,
    command: MajorDiscussionLike,
  ) {
    return this.mutate(
      token,
      id,
      subject,
      'major.discussion.like.v1',
      command,
      false,
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancel(token: string, key: string, input: MajorDiscussionCancel) {
    if (key !== input.command.clientRequestId)
      throw new ApplicationError('REQUEST_CONFLICT');
    return this.mutate(
      token,
      input.majorId,
      'rootId' in input
        ? input.rootId
        : 'commentId' in input
          ? input.commentId
          : null,
      input.operation,
      input.command,
      true,
    );
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  publishV2(token: string, id: string, command: MajorRootPublishV2) {
    return this.mutate(
      token,
      id,
      null,
      'major.discussion.root.v2',
      command,
      false,
    );
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  replyV2(
    token: string,
    id: string,
    root: string,
    command: MajorReplyPublishV2,
  ) {
    return this.mutate(
      token,
      id,
      root,
      'major.discussion.reply.v2',
      command,
      false,
    );
  }
  private async mediaCancelPrior(actor: string, key: string, tx: PoolClient) {
    return (
      await tx.query<{
        major_id: string;
        root_id: string | null;
        operation: string;
        intent_hash: string | null;
        receipt: unknown;
      }>(
        'SELECT major_id,root_id,operation,intent_hash,receipt FROM whaleu_majors.major_discussion_media_cancels WHERE actor_id=$1 AND request_id=$2',
        [actor, key],
      )
    ).rows[0];
  }
  private assertMediaCancel(
    fence: {
      major_id: string;
      root_id: string | null;
      operation: string;
      intent_hash: string | null;
    },
    major: string,
    root: string | null,
    operation: string,
    hash: string | null,
  ) {
    if (
      fence.major_id !== major ||
      fence.root_id !== root ||
      fence.operation !== operation ||
      (fence.intent_hash !== null && fence.intent_hash !== hash)
    )
      throw new ApplicationError('REQUEST_CONFLICT');
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  receiptV2(token: string, key: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      const prior =
        (await this.prior(session.accountId, key, tx)) ??
        (await this.mediaCancelPrior(session.accountId, key, tx));
      if (!prior) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.identity.session(token, tx);
      const parsed = majorDiscussionReceiptV2Schema.safeParse(prior.receipt);
      if (!parsed.success) throw new ApplicationError('REQUEST_CONFLICT');
      return parsed.data;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancelV2(token: string, key: string, input: MajorDiscussionCancelV2) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId,
        root = 'rootId' in input ? input.rootId : null;
      await tx.query('SELECT whaleu_majors.major_discussion_lock($1,$2,NULL)', [
        actor,
        key,
      ]);
      const prior = await this.prior(actor, key, tx);
      if (prior) {
        if (input.intentHash === null || prior.intent_hash !== input.intentHash)
          throw new ApplicationError('REQUEST_CONFLICT');
        const parsed = majorDiscussionReceiptV2Schema.safeParse(prior.receipt);
        if (
          !parsed.success ||
          parsed.data.operation !== input.operation ||
          parsed.data.majorId !== input.majorId ||
          ('rootId' in parsed.data ? parsed.data.rootId : null) !== root
        )
          throw new ApplicationError('REQUEST_CONFLICT');
        await this.identity.session(token, tx);
        return parsed.data;
      }
      const fence = await this.mediaCancelPrior(actor, key, tx);
      if (fence) {
        this.assertMediaCancel(
          fence,
          input.majorId,
          root,
          input.operation,
          input.intentHash,
        );
        return majorDiscussionReceiptV2Schema.parse(fence.receipt);
      }
      const receipt = majorDiscussionReceiptV2Schema.parse({
        requestId: key,
        majorId: input.majorId,
        operation: input.operation,
        ...(root ? { rootId: root } : {}),
        outcome: 'rejected',
        code: 'MAJOR_DISCUSSION_CANCELLED',
      });
      await tx.query(
        'INSERT INTO whaleu_majors.major_discussion_media_cancels(actor_id,request_id,session_id,major_id,root_id,operation,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          actor,
          key,
          session.sessionId,
          input.majorId,
          root,
          input.operation,
          input.intentHash,
          receipt,
        ],
      );
      await this.identity.session(token, tx);
      return receipt;
    });
  }
  private mutate(
    token: string,
    id: string,
    subject: string | null,
    operation: Operation,
    command: Command,
    cancel: boolean,
  ) {
    return this.run(async (tx) => {
      // Media scope/binding statement writers require the exclusive policy
      // gate. Acquire it before the publication key, never upgrade a shared
      // gate while a same-key waiter still owns the other shared gate.
      const session = await this.session(token, tx, operation.endsWith('.v2')),
        actor = session.accountId,
        hash = intentHash(actor, id, subject, operation, command),
        pub = operation !== 'major.discussion.like.v1',
        isReply =
          operation === 'major.discussion.reply.v1' ||
          operation === 'major.discussion.reply.v2',
        v2 = operation.endsWith('.v2');
      await tx.query('SELECT whaleu_majors.major_discussion_lock($1,$2,$3)', [
        actor,
        command.clientRequestId,
        pub ? null : subject,
      ]);
      const prior = await this.prior(actor, command.clientRequestId, tx);
      if (prior) {
        if (prior.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        await this.identity.session(token, tx);
        return receiptSchema(operation).parse(prior.receipt);
      }
      if (v2) {
        const fence = await this.mediaCancelPrior(
          actor,
          command.clientRequestId,
          tx,
        );
        if (fence) {
          this.assertMediaCancel(fence, id, subject, operation, hash);
          return majorDiscussionReceiptV2Schema.parse(fence.receipt);
        }
      }
      const base = {
        requestId: command.clientRequestId,
        operation,
        majorId: id,
        ...(isReply ? { rootId: subject } : pub ? {} : { commentId: subject }),
      };
      if (cancel) {
        const receipt = receiptSchema(operation).parse({
          ...base,
          outcome: 'rejected',
          code: 'MAJOR_DISCUSSION_CANCELLED',
        });
        await this.record(
          actor,
          session.sessionId,
          id,
          subject,
          operation,
          command,
          receipt,
          tx,
        );
        await this.identity.session(token, tx);
        return receipt;
      }
      const like = command as MajorDiscussionLike,
        positive = pub || like.active,
        own = pub ? undefined : await this.membership(actor, id, subject!, tx);
      let source: DiscussionSource | undefined,
        history: string | null = null;
      if (positive) {
        await this.mediaOwner.retainTopology(tx);
        // Legacy publication and likes do not write Media. Retain the epoch
        // before their target read so an image sibling cannot change unseen.
        // V2 publication captures after its own atomic binding writes instead.
        if (!v2) await this.media.retainCurrent(tx);
        await this.eligible(actor, tx, pub);
        source = await discussionSource(id, tx);
      } else if (!own) {
        history = await this.history(id, tx);
        if (!history)
          throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
      }
      let receipt: Receipt;
      if (
        source &&
        (source.catalog !== command.expectedCatalogRevision ||
          source.revision !== command.expectedMajorRevision)
      )
        receipt = receiptSchema(operation).parse({
          ...base,
          outcome: 'rejected',
          code: 'MAJOR_REVISION_CONFLICT',
        });
      else if (pub) {
        const publication = command as MajorReplyPublish | MajorReplyPublishV2,
          root = isReply
            ? await this.target(actor, id, subject!, tx, null)
            : null,
          target =
            isReply && publication.replyToReplyId
              ? await this.target(
                  actor,
                  id,
                  publication.replyToReplyId,
                  tx,
                  root!.id,
                )
              : null;
        const images = 'images' in publication ? publication.images : [];
        const mediaContext = v2
          ? {
              majorId: id,
              publicationRequestId: command.clientRequestId,
              catalogRevision: command.expectedCatalogRevision,
              majorRevision: command.expectedMajorRevision,
              rootId: root?.id ?? null,
              replyToReplyId: target?.id ?? null,
              contextDigest: (
                await this.mediaOwner.context(
                  actor,
                  {
                    majorId: id,
                    publicationRequestId: command.clientRequestId,
                    catalogRevision: command.expectedCatalogRevision,
                    majorRevision: command.expectedMajorRevision,
                    rootId: root?.id ?? null,
                    replyToReplyId: target?.id ?? null,
                  },
                  tx,
                )
              ).contextDigest,
            }
          : null;
        if (mediaContext)
          await this.media.draftFacts(actor, mediaContext, images, tx, true);
        const envelope = {
          version: 1 as const,
          purpose: operation as
            'major.discussion.root.v1' | 'major.discussion.reply.v1',
          actorId: actor,
          requestId: command.clientRequestId,
          majorId: id,
          catalogRevision: command.expectedCatalogRevision,
          majorRevision: command.expectedMajorRevision,
          body: publication.body,
          rootId: root?.id ?? null,
          replyToReplyId: target?.id ?? null,
          replyToActorId: target?.actor_id ?? null,
        };
        const decision = v2
          ? await this.mediaReview.consume(
              {
                ...envelope,
                version: 2,
                purpose: operation as MajorDiscussionOperationV2,
                images,
              },
              tx,
            )
          : await this.review.consume(envelope, tx);
        if (decision.status === 'reject')
          receipt = receiptSchema(operation).parse({
            ...base,
            outcome: 'rejected',
            code: 'CONTENT_REJECTED',
          });
        else {
          await this.authors.prepare(actor, tx);
          const cid = randomUUID(),
            row = (
              await tx.query<{ created_at: Date }>(
                'INSERT INTO whaleu_majors.major_discussion_comments(id,major_id,root_id,reply_to_reply_id,reply_to_actor_id,actor_id,request_id,catalog_id,major_revision,population_assertion_id,review_decision_id,body,publication_version,image_set,media_review_decision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING created_at',
                [
                  cid,
                  id,
                  root?.id ?? null,
                  target?.id ?? null,
                  target?.actor_id ?? null,
                  actor,
                  command.clientRequestId,
                  source!.catalog,
                  source!.revision,
                  source!.population,
                  v2 ? null : decision.decisionId,
                  publication.body,
                  v2 ? 2 : 1,
                  JSON.stringify(images),
                  v2 ? decision.decisionId : null,
                ],
              )
            ).rows[0]!;
          if (mediaContext) {
            await this.media.acceptAndBind(
              cid,
              actor,
              mediaContext,
              images,
              tx,
            );
            if (root) await this.target(actor, id, root.id, tx, null);
            if (target) await this.target(actor, id, target.id, tx, root!.id);
          }
          receipt = receiptSchema(operation).parse({
            ...base,
            outcome: 'applied',
            commentId: cid,
            createdAt: row.created_at.toISOString(),
          });
        }
      } else {
        if (positive) await this.target(actor, id, subject!, tx);
        else if (
          !(
            await tx.query(
              'SELECT id FROM whaleu_majors.major_discussion_comments WHERE id=$1 AND major_id=$2',
              [subject, id],
            )
          ).rowCount
        )
          throw new ApplicationError('MAJOR_DISCUSSION_NOT_FOUND');
        if ((own?.id ?? null) !== like.expectedMembershipRevision)
          receipt = receiptSchema(operation).parse({
            ...base,
            outcome: 'rejected',
            code: 'MAJOR_DISCUSSION_MEMBERSHIP_CONFLICT',
          });
        else if ((own?.active ?? false) === like.active)
          receipt = receiptSchema(operation).parse({
            ...base,
            outcome: 'noop',
            active: like.active,
            membershipRevision: own?.id ?? null,
            recordedAt: own?.recorded_at.toISOString() ?? null,
          });
        else {
          const revision = randomUUID(),
            row = (
              await tx.query<{ recorded_at: Date }>(
                'INSERT INTO whaleu_majors.major_discussion_like_events(id,major_id,comment_id,actor_id,request_id,previous_revision,active,catalog_id,major_revision,population_assertion_id,likes_assertion_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING recorded_at',
                [
                  revision,
                  id,
                  subject,
                  actor,
                  command.clientRequestId,
                  own?.id ?? null,
                  like.active,
                  source?.catalog ?? null,
                  source?.revision ?? null,
                  source?.population ?? null,
                  source?.likes ?? null,
                ],
              )
            ).rows[0]!;
          if (own)
            await tx.query(
              'UPDATE whaleu_majors.major_discussion_like_heads SET revision=$4 WHERE major_id=$1 AND comment_id=$2 AND actor_id=$3',
              [id, subject, actor, revision],
            );
          else
            await tx.query(
              'INSERT INTO whaleu_majors.major_discussion_like_heads(major_id,comment_id,actor_id,revision) VALUES($1,$2,$3,$4)',
              [id, subject, actor, revision],
            );
          receipt = receiptSchema(operation).parse({
            ...base,
            outcome: 'applied',
            active: like.active,
            membershipRevision: revision,
            recordedAt: row.recorded_at.toISOString(),
          });
        }
      }
      if (!pub && like.active && receipt.outcome === 'applied')
        await this.authors.prepare(actor, tx);
      await this.notices.capture(actor, command.clientRequestId, tx);
      await this.record(
        actor,
        session.sessionId,
        id,
        subject,
        operation,
        command,
        receipt,
        tx,
      );
      if (positive) await this.media.retainCurrent(tx);
      await retainDiscussion(actor, session.sessionId, id, tx, {
        ...(source ? { source, publish: pub } : {}),
        ...(history ? { history } : {}),
      });
      await this.identity.session(token, tx);
      return receipt;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  receipt(token: string, key: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        prior = await this.prior(session.accountId, key, tx);
      if (!prior) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.identity.session(token, tx);
      const parsed = majorDiscussionReceiptSchema.safeParse(prior.receipt);
      if (!parsed.success) throw new ApplicationError('REQUEST_CONFLICT');
      return parsed.data;
    });
  }
  private async noticeView(
    row: MajorNoticeRow,
    actor: string,
    session: string,
    tx: PoolClient,
    v2 = false,
  ) {
    const base = {
      noticeId: row.id,
      createdAt: row.created_at.toISOString(),
      readAt: row.read_at?.toISOString() ?? null,
    };
    if (!(await noticeContentAllowed(actor, tx)))
      return { ...base, status: 'unavailable' as const };
    const epoch = await discussionEpoch(tx),
      observation = (
        await tx.query<{ source: DiscussionSource | null }>(
          'SELECT whaleu_majors.major_discussion_source($1,clock_timestamp()) source',
          [row.major_id],
        )
      ).rows[0]!.source;
    await retainDiscussion(actor, session, row.major_id, tx, {
      observation,
      epoch,
    });
    if (!observation?.population || !observation.likes)
      return { ...base, status: 'unavailable' as const };
    const target = (
      await tx.query<Row>(
        `SELECT c.*,whaleu_majors.major_discussion_visibility(c.id,$1,clock_timestamp()) status FROM whaleu_majors.major_discussion_comments c WHERE c.id=$2 AND c.major_id=$3 AND coalesce(c.root_id,c.id)=$4`,
        [actor, row.comment_id, row.major_id, row.root_id],
      )
    ).rows[0];
    // Major root-author notices target the root, while their preview is the
    // causal new reply. Both must remain visible; a hidden reply is never quoted.
    const preview =
      row.kind === 'reply'
        ? (
            await tx.query<Row>(
              `SELECT c.*,whaleu_majors.major_discussion_visibility(c.id,$1,clock_timestamp()) status FROM whaleu_majors.major_discussion_comments c WHERE c.id=$2 AND c.major_id=$3 AND c.root_id=$4`,
              [actor, row.event_id, row.major_id, row.root_id],
            )
          ).rows[0]
        : target;
    const senderFact = (
      await tx.query<{ status: string; until: string | null }>(
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_safety.major_discussion_named($1,$2,instant.now) status,(SELECT min(valid_until)::text FROM whaleu_safety.account_heads WHERE account_id IN($1,$2) AND valid_until>instant.now) until FROM instant`,
        [actor, row.actor_id],
      )
    ).rows[0]!;
    registerTransactionExactDeadline(
      tx,
      senderFact.until,
      'SAFETY_UNAVAILABLE',
    );
    const sender = senderFact.status;
    await this.media.retainCurrent(tx);
    if (
      !target ||
      target.status !== 'allow' ||
      !preview ||
      preview.status !== 'allow' ||
      sender !== 'allow' ||
      (!v2 &&
        (target.publication_version === 2 || preview.publication_version === 2))
    )
      return { ...base, status: 'unavailable' as const };
    const display = await this.authors.findRatingPublic(row.actor_id, tx);
    if (!display) return { ...base, status: 'unavailable' as const };
    return {
      ...base,
      status: 'available' as const,
      kind: row.kind,
      preview: {
        ...(v2
          ? {
              thumbnail:
                row.kind === 'reply'
                  ? ((await this.imageReferences(preview, tx))[0] ?? null)
                  : null,
            }
          : {}),
        text: Array.from(preview.body).slice(0, 50).join(''),
        author: { mode: 'named' as const, ...display },
      },
      target: {
        majorId: row.major_id,
        rootId: row.root_id,
        commentId: row.comment_id,
      },
    };
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  noticePage(
    token: string,
    query: Pick<MajorDiscussionQuery, 'limit' | 'cursor'>,
    v2 = false,
  ) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        access = await this.eligible(session.accountId, tx),
        epoch = await this.notices.epoch(tx),
        mediaEpoch = await this.media.retainCurrent(tx),
        topology = v2 ? await this.mediaOwner.retainTopology(tx) : null,
        profile = await profiles(tx),
        scope = discussionCursorScope([
          v2 ? 'major-discussion-notices-v2' : 'major-discussion-notices-v1',
          mediaEpoch,
          topology,
          session.accountId,
          session.sessionId,
          access,
          profile,
          epoch,
          query.limit,
        ]),
        after = query.cursor
          ? await this.cursors.get(query.cursor, scope, tx)
          : null,
        rows = await this.notices.list(
          session.accountId,
          query.limit,
          after,
          tx,
        ),
        more = rows.length > query.limit,
        chosen = rows.slice(0, query.limit),
        last = chosen.at(-1),
        until = (
          await tx.query<{ until: string }>(
            "SELECT(clock_timestamp()+interval '10 minutes')::text until",
          )
        ).rows[0]!.until;
      const items = [];
      for (const row of chosen)
        items.push(
          await this.noticeView(
            row,
            session.accountId,
            session.sessionId,
            tx,
            v2,
          ),
        );
      const nextCursor =
          more && last
            ? await this.cursors.create(
                session.accountId,
                scope,
                {
                  v: 1,
                  kind: 'major-discussion-v1',
                  id: last.id,
                  time: last.time,
                  likes: '0',
                  validUntil: until,
                },
                tx,
              )
            : null,
        unreadCount = await this.notices.unread(session.accountId, tx);
      await this.notices.retain(epoch, tx);
      await this.identity.session(token, tx);
      return (
        v2 ? majorDiscussionNoticePageV2Schema : majorDiscussionNoticePageSchema
      ).parse({
        ...(v2 ? { protocol: MAJOR_DISCUSSION_V2 } : {}),
        items,
        nextCursor,
        unreadCount,
      });
    });
  }
  @AccountPolicy('browse', 'entry')
  noticeTarget(token: string, id: string, v2 = false) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      await this.eligible(session.accountId, tx);
      await profiles(tx);
      await this.media.retainCurrent(tx);
      if (v2) await this.mediaOwner.retainTopology(tx);
      const epoch = await this.notices.epoch(tx),
        row = await this.notices.find(session.accountId, id, tx),
        view = await this.noticeView(
          row,
          session.accountId,
          session.sessionId,
          tx,
          v2,
        );
      if (view.status !== 'available')
        throw new ApplicationError('MAJOR_DISCUSSION_NOT_FOUND');
      await this.notices.retain(epoch, tx);
      await this.identity.session(token, tx);
      return majorDiscussionTargetSchema.parse(view.target);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  noticeRead(token: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        readAt = await this.notices.read(
          session.accountId,
          session.sessionId,
          id,
          tx,
        );
      await this.identity.session(token, tx);
      return majorDiscussionNoticeReadSchema.parse({ noticeId: id, readAt });
    });
  }
}
