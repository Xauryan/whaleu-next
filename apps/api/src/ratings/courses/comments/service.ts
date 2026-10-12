import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../../database/database.js';
import { IdentityService } from '../../../identity/identity.service.js';
import { RatingVerificationFacade } from '../../../verification/rating-eligibility.facade.js';
import { RatingAuthorizationFacade } from '../../../authorization/rating-grants.facade.js';
import { RatingSafetyFacade } from '../../../safety/rating.facade.js';
import { lockSafetyPolicy } from '../../../safety/locks.js';
import { CampusCourseScopeFacade } from '../../../campus/course-scope.facade.js';
import { CourseCommentReviewFacade } from '../../../community/content-review/course-comment-review.facade.js';
import { canonicalJson } from '../../../community/content-review/contracts.js';
import { ApplicationError } from '../../../http/application-error.js';
import { CourseRepository } from '../repository.js';
import { currentCatalog } from '../proof.js';
import {
  courseCommentPageSchema,
  courseCommentReceiptSchema,
} from './contracts.js';
import type {
  CourseCommentQuery,
  CourseCommentPublish,
  CourseCommentLike,
  CourseCommentReceipt,
  CourseCommentOperation,
  CourseCommentCancel,
} from './contracts.js';
import { commentSource, retainComments, commentEpoch } from './proof.js';
import { CourseCommentCursors, commentCursorScope } from './cursor.js';
export function courseCommentIntentHash(
  actorId: string,
  courseId: string,
  commentId: string | null,
  operation: CourseCommentOperation,
  command: CourseCommentPublish | CourseCommentLike,
) {
  return createHash('sha256')
    .update(
      'whaleu:course-comment-command:v1\n' +
        canonicalJson({ actorId, courseId, commentId, operation, command }),
    )
    .digest('hex');
}
@Injectable()
export class CourseCommentsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingAuthorizationFacade)
    private readonly authorization: RatingAuthorizationFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(CampusCourseScopeFacade)
    private readonly campus: CampusCourseScopeFacade,
    @Inject(CourseRepository) private readonly courses: CourseRepository,
    @Inject(CourseCommentReviewFacade)
    private readonly review: CourseCommentReviewFacade,
    @Inject(CourseCommentCursors)
    private readonly cursors: CourseCommentCursors,
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
              error.constraint === 'course_comment_causal'))
        )
          throw new ApplicationError('COURSE_COMMENT_HISTORY_UNAVAILABLE');
        throw error;
      });
  }
  private async session(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    return this.identity.session(token, tx);
  }
  private async eligible(actor: string, publish: boolean, tx: PoolClient) {
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
          !(await this.authorization.courseCommentBase(actor, tx)).allowed
        )
          throw new ApplicationError('COURSE_COMMENT_BASE_REQUIRED');
      }
    }
    return {
      phone: phone.fingerprint,
      safety: await this.safety.navigation(tx),
    };
  }
  private async source(id: string, tx: PoolClient) {
    const catalog = await currentCatalog(tx),
      course = await this.courses.course(catalog.id, id, tx);
    await this.campus.requireCurrent(course.campus_id, tx);
    return commentSource(id, tx);
  }
  private async prior(actor: string, request: string, tx: PoolClient) {
    return (
      await tx.query<{ intent_hash: string; receipt: unknown }>(
        'SELECT intent_hash,receipt FROM whaleu_ratings.course_comment_commands WHERE actor_id=$1 AND request_id=$2',
        [actor, request],
      )
    ).rows[0];
  }
  private async lock(actor: string, key: string, tx: PoolClient) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:course-comment-request:v1:'||$1||':'||$2,0))",
      [actor, key],
    );
  }
  private async record(
    actor: string,
    session: string,
    id: string,
    commentId: string | null,
    operation: CourseCommentOperation,
    command: CourseCommentLike | CourseCommentPublish,
    receipt: CourseCommentReceipt,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_ratings.course_comment_commands(actor_id,request_id,session_id,course_id,comment_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        actor,
        command.clientRequestId,
        session,
        id,
        commentId,
        operation,
        command,
        courseCommentIntentHash(actor, id, commentId, operation, command),
        receipt,
      ],
    );
  }
  page(token: string, id: string, query: CourseCommentQuery) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        access = await this.eligible(session.accountId, false, tx),
        source = await this.source(id, tx),
        epoch = await commentEpoch(tx),
        review = await this.review.ranking(id, tx);
      const scope = commentCursorScope([
        'course-comments-v1',
        session.accountId,
        session.sessionId,
        id,
        source,
        epoch,
        review.epoch,
        access,
        query.sort,
        query.limit,
      ]);
      const after = query.cursor
        ? await this.cursors.get(query.cursor, scope, tx)
        : null;
      // The deadline covers the WHOLE ranking, not just the current page. Text keeps
      // PostgreSQL microseconds exact; a continuation never silently skips a change.
      const deadline = (
        await tx.query<{ until: string }>(
          `SELECT least(clock_timestamp()+interval '10 minutes',$1::timestamptz,(SELECT min(a.valid_until) FROM whaleu_ratings.course_comment_history_heads h JOIN whaleu_ratings.course_comment_history_assertions a ON a.id=h.assertion_id WHERE h.course_id=$2),(SELECT valid_until FROM whaleu_ratings.course_catalogs WHERE id=$3))::text until`,
          [review.validUntil, id, source.catalog],
        )
      ).rows[0]!.until;
      const rows = (
        await tx.query<{
          id: string;
          body: string;
          likes: string;
          created_at: Date;
          time: string;
        }>(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now),rated AS MATERIALIZED(SELECT c.id,c.body,c.created_at,(extract(epoch FROM c.created_at)*1000000)::bigint::text time,(SELECT count(*) FROM whaleu_ratings.course_comment_likes l WHERE l.comment_id=c.id)::text likes FROM whaleu_ratings.course_comments c CROSS JOIN instant WHERE c.course_id=$1 AND whaleu_community.course_comment_visibility(c.id,instant.now)='allow') SELECT * FROM rated WHERE ($3::bigint IS NULL OR $3::bigint>=0) AND ($2::uuid IS NULL OR ${query.sort === 'likes' ? '(likes::bigint,time::bigint,id)<($3::bigint,$4::bigint,$2::uuid)' : '(time::bigint,id)<($4::bigint,$2::uuid)'}) ORDER BY ${query.sort === 'likes' ? 'likes::bigint DESC,' : ''}time::bigint DESC,id DESC LIMIT $5`,
          [
            id,
            after?.id ?? null,
            after?.likes ?? null,
            after?.time ?? null,
            query.limit + 1,
          ],
        )
      ).rows;
      const more = rows.length > query.limit,
        chosen = rows.slice(0, query.limit),
        last = chosen.at(-1);
      const nextCursor =
        more && last
          ? await this.cursors.create(
              session.accountId,
              scope,
              {
                v: 1,
                kind: 'course-comments-v1',
                id: last.id,
                time: last.time,
                likes: last.likes,
                validUntil: deadline,
              },
              tx,
            )
          : null;
      await retainComments(
        session.accountId,
        session.sessionId,
        id,
        false,
        source,
        tx,
        epoch,
      );
      await this.identity.session(token, tx);
      return courseCommentPageSchema.parse({
        courseId: id,
        catalogRevision: source.catalog,
        courseRevision: source.revision,
        commentRevision: epoch,
        items: chosen.map((c) => ({
          id: c.id,
          body: c.body,
          likes: Number(c.likes),
          createdAt: c.created_at.toISOString(),
        })),
        nextCursor,
        continuation: more ? 'more' : 'end',
      });
    });
  }
  publish(token: string, id: string, command: CourseCommentPublish) {
    return this.mutate(
      token,
      id,
      null,
      'course.comment.publish.v1',
      command,
      false,
    );
  }
  like(
    token: string,
    id: string,
    commentId: string,
    command: CourseCommentLike,
  ) {
    return this.mutate(
      token,
      id,
      commentId,
      'course.comment.like.v1',
      command,
      false,
    );
  }
  cancel(token: string, requestId: string, input: CourseCommentCancel) {
    if (requestId !== input.command.clientRequestId)
      throw new ApplicationError('REQUEST_CONFLICT');
    return this.mutate(
      token,
      input.courseId,
      'commentId' in input ? input.commentId : null,
      input.operation,
      input.command,
      true,
    );
  }
  private mutate(
    token: string,
    id: string,
    commentId: string | null,
    operation: CourseCommentOperation,
    command: CourseCommentLike | CourseCommentPublish,
    cancel: boolean,
  ) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId,
        hash = courseCommentIntentHash(
          actor,
          id,
          commentId,
          operation,
          command,
        );
      await this.lock(actor, command.clientRequestId, tx);
      const prior = await this.prior(actor, command.clientRequestId, tx);
      if (prior) {
        if (prior.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        await this.identity.session(token, tx);
        return courseCommentReceiptSchema.parse(prior.receipt);
      }
      const pub = operation === 'course.comment.publish.v1';
      const base = {
        requestId: command.clientRequestId,
        operation,
        courseId: id,
        ...(commentId ? { commentId } : {}),
      };
      if (cancel) {
        const receipt = courseCommentReceiptSchema.parse({
          ...base,
          outcome: 'rejected',
          code: 'COURSE_COMMENT_CANCELLED',
        });
        await this.record(
          actor,
          session.sessionId,
          id,
          commentId,
          operation,
          command,
          receipt,
          tx,
        );
        await this.identity.session(token, tx);
        return receipt;
      }
      await this.eligible(actor, pub, tx);
      const source = await this.source(id, tx);
      let receipt: CourseCommentReceipt;
      let decision:
        { decisionId: string; status: 'allow' | 'reject' } | undefined;
      if (
        source.catalog !== command.expectedCatalogRevision ||
        source.revision !== command.expectedCourseRevision
      )
        receipt = courseCommentReceiptSchema.parse({
          ...base,
          outcome: 'rejected',
          code: 'COURSE_REVISION_CONFLICT',
        });
      else if (pub) {
        const body = (command as CourseCommentPublish).body;
        decision = await this.review.consume(
          {
            version: 1,
            purpose: 'course.comment.publish.v1',
            actorId: actor,
            requestId: command.clientRequestId,
            courseId: id,
            catalogRevision: command.expectedCatalogRevision,
            courseRevision: command.expectedCourseRevision,
            body,
          },
          tx,
        );
        if (decision.status === 'reject')
          receipt = courseCommentReceiptSchema.parse({
            ...base,
            outcome: 'rejected',
            code: 'CONTENT_REJECTED',
          });
        else {
          const cid = randomUUID();
          const row = (
            await tx.query<{ created_at: Date }>(
              'INSERT INTO whaleu_ratings.course_comments(id,course_id,actor_id,request_id,catalog_id,course_revision,population_assertion_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at',
              [
                cid,
                id,
                actor,
                command.clientRequestId,
                source.catalog,
                source.revision,
                source.population,
                body,
              ],
            )
          ).rows[0]!;
          await this.review.bind(cid, id, decision.decisionId, tx);
          receipt = courseCommentReceiptSchema.parse({
            ...base,
            outcome: 'applied',
            commentId: cid,
            createdAt: row.created_at.toISOString(),
          });
        }
      } else {
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:course-comment-like:v1:'||$1||':'||$2,0))",
          [actor, commentId],
        );
        const target = (
          await tx.query(
            'SELECT id FROM whaleu_ratings.course_comments WHERE id=$1 AND course_id=$2',
            [commentId, id],
          )
        ).rows[0];
        if (!target || !(await this.review.visibility(commentId!, tx)))
          throw new ApplicationError('COURSE_COMMENT_NOT_FOUND');
        if (
          (
            await tx.query(
              'SELECT 1 FROM whaleu_ratings.course_comment_likes WHERE comment_id=$1 AND actor_id=$2',
              [commentId, actor],
            )
          ).rowCount
        )
          receipt = courseCommentReceiptSchema.parse({
            ...base,
            outcome: 'rejected',
            code: 'COURSE_COMMENT_ALREADY_LIKED',
          });
        else {
          const row = (
            await tx.query<{ created_at: Date }>(
              'INSERT INTO whaleu_ratings.course_comment_likes(comment_id,actor_id,request_id,history_assertion_id) VALUES($1,$2,$3,$4) RETURNING created_at',
              [commentId, actor, command.clientRequestId, source.likes],
            )
          ).rows[0]!;
          receipt = courseCommentReceiptSchema.parse({
            ...base,
            outcome: 'applied',
            recordedAt: row.created_at.toISOString(),
          });
        }
      }
      await this.record(
        actor,
        session.sessionId,
        id,
        commentId,
        operation,
        command,
        receipt,
        tx,
      );
      if (decision)
        await this.review.retainConsumed(
          decision.decisionId,
          decision.status,
          tx,
        );
      else if (!pub) await this.review.ranking(id, tx);
      await retainComments(actor, session.sessionId, id, pub, source, tx);
      await this.identity.session(token, tx);
      return receipt;
    });
  }
  receipt(token: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        prior = await this.prior(session.accountId, id, tx);
      if (!prior) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.identity.session(token, tx);
      return courseCommentReceiptSchema.parse(prior.receipt);
    });
  }
}
