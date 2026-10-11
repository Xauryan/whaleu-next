import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  schoolEntryDataSchema,
  schoolSaveReceiptSchema,
  schoolSnapshotHash,
  assertSchoolEntryKind,
} from './contracts.js';
import type {
  SchoolEntryData,
  SchoolEntryKey,
  SchoolSaveReceipt,
  SaveSchoolEntry,
} from './contracts.js';
import { requireSchoolCurrent } from './current-proof.js';
export interface SchoolEntryRow {
  region_id: string;
  entry_key: SchoolEntryKey;
  revision: string;
  data: SchoolEntryData;
  qr_binding_id: string | null;
  publication_hash: string;
  actor_id: string;
  grant_id: string;
  published_at: Date;
}
@Injectable()
export class SchoolConfigurationRepository {
  async entry(
    regionId: string,
    key: SchoolEntryKey,
    tx: PoolClient,
    write = false,
  ): Promise<SchoolEntryRow | null> {
    const row = (
      await tx.query<SchoolEntryRow>(
        `SELECT e.* FROM whaleu_school_configuration.entries e JOIN whaleu_school_configuration.publications p USING(region_id,entry_key,revision) WHERE e.region_id=$1 AND e.entry_key=$2 AND (e.data,e.qr_binding_id,e.publication_hash,e.actor_id,e.grant_id,e.published_at) IS NOT DISTINCT FROM (p.data,p.qr_binding_id,p.publication_hash,p.actor_id,p.grant_id,p.published_at) AND p.source='admin_publication' FOR ${write ? 'UPDATE' : 'SHARE'} OF e`,
        [regionId, key],
      )
    ).rows[0];
    if (!row) {
      if (
        (
          await tx.query(
            'SELECT 1 FROM whaleu_school_configuration.entries WHERE region_id=$1 AND entry_key=$2',
            [regionId, key],
          )
        ).rowCount
      )
        throw new ApplicationError('SCHOOL_CONFIGURATION_UNAVAILABLE');
      return null;
    }
    try {
      row.data = schoolEntryDataSchema.parse(row.data);
      assertSchoolEntryKind(key, row.data);
      if (
        !Number.isSafeInteger(Number(row.revision)) ||
        schoolSnapshotHash(
          regionId,
          key,
          Number(row.revision),
          row.data,
          row.qr_binding_id,
        ) !== row.publication_hash
      )
        throw new Error('Invalid publication');
    } catch {
      throw new ApplicationError('SCHOOL_CONFIGURATION_UNAVAILABLE');
    }
    return row;
  }
  async prove(regionId: string, key: SchoolEntryKey, tx: PoolClient) {
    await requireSchoolCurrent({ campusId: null, regionId, key }, tx);
  }
  async recover(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<SchoolSaveReceipt | null> {
    const row = (
      await tx.query<{ receipt: unknown }>(
        'SELECT receipt FROM whaleu_school_configuration.requests WHERE actor_id=$1 AND client_request_id=$2 FOR SHARE',
        [actor, requestId],
      )
    ).rows[0];
    return row ? schoolSaveReceiptSchema.parse(row.receipt) : null;
  }
  async cancelled(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<string | null> {
    return (
      (
        await tx.query<{ request_hash: string }>(
          'SELECT request_hash FROM whaleu_school_configuration.cancel_fences WHERE actor_id=$1 AND client_request_id=$2 FOR SHARE',
          [actor, requestId],
        )
      ).rows[0]?.request_hash ?? null
    );
  }
  async cancel(actor: string, requestId: string, hash: string, tx: PoolClient) {
    await tx.query(
      'INSERT INTO whaleu_school_configuration.cancel_fences(actor_id,client_request_id,request_hash) VALUES($1,$2,$3)',
      [actor, requestId, hash],
    );
  }
  async save(
    input: {
      actor: string;
      grantId: string;
      regionId: string;
      key: SchoolEntryKey;
      command: SaveSchoolEntry;
      requestHash: string;
      bindingId: string | null;
    },
    tx: PoolClient,
  ): Promise<SchoolSaveReceipt> {
    const { actor, grantId, regionId, key, command, requestHash, bindingId } =
        input,
      revision = command.expectedRevision + 1;
    const hash = schoolSnapshotHash(
      regionId,
      key,
      revision,
      command.entry,
      bindingId,
    );
    await tx.query(
      `INSERT INTO whaleu_school_configuration.publications(region_id,entry_key,revision,data,qr_binding_id,publication_hash,actor_id,grant_id) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [
        regionId,
        key,
        revision,
        JSON.stringify(command.entry),
        bindingId,
        hash,
        actor,
        grantId,
      ],
    );
    // The entry advisory lock and earlier CAS serialize both branches. An
    // upsert would fire INSERT guards before conflict handling on later revisions.
    const current = await tx.query(
      command.expectedRevision === 0
        ? `INSERT INTO whaleu_school_configuration.entries SELECT region_id,entry_key,revision,data,qr_binding_id,publication_hash,actor_id,grant_id,published_at FROM whaleu_school_configuration.publications WHERE region_id=$1 AND entry_key=$2 AND revision=$3`
        : `UPDATE whaleu_school_configuration.entries e SET revision=p.revision,data=p.data,qr_binding_id=p.qr_binding_id,publication_hash=p.publication_hash,actor_id=p.actor_id,grant_id=p.grant_id,published_at=p.published_at FROM whaleu_school_configuration.publications p WHERE p.region_id=$1 AND p.entry_key=$2 AND p.revision=$3 AND e.region_id=p.region_id AND e.entry_key=p.entry_key AND e.revision=$3-1`,
      [regionId, key, revision],
    );
    if (current.rowCount !== 1)
      throw new ApplicationError('SCHOOL_CONFIGURATION_REVISION_CONFLICT');
    const receipt = schoolSaveReceiptSchema.parse({
      requestId: command.clientRequestId,
      requestHash,
      regionId,
      entryKey: key,
      revision,
      outcome: 'saved',
    });
    await tx.query(
      `INSERT INTO whaleu_school_configuration.requests(actor_id,client_request_id,region_id,entry_key,command,request_hash,receipt) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
      [
        actor,
        command.clientRequestId,
        regionId,
        key,
        JSON.stringify(command),
        requestHash,
        JSON.stringify(receipt),
      ],
    );
    await this.prove(regionId, key, tx);
    return receipt;
  }
}
