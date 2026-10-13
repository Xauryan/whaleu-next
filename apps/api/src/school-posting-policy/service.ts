import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { DatabaseService } from '../database/database.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { validProvenance } from '../campus/community-policy/fact-validation.js';
import { ApplicationError } from '../http/application-error.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { SchoolConfigurationAccess } from '../school-configuration/access.js';
import { SchoolPostingPolicyRepository } from './repository.js';
import type { SchoolPostingRow } from './repository.js';
import {
  schoolPostingCategories,
  schoolPostingCommandHash,
  schoolPostingRecoverySchema,
  schoolPostingViewSchema,
} from './contracts.js';
import type {
  SaveSchoolPostingPolicy,
  SchoolPostingView,
} from './contracts.js';
import { requireSchoolPostingCurrent } from './current-proof.js';

/** Expired accepted evidence is shown as history; a new explicit admin command
 * may replace it. Unknown provenance, unsupported categories or related sync
 * cannot be silently normalized by this narrower owner command. */
export function projectSchoolPostingPolicy(
  row: SchoolPostingRow | null,
  now: number,
): Omit<SchoolPostingView, 'context'> {
  if (!row)
    return {
      revision: 0,
      revisionId: null,
      state: 'unconfigured',
      editable: true,
      blocker: null,
      policy: null,
    };
  const categories = row.unverified_categories;
  const effective = row.effective_at?.getTime(),
    until = row.valid_until?.getTime();
  const trusted =
    Number.isFinite(now) &&
    Number.isFinite(effective) &&
    effective <= now &&
    validProvenance(
      { ...row, expiry_kind: 'policy_exempt', valid_until: null },
      now,
    ) &&
    ((row.expiry_kind === 'policy_exempt' && row.valid_until === null) ||
      (row.expiry_kind === 'at' &&
        until !== undefined &&
        Number.isFinite(until) &&
        until > effective)) &&
    typeof row.unverified_post_enabled === 'boolean' &&
    typeof row.unverified_comment_enabled === 'boolean' &&
    typeof row.related_sync_enabled === 'boolean' &&
    Array.isArray(categories) &&
    new Set(categories).size === categories.length &&
    categories.every((c) =>
      (schoolPostingCategories as readonly string[]).includes(c),
    );
  if (!trusted)
    return {
      revision: row.revision,
      revisionId: row.id,
      state: 'unavailable',
      editable: false,
      blocker: 'untrusted_source',
      policy: null,
    };
  return {
    revision: row.revision,
    revisionId: row.id,
    state: until !== undefined && until <= now ? 'expired' : 'active',
    editable: !row.related_sync_enabled,
    blocker: row.related_sync_enabled ? 'related_sync_unsupported' : null,
    policy: {
      unverifiedPostEnabled: row.unverified_post_enabled,
      unverifiedCommentEnabled: row.unverified_comment_enabled,
      unverifiedCategories:
        categories as (typeof schoolPostingCategories)[number][],
      effectiveAt: row.effective_at.toISOString(),
      expiry:
        row.expiry_kind === 'at'
          ? { kind: 'at', validUntil: row.valid_until!.toISOString() }
          : { kind: 'policy_exempt' },
    },
  };
}
@Injectable()
export class SchoolPostingPolicyService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SchoolConfigurationAccess)
    private readonly access: SchoolConfigurationAccess,
    @Inject(SchoolPostingPolicyRepository)
    private readonly records: SchoolPostingPolicyRepository,
  ) {}
  private async run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(
        async (tx) => {
          await tx.query("SET LOCAL lock_timeout='500ms'");
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (
        error instanceof ZodError ||
        (typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['57014', '55P03', '23514'].includes(String(error.code)))
      )
        throw new ApplicationError('SCHOOL_POSTING_POLICY_UNAVAILABLE');
      throw error;
    }
  }
  @AccountPolicy('privileged_read', 'entry')
  management(token: string, regionId: string | undefined) {
    return this.run(async (tx) => {
      const context = await this.access.management(token, regionId, tx),
        row = await this.records.current(context.region.id, tx);
      const now = (
        await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]!.now.getTime();
      const view = projectSchoolPostingPolicy(row, now);
      if (view.state === 'active' && row?.valid_until)
        registerTransactionDeadline(
          tx,
          row.valid_until.getTime(),
          'SCHOOL_POSTING_POLICY_UNAVAILABLE',
        );
      await requireSchoolPostingCurrent(
        context.session.accountId,
        context.region.id,
        tx,
      );
      return schoolPostingViewSchema.parse({
        context: {
          regionId: context.region.id,
          regionName: context.region.name,
          management: context.management,
        },
        ...view,
      });
    });
  }
  @AccountPolicy('noncontent_management', 'owner_after_recovery')
  save(token: string, regionId: string, command: SaveSchoolPostingPolicy) {
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx, true);
      const context = await this.access.management(token, regionId, tx),
        actor = context.session.accountId;
      const hash = schoolPostingCommandHash(actor, regionId, command);
      await this.records.lockRequest(actor, command.clientRequestId, tx);
      const prior = await this.records.recover(
        actor,
        command.clientRequestId,
        tx,
      );
      if (prior) {
        if (prior.requestHash !== hash)
          throw new ApplicationError('SCHOOL_POSTING_POLICY_REQUEST_CONFLICT');
        return prior;
      }
      const cancelled = await this.records.cancelled(
        actor,
        command.clientRequestId,
        tx,
      );
      if (cancelled !== null)
        throw new ApplicationError(
          cancelled === hash
            ? 'SCHOOL_POSTING_POLICY_CANCELLED'
            : 'SCHOOL_POSTING_POLICY_REQUEST_CONFLICT',
        );
      const current = await this.records.current(regionId, tx, true);
      if ((current?.revision ?? 0) !== command.expectedRevision)
        throw new ApplicationError('SCHOOL_POSTING_POLICY_REVISION_CONFLICT');
      const now = (
        await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]!.now.getTime();
      if (!projectSchoolPostingPolicy(current, now).editable)
        throw new ApplicationError('SCHOOL_POSTING_POLICY_SOURCE_UNRESOLVED');
      if (command.policy.expiry.kind === 'at') {
        const until = Date.parse(command.policy.expiry.validUntil);
        if (!Number.isFinite(until) || until <= now)
          throw new BadRequestException(
            'Policy expiry must be a future UTC timestamp',
          );
        registerTransactionDeadline(
          tx,
          until,
          'SCHOOL_POSTING_POLICY_UNAVAILABLE',
        );
      }
      const receipt = await this.records.save(
        {
          actor,
          grantId: context.grant.id,
          regionId,
          previous: current,
          command,
          hash,
        },
        tx,
      );
      await requireSchoolPostingCurrent(actor, regionId, tx);
      return receipt;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancel(token: string, requestId: string, requestHash: string) {
    return this.run(async (tx) => {
      const actor = (await this.access.authenticate(token, tx)).accountId;
      await this.records.lockRequest(actor, requestId, tx);
      const receipt = await this.records.recover(actor, requestId, tx);
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new ApplicationError('SCHOOL_POSTING_POLICY_REQUEST_CONFLICT');
        return schoolPostingRecoverySchema.parse({
          state: 'recorded',
          requestId,
          receipt,
        });
      }
      const cancelled = await this.records.cancelled(actor, requestId, tx);
      if (cancelled !== null && cancelled !== requestHash)
        throw new ApplicationError('SCHOOL_POSTING_POLICY_REQUEST_CONFLICT');
      if (cancelled === null)
        await this.records.cancel(actor, requestId, requestHash, tx);
      return schoolPostingRecoverySchema.parse({
        state: 'cancelled',
        requestId,
        requestHash,
      });
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recover(token: string, requestId: string) {
    return this.run(async (tx) => {
      const actor = (await this.access.authenticate(token, tx)).accountId;
      await this.records.lockRequest(actor, requestId, tx);
      const receipt = await this.records.recover(actor, requestId, tx);
      if (receipt)
        return schoolPostingRecoverySchema.parse({
          state: 'recorded',
          requestId,
          receipt,
        });
      const cancelled = await this.records.cancelled(actor, requestId, tx);
      return schoolPostingRecoverySchema.parse(
        cancelled === null
          ? { state: 'not_recorded', requestId }
          : { state: 'cancelled', requestId, requestHash: cancelled },
      );
    });
  }
}
