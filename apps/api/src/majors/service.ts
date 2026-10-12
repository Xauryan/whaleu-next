import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { RatingVerificationFacade } from '../verification/rating-eligibility.facade.js';
import { RatingSafetyFacade } from '../safety/rating.facade.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
import { profileCountProofOwner } from '../profile/count-epochs.js';
import { ApplicationError } from '../http/application-error.js';
import { MajorDiscussionService } from './discussion/service.js';
import { MajorCursors, majorCursorScope } from './cursor.js';
import { majorCatalog, retainMajorCatalog } from './proof.js';
import {
  majorPageSchema,
  majorDetailSchema,
  majorDepartmentsSchema,
} from './contracts.js';
import type { MajorQuery } from './contracts.js';
const profiles = requiredOwnerEpoch(
  profileCountProofOwner,
  'MAJOR_CATALOG_UNAVAILABLE',
);
interface Row {
  major_id: string;
  revision: string;
  catalog_id: string;
  campus_id: string;
  department_id: number;
  college_name: string;
  major_name: string;
}
@Injectable()
export class MajorsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(MajorDiscussionService)
    private readonly discussion: MajorDiscussionService,
    @Inject(MajorCursors) private readonly cursors: MajorCursors,
  ) {}
  private run<T>(f: (tx: PoolClient) => Promise<T>) {
    return this.db
      .transaction(f, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['55P03', '40001', '40P01'].includes(String(error.code))
        )
          throw new ApplicationError('MAJOR_CATALOG_UNAVAILABLE');
        throw error;
      });
  }
  private async context(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    const session = await this.identity.session(token, tx),
      phone = await this.verification.phone(session.accountId, tx);
    if (phone.status !== 'verified')
      throw new ApplicationError(
        phone.status === 'unverified'
          ? 'PHONE_VERIFICATION_REQUIRED'
          : 'VERIFICATION_UNAVAILABLE',
      );
    await this.safety.requireAllowed(session.accountId, tx);
    const safety = await this.safety.navigation(tx),
      profile = await profiles(tx),
      capture = await majorCatalog(tx, session.accountId, session.sessionId);
    return { session, phone: phone.fingerprint, safety, profile, capture };
  }
  private async rows(catalog: string, tx: PoolClient) {
    return (
      await tx.query<Row>(
        'SELECT major_id,revision,catalog_id,campus_id,department_id,college_name,major_name FROM whaleu_majors.major_entries WHERE catalog_id=$1 AND is_active ORDER BY department_id,major_id',
        [catalog],
      )
    ).rows;
  }
  private async item(row: Row, actor: string, session: string, tx: PoolClient) {
    return {
      id: row.major_id,
      majorRevision: row.revision,
      catalogRevision: row.catalog_id,
      campusId: row.campus_id,
      departmentId: row.department_id,
      collegeName: row.college_name,
      majorName: row.major_name,
      summary: await this.discussion.summary(actor, session, row.major_id, tx),
    };
  }
  departments(token: string) {
    return this.run(async (tx) => {
      const c = await this.context(token, tx),
        rows = await this.rows(c.capture.source.catalog, tx);
      retainMajorCatalog(
        c.session.accountId,
        c.session.sessionId,
        c.capture,
        tx,
      );
      await this.identity.session(token, tx);
      return majorDepartmentsSchema.parse({
        catalogRevision: c.capture.source.catalog,
        items: [...new Set(rows.map((row) => row.department_id))].map(
          (departmentId) => ({ departmentId, name: `${departmentId}系` }),
        ),
      });
    });
  }
  page(token: string, query: MajorQuery) {
    return this.run(async (tx) => {
      const c = await this.context(token, tx),
        catalog = c.capture.source.catalog,
        keyword = query.keyword?.toLocaleLowerCase('und'),
        rows = (await this.rows(catalog, tx)).filter(
          (row) =>
            (query.departmentId === undefined ||
              row.department_id === query.departmentId) &&
            (!keyword ||
              row.major_name.toLocaleLowerCase('und').includes(keyword) ||
              row.college_name.toLocaleLowerCase('und').includes(keyword)),
        );
      const scope = majorCursorScope([
        'major-directory-v1',
        c.session.accountId,
        c.session.sessionId,
        c.capture.source,
        c.capture.epoch,
        c.capture.content,
        c.capture.review,
        c.profile,
        c.phone,
        c.safety,
        query.departmentId ?? null,
        query.keyword ?? null,
        query.limit,
      ]);
      const after = query.cursor
          ? await this.cursors.get(query.cursor, scope, tx)
          : null,
        remaining = after
          ? rows.filter(
              (row) =>
                row.department_id > after.departmentId ||
                (row.department_id === after.departmentId &&
                  row.major_id > after.id),
            )
          : rows,
        more = remaining.length > query.limit,
        chosen = remaining.slice(0, query.limit),
        last = chosen.at(-1);
      const items = [];
      for (const row of chosen)
        items.push(
          await this.item(row, c.session.accountId, c.session.sessionId, tx),
        );
      const nextCursor =
        more && last
          ? await this.cursors.create(
              c.session.accountId,
              scope,
              {
                v: 1,
                kind: 'major-directory-v1',
                id: last.major_id,
                departmentId: last.department_id,
                validUntil: c.capture.until,
              },
              tx,
            )
          : null;
      retainMajorCatalog(
        c.session.accountId,
        c.session.sessionId,
        c.capture,
        tx,
      );
      await this.identity.session(token, tx);
      return majorPageSchema.parse({
        catalogRevision: catalog,
        items,
        totalCount: rows.length,
        nextCursor,
        continuation: more ? 'more' : 'end',
      });
    });
  }
  detail(token: string, id: string) {
    return this.run(async (tx) => {
      const c = await this.context(token, tx),
        row = (await this.rows(c.capture.source.catalog, tx)).find(
          (r) => r.major_id === id,
        );
      if (!row) throw new ApplicationError('MAJOR_NOT_FOUND');
      const item = await this.item(
        row,
        c.session.accountId,
        c.session.sessionId,
        tx,
      );
      retainMajorCatalog(
        c.session.accountId,
        c.session.sessionId,
        c.capture,
        tx,
      );
      await this.identity.session(token, tx);
      return majorDetailSchema.parse({
        catalogRevision: c.capture.source.catalog,
        item,
      });
    });
  }
  related(token: string, id: string, limit: number) {
    return this.run(async (tx) => {
      const c = await this.context(token, tx),
        all = await this.rows(c.capture.source.catalog, tx),
        source = all.find((row) => row.major_id === id);
      if (!source) throw new ApplicationError('MAJOR_NOT_FOUND');
      const rows = all
          .filter((row) => row.major_id !== id)
          .sort(
            (a, b) =>
              Number(b.department_id === source.department_id) -
                Number(a.department_id === source.department_id) ||
              a.department_id - b.department_id ||
              a.major_id.localeCompare(b.major_id),
          ),
        items = [];
      for (const row of rows.slice(0, limit))
        items.push(
          await this.item(row, c.session.accountId, c.session.sessionId, tx),
        );
      retainMajorCatalog(
        c.session.accountId,
        c.session.sessionId,
        c.capture,
        tx,
      );
      await this.identity.session(token, tx);
      return majorPageSchema.parse({
        catalogRevision: c.capture.source.catalog,
        items,
        totalCount: rows.length,
        nextCursor: null,
        continuation: 'end',
      });
    });
  }
}
