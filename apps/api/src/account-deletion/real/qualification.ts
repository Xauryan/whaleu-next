import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { MIGRATION_LOCK } from '../../database/migrations.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { preparationCatalogBodySha256 } from './catalog.js';
const unavailable = () => new ApplicationError('REAL_DELETION_UNAVAILABLE');
const signature = z.strictObject({
  body: z.string().max(16384),
  invoker: z.literal(true),
  sql: z.literal(true),
  config: z.tuple([z.literal('search_path=pg_catalog')]),
  scalar: z.literal(true),
  safe: z.literal(true),
});
const protocolSchema = z.strictObject({
  version: z.literal(2),
  protocol: z.literal('real-account-deletion-preparation-v2'),
  migration: z.literal('0182_real_deletion_request_authority.sql'),
  acceptance: z.literal('unavailable'),
  catalog: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function inspectPreparationSchema(
  tx: PoolClient,
): Promise<string> {
  const row = (
    await tx.query<{ catalogFunction: unknown; marker: unknown }>(
      `/* real-preparation-schema-metadata-v1 */ SELECT
    (SELECT jsonb_build_object('body',CASE WHEN octet_length(p.prosrc)<=16384 THEN p.prosrc ELSE NULL END,'stable',p.provolatile='s','invoker',NOT p.prosecdef,'sql',p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql'),'config',CASE WHEN p.proconfig=ARRAY['search_path=pg_catalog']::text[] THEN p.proconfig ELSE NULL END,'scalar',NOT p.proretset AND p.prorettype='text'::regtype,'safe',NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u') FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_real_deletion.preparation_catalog()')) "catalogFunction",
    (SELECT jsonb_build_object('body',CASE WHEN octet_length(p.prosrc)<=16384 THEN p.prosrc ELSE NULL END,'immutable',p.provolatile='i','invoker',NOT p.prosecdef,'sql',p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql'),'config',CASE WHEN p.proconfig=ARRAY['search_path=pg_catalog']::text[] THEN p.proconfig ELSE NULL END,'scalar',NOT p.proretset AND p.prorettype='jsonb'::regtype,'sameOwner',p.proowner=(SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('whaleu_real_deletion.preparation_catalog()')),'safe',NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u') FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_real_deletion.preparation_protocol()')) marker`,
    )
  ).rows[0];
  const catalog = signature
    .extend({ stable: z.literal(true) })
    .safeParse(row?.catalogFunction);
  const marker = signature
    .extend({ immutable: z.literal(true), sameOwner: z.literal(true) })
    .safeParse(row?.marker);
  if (
    !catalog.success ||
    !marker.success ||
    createHash('sha256').update(catalog.data.body).digest('hex') !==
      preparationCatalogBodySha256
  )
    throw unavailable();
  const literal = /^SELECT '([^']+)'::jsonb$/.exec(marker.data.body);
  if (!literal) throw unavailable();
  const protocol = protocolSchema.safeParse(JSON.parse(literal[1]!));
  if (!protocol.success) throw unavailable();
  const current = (
    await tx.query<{ catalog: string }>(
      'SELECT whaleu_real_deletion.preparation_catalog() catalog',
    )
  ).rows;
  if (current.length !== 1 || current[0]?.catalog !== protocol.data.catalog)
    throw unavailable();
  return protocol.data.catalog;
}
/** Same key as the approved migrator, shared for this transaction through
 * COMMIT. No table-lock privilege, MAINTAIN or broad UPDATE is requested. Raw
 * superuser/catalog DDL outside the official migration path is not authorized. */
async function migrationFence(tx: PoolClient): Promise<void> {
  const rows = (
    await tx.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock_shared($1, $2) AS locked',
      [...MIGRATION_LOCK],
    )
  ).rows;
  if (rows.length !== 1 || rows[0]?.locked !== true) throw unavailable();
}
const proof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'REAL_DELETION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'REAL_DELETION_UNAVAILABLE', async (read) => {
      await migrationFence(read);
      const current = await inspectPreparationSchema(read);
      if (facts.some((fact) => fact !== current)) throw unavailable();
    }),
};
/** No absent-schema fallback. Register a required final proof before admission,
 * preserving the same bounded proof after all deferred transaction waits. */
export async function retainPreparationSchema(tx: PoolClient): Promise<void> {
  enableRequiredTransactionProof(tx, proof);
  let catalog: string | undefined;
  await boundedOwnerProof(tx, 'REAL_DELETION_UNAVAILABLE', async (read) => {
    await migrationFence(read);
    catalog = await inspectPreparationSchema(read);
  });
  if (!catalog) throw unavailable();
  registerRequiredTransactionFact(
    tx,
    proof,
    'real-preparation-schema-v1',
    catalog,
  );
}
