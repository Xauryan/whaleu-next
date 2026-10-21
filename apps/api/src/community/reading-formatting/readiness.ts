import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { FORMATTER } from './contracts.js';
import { readingCatalogSnapshotSql } from './catalog.js';

/** Fixed formal-migration function body, not a self-attesting SQL return value. */
const catalogBodySha256 =
  '4193cd2855e457dbc40ed24a5f1966735e0436b435455eca69e50cbd19893133';
const protocolSchema = z.strictObject({
  version: z.literal(1),
  formatter: z.literal(FORMATTER),
  generation: z.literal(1),
  migration: z.literal('0176_durable_reading_formatting.sql'),
  catalog: z.string().regex(/^[a-f0-9]{64}$/),
});
const snapshotSchema = z.strictObject({
  catalog: z.string().regex(/^[a-f0-9]{64}$/),
  slots: z.tuple([z.literal(1), z.literal(2)]),
  deparsePath: z.literal('pg_catalog'),
  searchPathRestored: z.literal(true),
});
export type ReadingSchema =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'ready'; catalog: string }>;
const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');
/** Catalog/protocol metadata only; never source or account-processing authority. */
export async function inspectReadingSchema(
  tx: PoolClient,
): Promise<ReadingSchema> {
  try {
    return await inspect(tx);
  } catch {
    throw unavailable();
  }
}
async function inspect(tx: PoolClient): Promise<ReadingSchema> {
  const presence = (
    await tx.query<{
      relations: number;
      functions: number;
      protocol: boolean;
      catalog: boolean;
      marker: unknown;
      catalogFunction: unknown;
    }>(
      `SELECT
      (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='whaleu_community' AND c.relname LIKE 'reading_format_%') relations,
      (SELECT count(*)::integer FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='whaleu_community' AND p.proname LIKE 'reading_format_%') functions,
      to_regprocedure('whaleu_community.reading_format_protocol()') IS NOT NULL protocol,
      to_regprocedure('whaleu_community.reading_format_catalog()') IS NOT NULL catalog,
      (SELECT jsonb_build_object('body',p.prosrc,'stable',p.provolatile='s','invoker',NOT p.prosecdef,'sql',p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql'),'config',p.proconfig,'scalar',NOT p.proretset AND p.prorettype='text'::regtype) FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_community.reading_format_catalog()')) "catalogFunction",
      (SELECT jsonb_build_object('body',p.prosrc,'immutable',p.provolatile='i','invoker',NOT p.prosecdef,'sql',p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql'),'config',p.proconfig,'scalar',NOT p.proretset AND p.prorettype='jsonb'::regtype,'sameOwner',p.proowner=(SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('whaleu_community.reading_format_catalog()'))) FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_community.reading_format_protocol()')) marker`,
    )
  ).rows[0];
  if (
    !presence ||
    !Number.isInteger(presence.relations) ||
    !Number.isInteger(presence.functions)
  )
    throw unavailable();
  if (
    presence.relations === 0 &&
    presence.functions === 0 &&
    presence.protocol === false &&
    presence.catalog === false
  )
    return Object.freeze({ status: 'missing' });
  if (presence.relations < 4 || !presence.protocol || !presence.catalog)
    throw unavailable();
  const catalogFunction = z
    .strictObject({
      body: z.string(),
      stable: z.literal(true),
      invoker: z.literal(true),
      sql: z.literal(true),
      config: z.tuple([z.literal('search_path=pg_catalog')]),
      scalar: z.literal(true),
    })
    .safeParse(presence.catalogFunction);
  if (
    !catalogFunction.success ||
    createHash('sha256').update(catalogFunction.data.body).digest('hex') !==
      catalogBodySha256
  )
    throw unavailable();
  const marker = z
    .strictObject({
      body: z.string(),
      immutable: z.literal(true),
      invoker: z.literal(true),
      sql: z.literal(true),
      config: z.tuple([z.literal('search_path=pg_catalog')]),
      scalar: z.literal(true),
      sameOwner: z.literal(true),
    })
    .safeParse(presence.marker);
  if (!marker.success) throw unavailable();
  const literal = /^SELECT '([^']+)'::jsonb$/.exec(marker.data.body);
  if (!literal) throw unavailable();
  const protocol = protocolSchema.safeParse(JSON.parse(literal[1]!));
  if (!protocol.success) throw unavailable();
  const raw = (await tx.query(readingCatalogSnapshotSql)).rows[0];
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success || parsed.data.catalog !== protocol.data.catalog)
    throw unavailable();
  return Object.freeze({ status: 'ready', catalog: parsed.data.catalog });
}
const proof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.reading_format_heads,whaleu_community.reading_format_jobs,whaleu_community.reading_format_results,whaleu_community.reading_format_slots IN SHARE MODE NOWAIT',
      );
      const current = await inspectReadingSchema(read);
      if (
        current.status !== 'ready' ||
        facts.some((value) => value !== current.catalog)
      )
        throw unavailable();
    }),
};
/** Required schema closure for writes. An absent entire owner remains distinguishable
 * from a partial, unsupported or modified owner, which always rejects. */
export async function retainReadingSchema(tx: PoolClient): Promise<boolean> {
  if (!transactionReadEpoch(tx)) throw unavailable();
  const current = await inspectReadingSchema(tx);
  if (current.status === 'missing') return false;
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'reading-schema-v1',
    current.catalog,
  );
  return true;
}
export async function requireReadingSchema(tx: PoolClient): Promise<void> {
  if (!(await retainReadingSchema(tx))) throw unavailable();
}
