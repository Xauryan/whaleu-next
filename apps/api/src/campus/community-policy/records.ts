import type { PoolClient } from 'pg';
import type { PolicyProvenance } from './contracts.js';

export interface TopologyRecord extends PolicyProvenance {
  id: string;
  revision: number;
  topology: unknown;
}
export interface SelectionHead {
  selection_id: string | null;
  revision: number;
}
export interface SelectionRecord extends PolicyProvenance {
  id: string;
  account_id: string;
  revision: number;
  selection_state: 'selected' | 'selection_required';
  campus_id: string | null;
  affiliation_assertion_id: string;
  affiliation_snapshot_id: string;
  topology_snapshot_id: string;
}
/** Campus-owned internal reads. Call under the outer policy gate. Never create heads. */
export async function readTopology(
  tx: PoolClient,
): Promise<TopologyRecord | null> {
  const head = (
    await tx.query<{ snapshot_id: string | null; revision: number }>(
      `SELECT snapshot_id,revision FROM whaleu_campus.community_topology_heads
     WHERE scope_key='community' FOR SHARE`,
    )
  ).rows[0];
  if (!head?.snapshot_id) return null;
  return (
    (
      await tx.query<TopologyRecord>(
        'SELECT * FROM whaleu_campus.community_topology_snapshots WHERE id=$1 AND revision=$2',
        [head.snapshot_id, head.revision],
      )
    ).rows[0] ?? null
  );
}
export async function readSelectionHead(
  accountId: string,
  tx: PoolClient,
  write = false,
): Promise<SelectionHead | null> {
  return (
    (
      await tx.query<SelectionHead>(
        `SELECT selection_id,revision FROM whaleu_campus.community_identity_heads WHERE account_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [accountId],
      )
    ).rows[0] ?? null
  );
}
export async function readSelection(
  accountId: string,
  head: SelectionHead | null,
  tx: PoolClient,
): Promise<SelectionRecord | null> {
  if (!head?.selection_id) return null;
  return (
    (
      await tx.query<SelectionRecord>(
        `SELECT * FROM whaleu_campus.community_identity_selections
     WHERE id=$1 AND account_id=$2 AND revision=$3`,
        [head.selection_id, accountId, head.revision],
      )
    ).rows[0] ?? null
  );
}
export async function activeRegions(
  ids: string[],
  tx: PoolClient,
): Promise<boolean> {
  const uniqueIds = [...new Set(ids)].sort();
  const rows = (
    await tx.query<{ id: string; is_active: boolean }>(
      `SELECT id,is_active FROM whaleu_campus.operating_regions
     WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
      [uniqueIds],
    )
  ).rows;
  return rows.length === uniqueIds.length && rows.every((row) => row.is_active);
}
export async function databaseNow(tx: PoolClient): Promise<number> {
  return (
    await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
  ).rows[0]!.now.getTime();
}
