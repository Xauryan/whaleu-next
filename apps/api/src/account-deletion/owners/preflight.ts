import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DeletionError } from '../contracts.js';
import {
  deletionMetadataRelations,
  numericEpochTables,
  reviewedRelations,
  supportedTables,
} from '../owner-registry.js';
export interface InventoryRow {
  relation: string;
  shape_hash: string;
  rows_hash: string;
  row_count: number;
  supported: boolean;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export const sha = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export function relationSql(name: string): string {
  if (!/^whaleu_[a-z_]+\.[a-z_][a-z0-9_]*$/.test(name))
    throw new DeletionError('INVENTORY_IDENTIFIER_INVALID');
  return name
    .split('.')
    .map((v) => '"' + v + '"')
    .join('.');
}
export async function inventory(
  tx: PoolClient,
  lock = false,
): Promise<InventoryRow[]> {
  const schemas = (
    await tx.query<{ name: string }>(
      "SELECT nspname name FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
    )
  ).rows;
  const knownSchemas = new Set(
    [...reviewedRelations].map((n) => n.split('.')[0]),
  );
  if (
    schemas.some(
      (s) =>
        !knownSchemas.has(s.name) &&
        !['whaleu_account_deletion', 'whaleu_meta'].includes(s.name),
    )
  )
    throw new DeletionError('UNREGISTERED_OWNER_SCHEMA');
  const maximumRelations =
    reviewedRelations.size + deletionMetadataRelations.size;
  const stored = (
    await tx.query<{ relation: string; kind: string }>(
      "SELECT n.nspname||'.'||c.relname relation,c.relkind kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\\_%' ESCAPE '\\' AND c.relkind IN('r','p','m','f') LIMIT $1",
      [maximumRelations + 1],
    )
  ).rows;
  if (stored.length > maximumRelations)
    throw new DeletionError('INVENTORY_BOUND_EXCEEDED');
  if (stored.some((r) => !['r', 'p'].includes(r.kind)))
    throw new DeletionError('UNSUPPORTED_OWNER_RELATION_KIND');
  const metadata = stored.filter(
    (r) =>
      r.relation.startsWith('whaleu_account_deletion.') ||
      r.relation.startsWith('whaleu_meta.'),
  );
  if (
    metadata.length !== deletionMetadataRelations.size ||
    metadata.some((r) => !deletionMetadataRelations.has(r.relation))
  )
    throw new DeletionError('COORDINATOR_INVENTORY_CHANGED');
  const relations = (
    await tx.query<{
      relation: string;
      shape: unknown;
    }>(`SELECT n.nspname||'.'||c.relname relation,
 jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)) shape
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\\_%' ESCAPE '\\' AND n.nspname NOT IN('whaleu_account_deletion','whaleu_meta') AND c.relkind IN('r','p') ORDER BY n.nspname,c.relname`)
  ).rows;
  if (relations.some((r) => !reviewedRelations.has(r.relation)))
    throw new DeletionError('UNREGISTERED_OWNER_RELATION');
  if (lock)
    for (const r of relations)
      await tx.query(
        `LOCK TABLE ${relationSql(r.relation)} IN SHARE ROW EXCLUSIVE MODE NOWAIT`,
      );
  const result: InventoryRow[] = [];
  for (const r of relations) {
    const raw = (
      await tx.query<{ value: Record<string, unknown>; raw: string }>(
        `SELECT to_jsonb(t) value,to_jsonb(t)::text raw FROM ${relationSql(r.relation)} t ORDER BY to_jsonb(t)::text LIMIT 10001`,
      )
    ).rows;
    const rows = raw.map((v) => v.value);
    if (rows.length > 10000)
      throw new DeletionError('INVENTORY_BOUND_EXCEEDED');
    if (
      numericEpochTables.has(r.relation) &&
      !rows.every(
        (v) =>
          Number.isInteger(v['slot']) &&
          ((Object.keys(v).sort().join(',') === 'epoch,slot,version' &&
            v['version'] === 1 &&
            /^\d+$/.test(String(v['epoch']))) ||
            (Object.keys(v).sort().join(',') === 'generation,slot' &&
              /^[1-9][0-9]*$/.test(String(v['generation'])))),
      )
    )
      throw new DeletionError('EPOCH_PAYLOAD_UNAVAILABLE');
    result.push({
      relation: r.relation,
      shape_hash: sha(r.shape),
      rows_hash: sha(raw.map((v) => v.raw)),
      row_count: rows.length,
      supported: supportedTables.has(r.relation),
    });
  }
  return result;
}
export function inventoryBlockers(
  sealed: readonly InventoryRow[],
  current: readonly InventoryRow[],
): string[] {
  const map = new Map(sealed.map((x) => [x.relation, x]));
  const reasons: string[] = [];
  if (map.size !== current.length || current.some((x) => !map.has(x.relation)))
    reasons.push('OWNER_INVENTORY_CHANGED');
  for (const row of current) {
    const old = map.get(row.relation);
    if (!old) continue;
    if (row.shape_hash !== old.shape_hash || row.supported !== old.supported)
      reasons.push('OWNER_SHAPE_CHANGED');
    if (
      !old.supported &&
      (old.rows_hash !== row.rows_hash || old.row_count !== row.row_count)
    )
      reasons.push('UNSUPPORTED_OWNER_DATA:' + row.relation);
  }
  return [...new Set(reasons)].sort();
}
/** Full-table exact seals deliberately reject any unsupported history, including
 * raw bytes, indirect FKs, opaque provider mappings and nested JSON copies. */
export async function preflight(tx: PoolClient, sandbox: string, lock = true) {
  const sealed = (
    await tx.query<InventoryRow>(
      'SELECT relation,shape_hash,rows_hash,row_count,supported FROM whaleu_account_deletion.inventory WHERE sandbox_id=$1 ORDER BY relation',
      [sandbox],
    )
  ).rows;
  const current = await inventory(tx, lock);
  const blockers = inventoryBlockers(sealed, current);
  const partition = (
    await tx.query<{ valid: boolean; metadata: boolean }>(
      `SELECT whaleu_account_deletion.follow_partition_valid($1) valid,coordinator_shape_hash=whaleu_account_deletion.coordinator_shape() metadata FROM whaleu_account_deletion.sandboxes WHERE id=$1`,
      [sandbox],
    )
  ).rows[0];
  if (!partition?.valid) blockers.push('UNSUPPORTED_FOLLOW_SOCIAL_PARTITION');
  if (!partition?.metadata) blockers.push('COORDINATOR_SHAPE_CHANGED');
  return { blockers: [...new Set(blockers)].sort(), proof: sha(current) };
}
