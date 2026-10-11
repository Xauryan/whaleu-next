import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { SchoolConfigurationAccess } from './access.js';
import { SchoolConfigurationRepository } from './repository.js';
import type { SchoolEntryRow } from './repository.js';
import { SchoolQrMediaService } from './media/facade.js';
import { lockSchoolConfigurationEntry } from './current-proof.js';
import {
  schoolEntryKeys,
  publicSchoolEntryKeys,
  assertSchoolEntryKind,
  schoolCommandHash,
  schoolPublicViewSchema,
  schoolManagementViewSchema,
  schoolCapabilitiesSchema,
  schoolRecoverySchema,
  schoolEntryViewSchema,
} from './contracts.js';
import type {
  SchoolEntryKey,
  SchoolEntryView,
  SaveSchoolEntry,
} from './contracts.js';

export function projectSchoolEntry(
  key: SchoolEntryKey,
  row: SchoolEntryRow | null,
  management = false,
): SchoolEntryView {
  if (!row)
    return schoolEntryViewSchema.parse({
      entryKey: key,
      revision: 0,
      state: 'unconfigured',
      data: null,
      qrcode: { status: 'none' },
    });
  const data = row.data,
    qr = row.qr_binding_id !== null;
  const complete =
    data.kind === 'group'
      ? !!data.name.trim() && qr && data.maxGroupNumber !== null
      : data.kind === 'official_account'
        ? !!data.name.trim() && qr
        : !!data.wechatId || qr;
  return schoolEntryViewSchema.parse({
    entryKey: key,
    revision: Number(row.revision),
    state: !data.enabled ? 'disabled' : complete ? 'configured' : 'partial',
    data: management || data.enabled ? data : null,
    qrcode: {
      status: (management || data.enabled) && qr ? 'configured' : 'none',
    },
  });
}
@Injectable()
export class SchoolConfigurationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SchoolConfigurationAccess)
    private readonly access: SchoolConfigurationAccess,
    @Inject(SchoolConfigurationRepository)
    private readonly records: SchoolConfigurationRepository,
    @Inject(SchoolQrMediaService) private readonly media: SchoolQrMediaService,
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
          ['57014', '55P03'].includes(String(error.code)))
      )
        throw new ApplicationError('SCHOOL_CONFIGURATION_UNAVAILABLE');
      throw error;
    }
  }
  capabilities(token: string) {
    return this.run(async (tx) =>
      schoolCapabilitiesSchema.parse(await this.access.capabilities(token, tx)),
    );
  }
  public(token: string | null, campusId: string) {
    return this.run(async (tx) => {
      const context = await this.access.browse(token, campusId, tx),
        entries: SchoolEntryView[] = [];
      for (const key of publicSchoolEntryKeys) {
        if (context.region)
          await lockSchoolConfigurationEntry(context.region.id, key, tx, false);
        const row = context.region
          ? await this.records.entry(context.region.id, key, tx)
          : null;
        entries.push(projectSchoolEntry(key, row));
        if (context.region)
          await this.records.prove(context.region.id, key, tx);
      }
      return schoolPublicViewSchema.parse({
        context: {
          campusId: context.campus.id,
          campusName: context.campus.fullName,
          region: context.region
            ? { id: context.region.id, name: context.region.name }
            : null,
        },
        entries,
      });
    });
  }
  management(token: string, regionId: string | undefined) {
    return this.run(async (tx) => {
      const context = await this.access.management(token, regionId, tx),
        entries: SchoolEntryView[] = [];
      for (const key of schoolEntryKeys) {
        await lockSchoolConfigurationEntry(context.region.id, key, tx, false);
        entries.push(
          projectSchoolEntry(
            key,
            await this.records.entry(context.region.id, key, tx),
            true,
          ),
        );
        await this.records.prove(context.region.id, key, tx);
      }
      return schoolManagementViewSchema.parse({
        context: {
          regionId: context.region.id,
          regionName: context.region.name,
          management: context.management,
        },
        entries,
      });
    });
  }
  save(
    token: string,
    regionId: string,
    key: SchoolEntryKey,
    command: SaveSchoolEntry,
  ) {
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx, true);
      try {
        assertSchoolEntryKind(key, command.entry);
      } catch {
        throw new BadRequestException('Entry kind does not match its key');
      }
      const context = await this.access.management(token, regionId, tx),
        actor = context.session.accountId;
      const hash = schoolCommandHash(actor, regionId, key, command);
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('whaleu:school-configuration-request:v1:'||$1||':'||$2,0))`,
        [actor, command.clientRequestId],
      );
      const prior = await this.records.recover(
        actor,
        command.clientRequestId,
        tx,
      );
      if (prior) {
        if (prior.requestHash !== hash)
          throw new ApplicationError('SCHOOL_CONFIGURATION_REQUEST_CONFLICT');
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
            ? 'SCHOOL_CONFIGURATION_CANCELLED'
            : 'SCHOOL_CONFIGURATION_REQUEST_CONFLICT',
        );
      await lockSchoolConfigurationEntry(regionId, key, tx);
      const current = await this.records.entry(regionId, key, tx, true);
      if (Number(current?.revision ?? 0) !== command.expectedRevision)
        throw new ApplicationError('SCHOOL_CONFIGURATION_REVISION_CONFLICT');
      const bindingId = await this.media.mutate(
        {
          actorAccountId: actor,
          regionId,
          entryKey: key,
          expectedRevision: command.expectedRevision,
          currentBindingId: current?.qr_binding_id ?? null,
          ...command.qrcode,
        },
        tx,
      );
      return this.records.save(
        {
          actor,
          grantId: context.grant.id,
          regionId,
          key,
          command,
          requestHash: hash,
          bindingId,
        },
        tx,
      );
    });
  }
  cancel(token: string, requestId: string, requestHash: string) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx),
        actor = session.accountId;
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('whaleu:school-configuration-request:v1:'||$1||':'||$2,0))`,
        [actor, requestId],
      );
      const receipt = await this.records.recover(actor, requestId, tx);
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new ApplicationError('SCHOOL_CONFIGURATION_REQUEST_CONFLICT');
        return schoolRecoverySchema.parse({
          state: 'recorded',
          requestId,
          receipt,
        });
      }
      const cancelled = await this.records.cancelled(actor, requestId, tx);
      if (cancelled !== null && cancelled !== requestHash)
        throw new ApplicationError('SCHOOL_CONFIGURATION_REQUEST_CONFLICT');
      if (cancelled === null)
        await this.records.cancel(actor, requestId, requestHash, tx);
      return schoolRecoverySchema.parse({
        state: 'cancelled',
        requestId,
        requestHash,
      });
    });
  }
  recover(token: string, requestId: string) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx);
      const receipt = await this.records.recover(
        session.accountId,
        requestId,
        tx,
      );
      // A receipt is historical metadata only. Revocation removes write/read authority,
      // but cannot erase the owner's answer to an already submitted command.
      const cancelled = receipt
        ? null
        : await this.records.cancelled(session.accountId, requestId, tx);
      return schoolRecoverySchema.parse(
        receipt
          ? { state: 'recorded', requestId, receipt }
          : cancelled
            ? { state: 'cancelled', requestId, requestHash: cancelled }
            : { state: 'not_recorded', requestId },
      );
    });
  }
}
