import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { CommunityContentIdentityService } from '../community/content-identity.service.js';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { identityBatchSchema } from './contracts.js';
import type {
  IdentityBatch,
  IdentityBatchItem,
  IdentityBatchView,
} from './contracts.js';
import { IdentityAuditRepository } from './identity-audit.repository.js';
import type { IdentityAuditEntry } from './identity-audit.repository.js';
import { PrivateIdentityRepository } from './private-identity.repository.js';

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
      const items: IdentityBatchItem[] = [];
      try {
        for (const target of targets) {
          // The content module resolves the owner from stored content and enforces ordinary visibility.
          // The caller can never supply an account ID, student number, region, or author mode.
          const owner = await this.owners.resolve(
            target,
            actor.accountId,
            transaction,
          );
          const identity = owner
            ? await this.identities.resolve(owner.accountId, transaction)
            : null;
          items.push(
            owner && identity
              ? {
                  target,
                  status: 'available',
                  authorMode: owner.authorMode,
                  identity,
                }
              : { target, status: 'unavailable' },
          );
        }
      } catch {
        await this.audit.append(entries('unavailable'), transaction);
        return { error: 'IDENTITY_VIEW_UNAVAILABLE' } as const;
      }
      // Bounded batch work may still cross an expiry: authenticate and check current grant again.
      await this.identity.session(token, transaction);
      if (
        !(await this.authorization.grants(actor.accountId, transaction)).some(
          (current) => current.id === grant.id && current.role === 'developer',
        )
      ) {
        await this.audit.append(entries('denied'), transaction);
        return { error: 'AUTHORIZATION_REQUIRED' } as const;
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
      return { items };
    });
    // Wait for the audit transaction COMMIT before returning any identity, including partial batches.
    // Denials are thrown outside the transaction so denial metadata is committed rather than rolled back.
    if ('error' in outcome) throw new ApplicationError(outcome.error);
    return outcome;
  }
}
