import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';

/** Finite historical-proof closure installed by 0178, independent of the
 * unchanged 0176 collector. No activation/admission row is read here. */
export const HOME_READING_CATALOG_BODY_SHA256 =
  '0b2f916f1b307de7c9201767dc3334df348ffe68411f8fbc6d6579e8fc622ae4';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const protocolSchema = z.strictObject({
  version: z.literal(1),
  migration: z.literal('0178_home_publication_protocol.sql'),
  catalog: digest,
});
const functionSchema = z.strictObject({
  body: z.string(),
  safe: z.literal(true),
});
const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');
/** Called only after a catalog-presence query establishes some 0178 objects.
 * Partial installation is unavailable, never a legacy-only interpretation.
 * Do not expose a caller-controlled permission switch or cache this inspection. */
export async function inspectHomeReadingSchema(
  tx: PoolClient,
): Promise<string> {
  const installed = (
    await tx.query<{ collector: unknown; marker: unknown }>(
      `SELECT
       (SELECT jsonb_build_object('body',p.prosrc,'safe',NOT p.prosecdef AND NOT p.proretset AND NOT p.proleakproof AND NOT p.proisstrict AND p.proparallel='u' AND p.provolatile='s' AND p.prorettype='text'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.proconfig=ARRAY['search_path=pg_catalog']) FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_community.home_reading_catalog()')) collector,
       (SELECT jsonb_build_object('body',p.prosrc,'safe',NOT p.prosecdef AND NOT p.proretset AND NOT p.proleakproof AND NOT p.proisstrict AND p.proparallel='u' AND p.provolatile='i' AND p.prorettype='jsonb'::regtype AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql') AND p.proconfig=ARRAY['search_path=pg_catalog'] AND p.proowner=(SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('whaleu_community.home_reading_catalog()'))) FROM pg_proc p WHERE p.oid=to_regprocedure('whaleu_community.home_reading_protocol()')) marker`,
    )
  ).rows[0];
  const collector = functionSchema.safeParse(installed?.collector);
  const marker = functionSchema.safeParse(installed?.marker);
  if (
    !collector.success ||
    !marker.success ||
    createHash('sha256').update(collector.data.body).digest('hex') !==
      HOME_READING_CATALOG_BODY_SHA256
  )
    throw unavailable();
  const literal = /^SELECT '([^']+)'::jsonb$/.exec(marker.data.body);
  if (!literal) throw unavailable();
  const protocol = protocolSchema.safeParse(JSON.parse(literal[1]!));
  if (!protocol.success) throw unavailable();
  const current = (
    await tx.query<{ catalog: unknown }>(
      'SELECT whaleu_community.home_reading_catalog() catalog',
    )
  ).rows[0]?.catalog;
  if (current !== protocol.data.catalog) throw unavailable();
  return protocol.data.catalog;
}
