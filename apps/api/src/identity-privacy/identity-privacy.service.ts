import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { CommunityContentIdentityService } from '../community/content-identity.service.js';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { identityAt, identityBatchSchema } from './contracts.js';
import type {
  IdentityBatch,
  IdentityBatchItem,
  IdentityBatchView,
  PrivateIdentitySnapshot,
} from './contracts.js';
import { IdentityAuditRepository } from './identity-audit.repository.js';
import type { IdentityAuditEntry } from './identity-audit.repository.js';
import { PrivateIdentityRepository } from './private-identity.repository.js';

async function databaseTime(transaction: PoolClient): Promise<number> {
  return (
    await transaction.query<{ now: Date }>('SELECT clock_timestamp() AS now')
  ).rows[0]!.now.getTime();
}
function elapsed(deadline: number | null, now: number): boolean {
  return deadline !== null && deadline <= now;
}

@Injectable()
export class IdentityPrivacyService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(CommunityContentIdentityService)
    private readonly owners: CommunityContentIdentityService,
    @Inject(PrivateIdentityRepository)
    private readonly identities: PrivateIdentityRepository,
    @Inject(IdentityAuditRepository)
    private readonly audit: IdentityAuditRepository,
  ) {}

  async view(
    token: string,
    body: IdentityBatch,
    requestId: string,
  ): Promise<IdentityBatchView> {
    const parsed = identityBatchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const targets = parsed.data.targets;
    const batchId = randomUUID();
    const outcome = await this.database.transaction(async (transaction) => {
      await lockSafetyPolicy(transaction);
      // These facades hold session/account/token and grant/scope locks until COMMIT.
      // Their captured deadlines permit a pure final decision without reopening rows.
      const actor = await this.identity.session(token, transaction);
      const grant = (
        await this.authorization.grants(actor.accountId, transaction)
      ).find((candidate) => candidate.role === 'developer');
      const entries = (
        result: 'denied' | 'unavailable',
      ): IdentityAuditEntry[] =>
        targets.map((target) => ({
          batchId,
          actorAccountId: actor.accountId,
          sessionId: actor.sessionId,
          grantId: grant?.id ?? null,
          requestId,
          target,
          outcome: result,
          fields: [],
        }));
      if (!grant) {
        await this.audit.append(entries('denied'), transaction);
        return { error: 'AUTHORIZATION_REQUIRED' } as const;
      }
      if (
        typeof actor.expiresAt !== 'number' ||
        !Number.isFinite(actor.expiresAt) ||
        (grant.validUntil !== null &&
          (typeof grant.validUntil !== 'number' ||
            !Number.isFinite(grant.validUntil)))
      ) {
        throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
      }
      const items: IdentityBatchItem[] = [];
      const snapshots: (PrivateIdentitySnapshot | null)[] = [];
      try {
        for (const target of targets) {
          // Only stored content resolves owner IDs; no caller-supplied identity inputs.
          const owner = await this.owners.resolve(
            target,
            actor.accountId,
            transaction,
          );
          const snapshot = owner
            ? await this.identities.snapshot(owner.accountId, transaction)
            : null;
          snapshots.push(snapshot);
          items.push(
            owner && snapshot
              ? {
                  target,
                  status: 'available',
                  authorMode: owner.authorMode,
                  identity: snapshot.identity,
                }
              : { target, status: 'unavailable' },
          );
        }
      } catch {
        await this.audit.append(entries('unavailable'), transaction);
        return { error: 'IDENTITY_VIEW_UNAVAILABLE' } as const;
      }
      const beforeAudit = await databaseTime(transaction);
      if (elapsed(actor.expiresAt, beforeAudit)) {
        await this.audit.append(entries('denied'), transaction);
        return { error: 'ACCESS_TOKEN_EXPIRED' } as const;
      }
      if (elapsed(grant.validUntil, beforeAudit)) {
        await this.audit.append(entries('denied'), transaction);
        return { error: 'AUTHORIZATION_REQUIRED' } as const;
      }
      // Later target waits may have crossed an earlier number's expiry. Project
      // the held snapshot at one common time; never reread profiles/missing heads.
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        if (item.status === 'available')
          items[index] = {
            ...item,
            identity: identityAt(snapshots[index]!, beforeAudit),
          };
      }
      await this.audit.append(
        items.map((item): IdentityAuditEntry => ({
          batchId,
          actorAccountId: actor.accountId,
          sessionId: actor.sessionId,
          grantId: grant.id,
          requestId,
          target: item.target,
          outcome: item.status === 'available' ? 'disclosed' : 'unavailable',
          fields:
            item.status === 'available'
              ? [
                  'accountId',
                  ...(item.identity.nickname !== null
                    ? ['nickname' as const]
                    : []),
                  ...(item.identity.studentNumberStatus === 'verified'
                    ? ['studentNumber' as const]
                    : []),
                ]
              : [],
        })),
        transaction,
      );
      // Flush deferred audit/foreign-key work BEFORE the final clock, including
      // any associated lock waits. No SQL/read/provider operation follows this
      // clock inside this owner; the transaction wrapper subsequently flushes
      // and checks all registered bounds again at its true final clock.
      await transaction.query('SET CONSTRAINTS ALL IMMEDIATE');
      const decisionAt = await databaseTime(transaction);
      if (elapsed(actor.expiresAt, decisionAt))
        throw new ApplicationError('ACCESS_TOKEN_EXPIRED');
      if (elapsed(grant.validUntil, decisionAt))
        throw new ApplicationError('AUTHORIZATION_REQUIRED');
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        if (
          item.status === 'available' &&
          item.identity.studentNumberStatus === 'verified' &&
          elapsed(snapshots[index]!.validUntil, decisionAt)
        ) {
          // Abort, rather than silently alter an already-audited field selection.
          throw new ApplicationError('IDENTITY_VIEW_UNAVAILABLE');
        }
      }
      // The database wrapper owns the final transaction clock; preserve every
      // actually disclosed held bound across its final deferred-constraint flush.
      registerTransactionDeadline(
        transaction,
        grant.validUntil,
        'AUTHORIZATION_REQUIRED',
      );
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!;
        if (
          item.status === 'available' &&
          item.identity.studentNumberStatus === 'verified'
        )
          registerTransactionDeadline(
            transaction,
            snapshots[index]!.validUntil,
            'IDENTITY_VIEW_UNAVAILABLE',
          );
      }
      return { items };
    });
    // Only committed metadata can accompany a returned payload. Pre-disclosure
    // denials persist attempt metadata; final elapsed authority aborts its audit.
    if ('error' in outcome) throw new ApplicationError(outcome.error);
    return outcome;
  }
}
