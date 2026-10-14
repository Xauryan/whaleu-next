import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';

interface InboxFact {
  spaces: string[];
  snapshot: string | null;
  domain: string;
}
const inboxProof: RequiredTransactionProof<InboxFact> = {
  maximumFacts: 4,
  failureCode: 'OFFICIAL_SOURCE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'OFFICIAL_SOURCE_UNAVAILABLE', async (read) => {
      // Managed finalization flushed deferred constraints already. Every later
      // owner validator is NOWAIT/read-only: no reverse blocking owner acquisition.
      await read.query(
        'LOCK TABLE whaleu_official.pending_causes IN SHARE MODE NOWAIT',
      );
      const domain = (
        await read.query<{ domain: string }>(
          'SELECT whaleu_official.current_capture_domain() domain',
        )
      ).rows[0]!.domain;
      for (const fact of facts) {
        if (fact.domain !== domain)
          throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        if (fact.snapshot === null) {
          if (await hasOfficialPending(read, fact.spaces))
            throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        } else {
          // Old committed backlog is irrelevant to manual newest-first reads.
          // xmin includes every in-flight low xid; allocation order is never commit order.
          for (const space of fact.spaces) {
            const rows = (
              await read.query<{ visible: boolean }>(
                `SELECT pg_visible_in_snapshot(source_xid,$2::pg_snapshot) visible FROM whaleu_official.pending_causes WHERE kind='source' AND space_id=$1 AND source_domain=$3 AND source_xid>=pg_snapshot_xmin($2::pg_snapshot) ORDER BY source_xid LIMIT 129`,
                [space, fact.snapshot, fact.domain],
              )
            ).rows;
            if (rows.length > 128 || rows.some((r) => !r.visible))
              throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
          }
          const dependencies = (
            await read.query<{ visible: boolean }>(
              `SELECT pg_visible_in_snapshot(source_xid,$1::pg_snapshot) visible FROM whaleu_official.pending_causes WHERE kind='dependency' AND source_domain=$2 AND source_xid>=pg_snapshot_xmin($1::pg_snapshot) ORDER BY source_xid LIMIT 129`,
              [fact.snapshot, fact.domain],
            )
          ).rows;
          if (dependencies.length > 128 || dependencies.some((r) => !r.visible))
            throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        }
      }
    }),
};
export async function captureOfficialInbox(
  tx: PoolClient,
  spaces: string[],
  requireEmpty: boolean,
) {
  const captured = (
    await tx.query<{ snapshot: string; domain: string }>(
      'SELECT pg_current_snapshot()::text snapshot,whaleu_official.current_capture_domain() domain',
    )
  ).rows[0]!;
  const snapshot = requireEmpty ? null : captured.snapshot;
  enableRequiredTransactionProof(tx, inboxProof);
  registerRequiredTransactionFact(
    tx,
    inboxProof,
    `${requireEmpty}:${spaces.join(',')}`,
    { spaces: [...spaces], snapshot, domain: captured.domain },
  );
}
export async function hasOfficialPending(
  tx: PoolClient,
  spaces: string[],
): Promise<boolean> {
  for (const space of spaces)
    if (
      (
        await tx.query(
          "SELECT 1 FROM whaleu_official.pending_causes WHERE kind='source' AND space_id=$1 LIMIT 1",
          [space],
        )
      ).rowCount
    )
      return true;
  return !!(
    await tx.query(
      "SELECT 1 FROM whaleu_official.pending_causes WHERE kind='dependency' LIMIT 1",
    )
  ).rowCount;
}
interface PendingCause {
  id: string;
  kind: 'source' | 'dependency';
  space_id: string | null;
  post_id: string | null;
  dependency_kind: string | null;
  target_id: string | null;
  owner_table: string;
  source_xid: string;
  source_domain: string;
}
/** At most32 source +32 dependency causes; only captured row identities are removed.
 * UUID ordering is a scheduling choice, not a committed watermark. */
export async function drainOfficialCauses(
  tx: PoolClient,
  spaces: string[],
): Promise<number> {
  const orderedSpaces = [...new Set(spaces)].sort();
  if (orderedSpaces.length < 1 || orderedSpaces.length > 2)
    throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
  const perSpace = 32 / orderedSpaces.length;
  const sources: PendingCause[] = [];
  for (const space of orderedSpaces) {
    sources.push(
      ...(
        await tx.query<PendingCause>(
          "SELECT *,source_xid::text FROM whaleu_official.pending_causes WHERE kind='source' AND space_id=$1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED",
          [space, perSpace],
        )
      ).rows,
    );
  }
  const dependencies = (
    await tx.query<PendingCause>(
      "SELECT *,source_xid::text FROM whaleu_official.pending_causes WHERE kind='dependency' ORDER BY id LIMIT 32 FOR UPDATE SKIP LOCKED",
    )
  ).rows;
  for (const cause of [...sources, ...dependencies]) {
    let sequence: string;
    if (cause.kind === 'source') {
      sequence = (
        await tx.query<{ head: string }>(
          'UPDATE whaleu_official.source_roots SET head=head+1,ready=false WHERE space_id=$1 RETURNING head::text',
          [cause.space_id],
        )
      ).rows[0]!.head;
      await tx.query(
        'INSERT INTO whaleu_official.source_events(space_id,sequence,post_id,owner_table,source_xid,source_domain) VALUES($1,$2,$3,$4,$5::xid8,$6)',
        [
          cause.space_id,
          sequence,
          cause.post_id,
          cause.owner_table,
          cause.source_xid,
          cause.source_domain,
        ],
      );
      await tx.query(
        'INSERT INTO whaleu_official.source_dirty(space_id,post_id,first_sequence,last_sequence) VALUES($1,$2,$3,$3) ON CONFLICT(space_id,post_id) DO UPDATE SET last_sequence=EXCLUDED.last_sequence',
        [cause.space_id, cause.post_id, sequence],
      );
    } else {
      sequence = (
        await tx.query<{ head: string }>(
          'UPDATE whaleu_official.dependency_root SET head=head+1 WHERE singleton RETURNING head::text',
        )
      ).rows[0]!.head;
      await tx.query(
        'INSERT INTO whaleu_official.dependency_events(sequence,kind,target_id,owner_table,source_xid,source_domain) VALUES($1,$2,$3,$4,$5::xid8,$6)',
        [
          sequence,
          cause.dependency_kind,
          cause.target_id,
          cause.owner_table,
          cause.source_xid,
          cause.source_domain,
        ],
      );
    }
    await tx.query(
      'INSERT INTO whaleu_official.cause_conversions(id,kind,space_id,post_id,dependency_kind,target_id,owner_table,source_xid,source_domain,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8::xid8,$9,$10)',
      [
        cause.id,
        cause.kind,
        cause.space_id,
        cause.post_id,
        cause.dependency_kind,
        cause.target_id,
        cause.owner_table,
        cause.source_xid,
        cause.source_domain,
        sequence,
      ],
    );
    if (
      (
        await tx.query(
          'DELETE FROM whaleu_official.pending_causes WHERE id=$1',
          [cause.id],
        )
      ).rowCount !== 1
    )
      throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
  }
  return sources.length + dependencies.length;
}
