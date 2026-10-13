import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { PolicyProvenance } from '../campus/community-policy/contracts.js';
import { ApplicationError } from '../http/application-error.js';
import { schoolPostingReceiptSchema } from './contracts.js';
import type {
  SaveSchoolPostingPolicy,
  SchoolPostingReceipt,
} from './contracts.js';
export interface SchoolPostingRow extends PolicyProvenance {
  id: string;
  region_id: string;
  revision: number;
  unverified_post_enabled: boolean;
  unverified_comment_enabled: boolean;
  unverified_categories: string[];
  related_sync_enabled: boolean;
}
@Injectable()
export class SchoolPostingPolicyRepository {
  async current(
    regionId: string,
    tx: PoolClient,
    write = false,
  ): Promise<SchoolPostingRow | null> {
    const head = (
      await tx.query<{ revision: number; revision_id: string | null }>(
        `SELECT revision,revision_id FROM whaleu_community.region_policy_heads WHERE region_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [regionId],
      )
    ).rows[0];
    if (!head || (head.revision === 0 && head.revision_id === null))
      return null;
    const row = (
      await tx.query<SchoolPostingRow>(
        'SELECT * FROM whaleu_community.region_policy_revisions WHERE id=$1 AND region_id=$2 AND revision=$3',
        [head.revision_id, regionId, head.revision],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('SCHOOL_POSTING_POLICY_UNAVAILABLE');
    return row;
  }
  async lockRequest(actor: string, requestId: string, tx: PoolClient) {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('whaleu:school-posting-policy-request:v1:'||$1||':'||$2,0))`,
      [actor, requestId],
    );
  }
  async recover(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<SchoolPostingReceipt | null> {
    const row = (
      await tx.query<{ receipt: unknown }>(
        'SELECT receipt FROM whaleu_community.region_policy_commands WHERE actor_id=$1 AND client_request_id=$2 FOR SHARE',
        [actor, requestId],
      )
    ).rows[0];
    return row ? schoolPostingReceiptSchema.parse(row.receipt) : null;
  }
  async cancelled(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<string | null> {
    return (
      (
        await tx.query<{ request_hash: string }>(
          'SELECT request_hash FROM whaleu_community.region_policy_cancellations WHERE actor_id=$1 AND client_request_id=$2 FOR SHARE',
          [actor, requestId],
        )
      ).rows[0]?.request_hash ?? null
    );
  }
  async cancel(actor: string, requestId: string, hash: string, tx: PoolClient) {
    await tx.query(
      'INSERT INTO whaleu_community.region_policy_cancellations(actor_id,client_request_id,request_hash) VALUES($1,$2,$3)',
      [actor, requestId, hash],
    );
  }
  async save(
    input: {
      actor: string;
      grantId: string;
      regionId: string;
      previous: SchoolPostingRow | null;
      command: SaveSchoolPostingPolicy;
      hash: string;
    },
    tx: PoolClient,
  ): Promise<SchoolPostingReceipt> {
    const { actor, grantId, regionId, previous, command, hash } = input,
      revision = command.expectedRevision + 1,
      id = randomUUID(),
      policy = command.policy;
    await tx.query(
      'INSERT INTO whaleu_community.region_policy_heads(region_id) VALUES($1) ON CONFLICT(region_id) DO NOTHING',
      [regionId],
    );
    await tx.query(
      `INSERT INTO whaleu_community.region_policy_revisions(id,region_id,revision,coverage_state,provenance_state,source_reference,policy_reference,unverified_post_enabled,unverified_comment_enabled,unverified_categories,related_sync_enabled,effective_at,expiry_kind,valid_until,school_admin_publication_transaction)
      VALUES($1,$2,$3,'complete','accepted',$4,$10,$5,$6,$7,$11,clock_timestamp(),$8,$9,pg_current_xact_id())`,
      [
        id,
        regionId,
        revision,
        `whaleu:school-posting-command:v${'version' in command ? 2 : 1}:${actor}:${command.clientRequestId}`,
        policy.unverifiedPostEnabled,
        policy.unverifiedCommentEnabled,
        policy.unverifiedCategories,
        policy.expiry.kind,
        policy.expiry.kind === 'at' ? policy.expiry.validUntil : null,
        'version' in command
          ? 'whaleu:school-posting-policy:v2'
          : 'whaleu:school-posting-policy:v1',
        'version' in command ? command.policy.relatedSyncEnabled : false,
      ],
    );
    const updated = await tx.query(
      'UPDATE whaleu_community.region_policy_heads SET revision=$2,revision_id=$3 WHERE region_id=$1 AND revision=$4',
      [regionId, revision, id, command.expectedRevision],
    );
    if (updated.rowCount !== 1)
      throw new ApplicationError('SCHOOL_POSTING_POLICY_REVISION_CONFLICT');
    const receipt = schoolPostingReceiptSchema.parse({
      requestId: command.clientRequestId,
      requestHash: hash,
      regionId,
      revision,
      revisionId: id,
      outcome: 'saved',
    });
    await tx.query(
      `INSERT INTO whaleu_community.region_policy_commands(actor_id,client_request_id,grant_id,region_id,previous_revision_id,revision_id,revision,command,request_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)`,
      [
        actor,
        command.clientRequestId,
        grantId,
        regionId,
        previous?.id ?? null,
        id,
        revision,
        JSON.stringify(command),
        hash,
        JSON.stringify(receipt),
      ],
    );
    return receipt;
  }
}
