import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerTransactionDeadline,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import {
  budgetedClient,
  configuredTimeout,
} from '../database/optional-count.js';
import { ApplicationError } from '../http/application-error.js';
import { canonicalJson } from '../community/content-review/contracts.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ProfileAdminParticipantFacade } from '../profile/admin-participant.facade.js';
import { fenceProfileAdminReads } from '../profile/count-epochs.js';
import { SafetyErrandManagementFacade } from '../safety/errand-management/facade.js';
import type {
  StoredErrandRestriction,
  StoredErrandRestrictionEvent,
} from '../safety/errand-management/contracts.js';
import { ErrandNotificationsFacade } from '../notifications/errand.facade.js';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../community/discovery-continuation.module.js';
import { ErrandAccessService } from './access.js';
import { errandManagementFailure } from './admin-command-service.js';
import {
  errandRestrictionReceiptSchema,
  errandRestrictionRejectionSchema,
  errandRestrictionsPageSchema,
  errandRestrictionHistorySchema,
  errandRestrictionViewSchema,
  errandRestrictionEventSchema,
} from './admin-command-contracts.js';
import type {
  IssueErrandRestriction,
  ReleaseErrandRestriction,
  ErrandRestrictionReceipt,
  ErrandRestrictionsQuery,
  ErrandRestrictionHistoryQuery,
} from './admin-command-contracts.js';
const positionSchema = z.strictObject({
  v: z.literal(1),
  checkedAt: z.iso.datetime({ precision: 6 }),
  validUntil: z.number().finite(),
  sourceVersion: z.string().regex(/^(0|[1-9][0-9]*)$/),
  after: z
    .strictObject({
      recordedAt: z.iso.datetime({ precision: 6 }),
      id: z.uuid(),
    })
    .nullable(),
});
type Position = z.infer<typeof positionSchema>;
type Profiles = Awaited<ReturnType<ProfileAdminParticipantFacade['batch']>>;
@Injectable()
export class ErrandRestrictionService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ErrandAccessService) private readonly access: ErrandAccessService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(ProfileAdminParticipantFacade)
    private readonly profiles: ProfileAdminParticipantFacade,
    @Inject(SafetyErrandManagementFacade)
    private readonly safety: SafetyErrandManagementFacade,
    @Inject(ErrandNotificationsFacade)
    private readonly notices: ErrandNotificationsFacade,
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
  ) {}
  issue(token: string, body: IssueErrandRestriction) {
    return this.execute(token, 'issue', body);
  }
  release(
    token: string,
    restrictionId: string,
    body: ReleaseErrandRestriction,
  ) {
    return this.execute(token, 'release', body, restrictionId);
  }
  private async execute(
    token: string,
    operation: 'issue' | 'release',
    body: IssueErrandRestriction | ReleaseErrandRestriction,
    restrictionId?: string,
  ): Promise<ErrandRestrictionReceipt> {
    try {
      return await this.db.transaction(
        async (tx) => {
          await tx.query(
            "SELECT set_config('lock_timeout',CASE WHEN current_setting('lock_timeout')::interval=interval '0' OR current_setting('lock_timeout')::interval>interval '1 second' THEN '1000ms' ELSE current_setting('lock_timeout') END,true)",
          );
          const session = await this.access.common(token, tx, true),
            grant = await this.authorization.requireGlobalErrandManagement(
              session.accountId,
              tx,
            );
          const context = {
            actorId: session.accountId,
            sessionId: session.sessionId,
            grantId: grant.id,
            requestId: body.clientRequestId,
            kind: 'global' as const,
            operation,
          };
          const intent =
            operation === 'issue'
              ? { command: body }
              : { restrictionId, command: body };
          const hash = createHash('sha256')
            .update(
              'whaleu:errand-restriction-command:v1\n' +
                canonicalJson({ operation, intent }),
            )
            .digest('hex');
          const prior = await this.safety.beginGlobalRequest(
            context,
            hash,
            intent,
            tx,
          );
          if (prior) {
            const result = errandRestrictionReceiptSchema.parse(prior);
            await this.access.recheck(token, tx);
            return result;
          }
          const checkpoint = checkpointTransactionDeadlines(tx);
          await tx.query('SAVEPOINT errand_global_command');
          let receipt: ErrandRestrictionReceipt;
          try {
            let result: Awaited<
              ReturnType<SafetyErrandManagementFacade['issue']>
            >;
            if (operation === 'issue' && 'targetProfileId' in body) {
              const subject = await this.profiles.resolve(
                body.targetProfileId,
                tx,
              );
              if (!subject)
                throw new ApplicationError(
                  'ERRAND_RESTRICTION_TARGET_NOT_FOUND',
                );
              await this.authorization.requireUnprotectedErrandTarget(
                subject.accountId,
                tx,
              );
              result = await this.safety.issue(
                context,
                {
                  subjectId: subject.accountId,
                  action: body.action,
                  reason: body.reason,
                  duration: body.duration,
                },
                tx,
              );
            } else
              result = await this.safety.release(
                context,
                { restrictionId: restrictionId!, reason: body.reason },
                tx,
              );
            await this.notices.recordFeature(result.notice, tx);
            receipt = {
              requestId: body.clientRequestId,
              operation,
              outcome: 'applied',
              restrictionId: result.restrictionId,
              eventId: result.eventId,
              occurredAt: result.occurredAt,
            };
          } catch (error) {
            if (
              !(error instanceof ApplicationError) ||
              !errandRestrictionRejectionSchema.safeParse(error.code).success
            )
              throw error;
            await tx.query('ROLLBACK TO SAVEPOINT errand_global_command');
            restoreTransactionDeadlines(tx, checkpoint);
            receipt = {
              requestId: body.clientRequestId,
              operation,
              outcome: 'rejected',
              code: errandRestrictionRejectionSchema.parse(error.code),
            };
          }
          await tx.query('RELEASE SAVEPOINT errand_global_command');
          const result = errandRestrictionReceiptSchema.parse(receipt);
          await this.safety.finishGlobalRequest(
            session.accountId,
            body.clientRequestId,
            result,
            tx,
          );
          await this.access.recheck(token, tx);
          return result;
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      return errandManagementFailure(error);
    }
  }
  async receipt(
    token: string,
    requestId: string,
  ): Promise<ErrandRestrictionReceipt> {
    try {
      return await this.db.transaction(
        async (tx) => {
          const session = await this.access.common(token, tx);
          await this.authorization.requireGlobalErrandManagement(
            session.accountId,
            tx,
          );
          const row = await this.safety.readGlobalRequest(
            session.accountId,
            requestId,
            tx,
          );
          if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
          const result = errandRestrictionReceiptSchema.parse(row);
          await this.access.recheck(token, tx);
          return result;
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      return errandManagementFailure(error);
    }
  }
  private participant(facts: Profiles, accountId: string) {
    const value = facts.get(accountId);
    if (!value) throw new ApplicationError('ERRAND_UNAVAILABLE');
    return value;
  }
  private restriction(row: StoredErrandRestriction, facts: Profiles) {
    return errandRestrictionViewSchema.parse({
      restrictionId: row.id,
      subject: this.participant(facts, row.subjectId),
      action: row.action,
      reason: row.reason,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      state: row.state,
      origin: row.origin,
      recordedAt: row.recordedAt,
      operator: row.actorId
        ? this.participant(facts, row.actorId)
        : { status: 'unknown' },
      source:
        row.origin === 'baseline'
          ? { kind: 'unknown' }
          : row.sourceOrderId
            ? { kind: 'order', orderId: row.sourceOrderId }
            : { kind: 'global' },
      terminal: row.terminal,
    });
  }
  private event(row: StoredErrandRestrictionEvent, facts: Profiles) {
    return errandRestrictionEventSchema.parse({
      eventId: row.id,
      kind: row.kind,
      effectiveAt: row.effectiveAt,
      recordedAt: row.recordedAt,
      reason: row.reason,
      operator: row.actorId
        ? this.participant(facts, row.actorId)
        : { status: 'unknown' },
      replacementRestrictionId: row.replacementRestrictionId,
    });
  }
  private retainProfiles(
    ids: readonly string[],
    facts: Profiles,
    tx: PoolClient,
  ) {
    const witness = JSON.stringify([...facts]);
    const proof: RequiredTransactionProof<string> = {
      maximumFacts: 1,
      failureCode: 'ERRAND_UNAVAILABLE',
      validate: async ([expected], client) => {
        const end = performance.now() + 500;
        try {
          const settings = (
            await client.query<{
              statement_timeout: string;
              lock_timeout: string;
            }>(
              "SELECT current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout",
            )
          ).rows[0]!;
          const read = budgetedClient(
            client,
            end,
            configuredTimeout(settings.statement_timeout),
            Math.min(1, configuredTimeout(settings.lock_timeout)),
          );
          await fenceProfileAdminReads(read);
          const current = await this.profiles.batch(ids, read);
          if (
            performance.now() >= end ||
            JSON.stringify([...current]) !== expected
          )
            throw new ApplicationError('ERRAND_UNAVAILABLE');
          await client.query(
            "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
            [settings.statement_timeout, settings.lock_timeout],
          );
        } catch {
          throw new ApplicationError('ERRAND_UNAVAILABLE');
        }
      },
    };
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(tx, proof, 'public-profiles', witness);
  }
  private async position(
    cursor: string | undefined,
    scope: string,
    tx: PoolClient,
  ): Promise<Position> {
    const now = await this.safety.checkedAt(tx),
      version = await this.safety.sourceVersion(tx);
    const position = cursor
      ? await this.cursors
          .get(cursor, scope, tx, (v) => positionSchema.parse(v))
          .catch((error: unknown) => {
            if (error instanceof BadRequestException)
              throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
            throw error;
          })
      : {
          v: 1 as const,
          checkedAt: now,
          validUntil: Date.parse(now) + 300000,
          sourceVersion: version,
          after: null,
        };
    if (
      position.sourceVersion !== version ||
      position.validUntil <= Date.parse(now) ||
      Date.parse(position.checkedAt) > Date.parse(now) ||
      position.validUntil > Date.parse(position.checkedAt) + 300000
    )
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    registerTransactionDeadline(
      tx,
      position.validUntil,
      'DISCOVERY_RESTART_REQUIRED',
    );
    return position;
  }
  private horizon(position: Position, horizon: string | null, tx: PoolClient) {
    if (horizon !== null)
      position.validUntil = Math.min(position.validUntil, Date.parse(horizon));
    registerTransactionDeadline(
      tx,
      position.validUntil,
      'DISCOVERY_RESTART_REQUIRED',
    );
  }
  async list(token: string, query: ErrandRestrictionsQuery) {
    try {
      return await this.db.transaction(
        async (tx) => {
          const session = await this.access.common(token, tx),
            grant = await this.authorization.requireGlobalErrandManagement(
              session.accountId,
              tx,
            );
          let subjectId: string | undefined;
          if (query.targetProfileId) {
            const subject = await this.profiles.resolve(
              query.targetProfileId,
              tx,
            );
            if (!subject)
              throw new ApplicationError(
                query.cursor
                  ? 'DISCOVERY_RESTART_REQUIRED'
                  : 'ERRAND_RESTRICTION_TARGET_NOT_FOUND',
              );
            subjectId = subject.accountId;
          }
          const scope = discoveryContinuationScope([
            'errand-restrictions-v1',
            session.accountId,
            session.sessionId,
            grant.id,
            {
              targetProfileId: query.targetProfileId ?? null,
              subjectId: subjectId ?? null,
              action: query.action ?? null,
              state: query.state,
              limit: query.limit,
            },
          ]);
          const position = await this.position(query.cursor, scope, tx);
          const filter = {
            ...(subjectId ? { subjectId } : {}),
            ...(query.action ? { action: query.action } : {}),
            checkedAt: position.checkedAt,
            state: query.state,
          };
          this.horizon(
            position,
            await this.safety.restrictionHorizon(filter, tx),
            tx,
          );
          const total = await this.safety.countRestrictions(filter, tx);
          const rows = await this.safety.listRestrictions(
              {
                ...filter,
                limit: query.limit,
                ...(position.after ? { after: position.after } : {}),
              },
              tx,
            ),
            page = rows.slice(0, query.limit);
          const ids = [
            ...new Set(
              page.flatMap((r) => [
                r.subjectId,
                ...(r.actorId ? [r.actorId] : []),
              ]),
            ),
          ];
          const facts = await this.profiles.batch(ids, tx);
          this.retainProfiles(ids, facts, tx);
          const last = page.at(-1),
            nextCursor =
              rows.length > query.limit && last
                ? await this.cursors.create(
                    scope,
                    session.accountId,
                    {
                      ...position,
                      after: { recordedAt: last.recordedAt, id: last.id },
                    },
                    tx,
                  )
                : null;
          await this.access.recheck(token, tx);
          return errandRestrictionsPageSchema.parse({
            items: page.map((r) => this.restriction(r, facts)),
            continuation: nextCursor ? 'more' : 'end',
            nextCursor,
            recordedTotal: total,
            historyCoverage: 'unknown_before_boundary',
          });
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      return errandManagementFailure(error);
    }
  }
  async history(
    token: string,
    restrictionId: string,
    query: ErrandRestrictionHistoryQuery,
  ) {
    try {
      return await this.db.transaction(
        async (tx) => {
          const session = await this.access.common(token, tx),
            grant = await this.authorization.requireGlobalErrandManagement(
              session.accountId,
              tx,
            );
          const scope = discoveryContinuationScope([
            'errand-restriction-history-v1',
            session.accountId,
            session.sessionId,
            grant.id,
            restrictionId,
            query.limit,
          ]);
          const position = await this.position(query.cursor, scope, tx),
            restriction = await this.safety.readRestriction(
              restrictionId,
              position.checkedAt,
              tx,
            );
          if (!restriction)
            throw new ApplicationError('ERRAND_RESTRICTION_NOT_FOUND');
          this.horizon(
            position,
            await this.safety.restrictionHorizon(
              {
                subjectId: restriction.subjectId,
                action: restriction.action,
                checkedAt: position.checkedAt,
              },
              tx,
            ),
            tx,
          );
          const rows = await this.safety.listEvents(
              restrictionId,
              {
                checkedAt: position.checkedAt,
                limit: query.limit,
                ...(position.after ? { after: position.after } : {}),
              },
              tx,
            ),
            page = rows.slice(0, query.limit);
          const ids = [
            ...new Set([
              restriction.subjectId,
              ...(restriction.actorId ? [restriction.actorId] : []),
              ...page.flatMap((e) => (e.actorId ? [e.actorId] : [])),
            ]),
          ];
          const facts = await this.profiles.batch(ids, tx);
          this.retainProfiles(ids, facts, tx);
          const last = page.at(-1),
            nextCursor =
              rows.length > query.limit && last
                ? await this.cursors.create(
                    scope,
                    session.accountId,
                    {
                      ...position,
                      after: { recordedAt: last.recordedAt, id: last.id },
                    },
                    tx,
                  )
                : null;
          await this.access.recheck(token, tx);
          return errandRestrictionHistorySchema.parse({
            restriction: this.restriction(restriction, facts),
            events: page.map((e) => this.event(e, facts)),
            continuation: nextCursor ? 'more' : 'end',
            nextCursor,
            historyCoverage: 'unknown_before_boundary',
          });
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      return errandManagementFailure(error);
    }
  }
}
