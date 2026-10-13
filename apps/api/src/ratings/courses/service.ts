import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { RatingVerificationFacade } from '../../verification/rating-eligibility.facade.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { CampusCourseScopeFacade } from '../../campus/course-scope.facade.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  courseSchema,
  courseDetailSchema,
  coursePageSchema,
  courseReceiptSchema,
} from './contracts.js';
import type {
  CourseQuery,
  CourseFirstScore,
  CourseReceipt,
} from './contracts.js';
import { CourseRepository } from './repository.js';
import type { CourseRow } from './repository.js';
import { CourseCursors, courseCursorScope } from './cursor.js';
import { currentCatalog, currentHistory, retainScoreEpoch } from './proof.js';
export function courseIntentHash(
  actorId: string,
  courseId: string,
  command: CourseFirstScore,
) {
  return createHash('sha256')
    .update(
      'whaleu:course-first-score:v1\n' +
        canonicalJson({ actorId, courseId, command }),
    )
    .digest('hex');
}
@Injectable()
export class CourseRatingsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(CampusCourseScopeFacade)
    private readonly campus: CampusCourseScopeFacade,
    @Inject(CourseRepository) private readonly records: CourseRepository,
    @Inject(CourseCursors) private readonly cursors: CourseCursors,
  ) {}
  private run<T>(f: (tx: PoolClient) => Promise<T>) {
    return this.db.transaction(f, { isolationLevel: 'read committed' });
  }
  private async authenticate(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    return this.identity.session(token, tx);
  }
  private async eligible(actor: string, tx: PoolClient) {
    const phone = await this.verification.phone(actor, tx);
    if (phone.status !== 'verified')
      throw new ApplicationError(
        phone.status === 'unverified'
          ? 'PHONE_VERIFICATION_REQUIRED'
          : 'VERIFICATION_UNAVAILABLE',
      );
    await this.safety.requireAllowed(actor, tx);
    return {
      phone: phone.fingerprint,
      safety: await this.safety.navigation(tx),
    };
  }
  private async project(row: CourseRow, tx: PoolClient) {
    await this.campus.requireCurrent(row.campus_id, tx);
    return courseSchema.parse({
      id: row.course_id,
      revision: row.revision,
      name: row.name,
      department: row.department,
      category: row.category,
      nature: row.nature,
      code: row.code,
      campusId: row.campus_id,
      campusLabel: row.campus_label,
      sourceCampusKey: row.source_campus_key,
      createdAt: row.source_created_at.toISOString(),
      summary: await this.records.summary(row.course_id, tx),
    });
  }
  @AccountPolicy('browse', 'entry')
  page(token: string, query: CourseQuery) {
    return this.run(async (tx) => {
      const session = await this.authenticate(token, tx),
        access = await this.eligible(session.accountId, tx),
        catalog = await currentCatalog(tx),
        epoch = await retainScoreEpoch(tx);
      const scope = courseCursorScope([
        'course-directory-v1',
        session.accountId,
        session.sessionId,
        access,
        catalog.id,
        epoch,
        query.search ?? '',
        query.department ?? null,
        query.category ?? null,
        query.sort,
        query.limit,
      ]);
      const after = query.cursor
        ? await this.cursors.get(query.cursor, scope, tx)
        : null;
      if (after && after.sort !== query.sort)
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      const orderingUntil = await this.records.orderingDeadline(
        catalog.id,
        query,
        tx,
      );
      registerTransactionDeadline(
        tx,
        orderingUntil?.getTime() ?? null,
        'DISCOVERY_RESTART_REQUIRED',
      );
      const rows = await this.records.page(catalog.id, query, after, tx),
        more = rows.length > query.limit,
        chosen = rows.slice(0, query.limit),
        items = [];
      for (const row of chosen) items.push(await this.project(row, tx));
      const last = chosen.at(-1),
        nextCursor =
          more && last
            ? await this.cursors.create(
                session.accountId,
                scope,
                {
                  v: 1,
                  kind: 'course-directory-v1',
                  sort: query.sort,
                  id: last.course_id,
                  value: last.sort_value,
                  validUntil: orderingUntil?.toISOString() ?? null,
                },
                tx,
              )
            : null;
      await this.identity.session(token, tx);
      return coursePageSchema.parse({
        catalogRevision: catalog.id,
        scoreRevision: epoch,
        items,
        nextCursor,
        continuation: more ? 'more' : 'end',
      });
    });
  }
  @AccountPolicy('browse', 'entry')
  detail(token: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.authenticate(token, tx);
      await this.eligible(session.accountId, tx);
      const catalog = await currentCatalog(tx);
      await retainScoreEpoch(tx);
      const course = await this.project(
          await this.records.course(catalog.id, id, tx),
          tx,
        ),
        myScore = await this.records.own(id, session.accountId, tx);
      await this.identity.session(token, tx);
      return courseDetailSchema.parse({
        catalogRevision: catalog.id,
        course,
        myScore,
      });
    });
  }
  @AccountPolicy('browse', 'entry')
  async own(token: string, id: string) {
    return (await this.detail(token, id)).myScore;
  }
  @AccountPolicy('browse', 'entry')
  async summary(token: string, id: string) {
    return (await this.detail(token, id)).course.summary;
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  firstScore(
    token: string,
    id: string,
    command: CourseFirstScore,
  ): Promise<CourseReceipt> {
    return this.run(async (tx) => {
      const session = await this.authenticate(token, tx),
        actor = session.accountId,
        hash = courseIntentHash(actor, id, command);
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:course-request:v1:'||$1||':'||$2,0))",
        [actor, command.clientRequestId],
      );
      const prior = await this.records.prior(
        actor,
        command.clientRequestId,
        tx,
      );
      if (prior) {
        if (prior.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        await this.identity.session(token, tx);
        return courseReceiptSchema.parse(prior.receipt);
      }
      await this.eligible(actor, tx);
      const catalog = await currentCatalog(tx),
        course = await this.records.course(catalog.id, id, tx);
      await this.campus.requireCurrent(course.campus_id, tx);
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:course-first:v1:'||$1||':'||$2,0))",
        [actor, id],
      );
      const original = await this.records.score(id, actor, tx);
      let receipt: CourseReceipt;
      if (original)
        receipt = {
          requestId: command.clientRequestId,
          operation: 'course.first-score.v1',
          courseId: id,
          outcome: 'rejected',
          code: 'COURSE_ALREADY_RATED',
        };
      else if (
        catalog.id !== command.expectedCatalogRevision ||
        course.revision !== command.expectedCourseRevision
      )
        receipt = {
          requestId: command.clientRequestId,
          operation: 'course.first-score.v1',
          courseId: id,
          outcome: 'rejected',
          code: 'COURSE_REVISION_CONFLICT',
        };
      else {
        const history = await currentHistory(id, tx);
        if (!history) throw new ApplicationError('COURSE_HISTORY_UNAVAILABLE');
        const row = (
          await tx.query<{ recorded_at: Date }>(
            `INSERT INTO whaleu_ratings.course_scores(course_id,actor_id,request_id,catalog_id,course_revision,history_assertion_id,grade_half_units,ability_half_units,overall_half_units) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING recorded_at`,
            [
              id,
              actor,
              command.clientRequestId,
              catalog.id,
              course.revision,
              history.id,
              command.gradeScore * 2,
              command.abilityScore * 2,
              command.overallScore * 2,
            ],
          )
        ).rows[0]!;
        receipt = {
          requestId: command.clientRequestId,
          operation: 'course.first-score.v1',
          courseId: id,
          outcome: 'applied',
          gradeScore: command.gradeScore,
          abilityScore: command.abilityScore,
          overallScore: command.overallScore,
          recordedAt: row.recorded_at.toISOString(),
        };
      }
      await this.records.record(actor, id, command, hash, receipt, tx);
      await this.identity.session(token, tx);
      return courseReceiptSchema.parse(receipt);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  receipt(token: string, id: string) {
    return this.run(async (tx) => {
      // Historical recovery intentionally reveals only this actor's original tuple;
      // current source, phone, Safety and affiliation cannot rewrite that outcome.
      const session = await this.authenticate(token, tx),
        prior = await this.records.prior(session.accountId, id, tx);
      if (!prior) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.identity.session(token, tx);
      return courseReceiptSchema.parse(prior.receipt);
    });
  }
}
