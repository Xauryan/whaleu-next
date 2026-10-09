import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { SafetyRepository } from './repository.js';
import type { StoredBlock } from './repository.js';
import { lockNamedPair } from './locks.js';

type Fact =
  | { kind: 'actor'; actor: string; fingerprint: string }
  | { kind: 'named'; actor: string; peer: string; fingerprint: string }
  | { kind: 'own'; actor: string; peer: string; fingerprint: string };
async function snapshot(
  actor: string,
  peer: string | null,
  kind: Fact['kind'],
  tx: PoolClient,
) {
  const outgoing =
    kind === 'actor'
      ? 'NULL'
      : '(SELECT jsonb_build_array(id,active,revision::text) FROM whaleu_safety.blocks WHERE blocker_id=$2 AND blocked_id=$4)';
  const incoming =
    kind === 'named'
      ? '(SELECT jsonb_build_array(id,active,revision::text) FROM whaleu_safety.blocks WHERE blocker_id=$4 AND blocked_id=$2)'
      : 'NULL';
  const row = (
    await tx.query<{ value: unknown; exact_time: boolean }>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now), input AS (SELECT $2::uuid actor,$4::uuid peer)
     SELECT jsonb_build_object('heads',(SELECT jsonb_agg(jsonb_build_array(account_id,xmin::text) ORDER BY account_id) FROM whaleu_safety.account_heads WHERE account_id=ANY($1::uuid[])),
       'outgoing',${outgoing},
       'incoming',${incoming}) value,
       (SELECT count(*)=cardinality($1::uuid[]) AND coalesce(bool_and(block_coverage='complete' AND provenance='native_account_creation' AND (valid_until IS NULL OR (isfinite(valid_until) AND valid_until>instant.now)) AND ($3<>'actor' OR (restriction_coverage='complete' AND actions_allowed IS NOT NULL))),false) FROM whaleu_safety.account_heads WHERE account_id=ANY($1::uuid[])) exact_time FROM instant`,
      [kind === 'named' ? [actor, peer].sort() : [actor], actor, kind, peer],
    )
  ).rows[0];
  if (!row || row.exact_time !== true)
    throw new ApplicationError('SAFETY_UNAVAILABLE');
  return ownerFingerprint(row);
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 512,
  failureCode: 'SAFETY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'SAFETY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_safety.account_heads,whaleu_safety.blocks IN SHARE MODE NOWAIT',
      );
      for (const fact of facts) {
        if (
          (await snapshot(
            fact.actor,
            fact.kind === 'actor' ? null : fact.peer,
            fact.kind,
            read,
          )) !== fact.fingerprint
        )
          throw new ApplicationError('SAFETY_UNAVAILABLE');
      }
    }),
};
function pair(actor: string, peer: string) {
  if (
    !z.uuid().safeParse(actor).success ||
    !z.uuid().safeParse(peer).success ||
    actor === peer
  )
    throw new ApplicationError('SAFETY_UNAVAILABLE');
}
/** Internal DM owner adapter. Core supplies locked immutable membership and
 * acquires the shared/exclusive policy gate BEFORE any domain lock. Anonymous
 * or mixed views must never invoke namedState/namedAllowed with a hidden peer. */
@Injectable()
export class DmSafetyFacade {
  constructor(
    @Inject(SafetyRepository) private readonly records: SafetyRepository,
  ) {}
  private async retain(
    fact:
      | Omit<Extract<Fact, { kind: 'actor' }>, 'fingerprint'>
      | Omit<Extract<Fact, { kind: 'named' | 'own' }>, 'fingerprint'>,
    tx: PoolClient,
  ) {
    enableRequiredTransactionProof(tx, proof);
    const fingerprint = await snapshot(
      fact.actor,
      fact.kind === 'actor' ? null : fact.peer,
      fact.kind,
      tx,
    );
    registerRequiredTransactionFact(
      tx,
      proof,
      `${fact.kind}:${fact.actor}:${'peer' in fact ? fact.peer : ''}:${fingerprint}`,
      Object.freeze({ ...fact, fingerprint }) as Fact,
    );
  }
  async requireActor(actor: string, tx: PoolClient): Promise<void> {
    const head = await this.records.head(actor, tx);
    if (head)
      registerTransactionDeadline(
        tx,
        head.valid_until?.getTime() ?? null,
        'SAFETY_UNAVAILABLE',
      );
    await this.retain({ kind: 'actor', actor }, tx);
    await this.records.restriction(actor, tx);
  }
  async namedState(
    actor: string,
    peer: string,
    tx: PoolClient,
  ): Promise<{ allowed: boolean; blockedByYou: boolean }> {
    pair(actor, peer);
    const directions = await this.records.directions(
      actor,
      peer,
      'private_messages',
      tx,
    );
    if (!directions) throw new ApplicationError('SAFETY_UNAVAILABLE');
    await this.retain({ kind: 'named', actor, peer }, tx);
    return {
      allowed: !directions.outgoing && !directions.incoming,
      blockedByYou: directions.outgoing,
    };
  }
  async namedAllowed(
    actor: string,
    peer: string,
    tx: PoolClient,
  ): Promise<boolean> {
    return (await this.namedState(actor, peer, tx)).allowed;
  }
  /** Only the owner's outgoing choice. Safe for an anonymous actor explicitly
   * targeting the visible named participant; the reverse graph is never read. */
  async currentOwnNamedBlock(actor: string, peer: string, tx: PoolClient) {
    pair(actor, peer);
    const head = await this.records.head(actor, tx);
    registerTransactionDeadline(
      tx,
      head?.valid_until?.getTime() ?? null,
      'SAFETY_UNAVAILABLE',
    );
    const own = await this.records.outgoingReference(actor, peer, tx);
    await this.retain({ kind: 'own', actor, peer }, tx);
    return own;
  }
  async blockNamed(
    actor: string,
    peer: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<{
    relationshipId: string;
    blocked: true;
    revision: string;
    changed: boolean;
  }> {
    pair(actor, peer);
    if (!z.uuid().safeParse(requestId).success)
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    await this.requireActor(actor, tx);
    await this.records.rate(actor, 'block_named', tx);
    await lockNamedPair(actor, peer, tx);
    const current = (
      await tx.query<StoredBlock>(
        'SELECT * FROM whaleu_safety.blocks WHERE blocker_id=$1 AND blocked_id=$2 FOR UPDATE',
        [actor, peer],
      )
    ).rows[0];
    let row = current;
    if (!row?.active) {
      row = (
        await tx.query<StoredBlock>(
          `INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,display_snapshot,source_kind,source_id)
        VALUES($1,$2,$3,true,NULL,'private_message',$4) ON CONFLICT(blocker_id,blocked_id) DO UPDATE SET active=true,revision=whaleu_safety.blocks.revision+1,updated_at=date_trunc('milliseconds',clock_timestamp()) RETURNING *`,
          [current?.id ?? randomUUID(), actor, peer, requestId],
        )
      ).rows[0]!;
      await tx.query(
        "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'blocked',$4)",
        [randomUUID(), actor, row.id, row.revision],
      );
    }
    await tx.query(
      `INSERT INTO whaleu_safety.dm_block_bindings(account_id,request_id,target_id,relationship_id,revision) VALUES($1,$2,$3,$4,$5)`,
      [actor, requestId, peer, row.id, row.revision],
    );
    await this.retain({ kind: 'own', actor, peer }, tx);
    return {
      relationshipId: row.id,
      blocked: true,
      revision: row.revision,
      changed: !current?.active,
    };
  }
}
