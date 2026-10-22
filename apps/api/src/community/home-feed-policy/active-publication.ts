import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalEqual } from '../content-review/contracts.js';
import { loadHomeAdmission } from './admission.js';
import { HOME_POLICY_SOURCE } from './admission-contract.js';
import type { HomeAdmission } from './admission-contract.js';
const activeSchema = z.strictObject({
  activationId: z.uuid(),
  admission: z.strictObject({
    id: z.uuid(),
    revision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCommit: z.literal(HOME_POLICY_SOURCE),
    validUntil: z.iso.datetime(),
  }),
  validUntil: z.iso.datetime(),
});
/** NULL is specifically no configured activation. An expired/invalid configured
 * head is an error in SQL, never permission to return to the unrestricted lane. */
export async function loadActiveHomePublication(
  tx: PoolClient,
): Promise<HomeAdmission | null> {
  const result = await tx.query<{ activation: unknown }>(
    `SELECT whaleu_community.home_publication_current() AS activation`,
  );
  if (result.rows.length !== 1)
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  if (result.rows[0]!.activation === null) return null;
  const active = activeSchema.safeParse(result.rows[0]!.activation);
  if (!active.success) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const admission = await loadHomeAdmission(tx);
  if (!admission || !canonicalEqual(admission.ref, active.data.admission))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  return admission;
}
