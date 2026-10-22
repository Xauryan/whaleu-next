import { z } from 'zod';
import { retainRegistrationSchema } from './readiness.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../config/config.js';
import { ApplicationError } from '../../http/application-error.js';
import type { ProviderIdentity } from '../contracts.js';
import {
  keyEpochSchema,
  MAXIMUM_DIGEST_EPOCHS,
  parseDigestKeyRing,
  ProviderIdentityDigests,
  REGISTRATION_GUARD_PROTOCOL,
} from './digests.js';

const policySchema = z.strictObject({
  slot: z.literal(1),
  protocol: z.literal(REGISTRATION_GUARD_PROTOCOL),
  revision: z.number().int().positive().safe(),
  mode: z.enum(['inactive', 'enforced']),
  completion_protocol: z.enum(['unavailable', 'completed-account-deletion-v1']),
  active_epoch: keyEpochSchema.nullable(),
});
const epochSchema = z.strictObject({
  epoch: keyEpochSchema,
  key_check: z.string().regex(/^[a-f0-9]{64}$/),
});
const unavailable = () => new ApplicationError('AUTH_NOT_CONFIGURED');

/** The ordinary login transaction already owns the original app/provider/subject
 * advisory lock. Read and hold the persistent policy fence before account writes.
 * Future completion MUST own that same identity lock; key/policy changes MUST
 * update this singleton under an exclusive row lock. No source-null bypass. */
export async function assertRegistrationAllowed(
  tx: PoolClient,
  identity: ProviderIdentity,
  config?: Pick<
    RuntimeConfig,
    'IDENTITY_REGISTRATION_GUARD' | 'IDENTITY_DELETION_DIGEST_KEYRING'
  >,
): Promise<void> {
  try {
    await retainRegistrationSchema(tx);
    await boundedOwnerProof(tx, 'AUTH_NOT_CONFIGURED', async (tx) => {
      const policies = (
        await tx.query<{ policy: unknown }>(
          'SELECT to_jsonb(p) policy FROM whaleu_identity.registration_guard_policy p LIMIT 2 FOR SHARE',
        )
      ).rows;
      if (policies.length !== 1) throw unavailable();
      const parsed = policySchema.safeParse(policies[0]!.policy);
      if (!parsed.success) throw unavailable();
      const policy = parsed.data;
      if (policy.mode === 'inactive') {
        if (
          policy.completion_protocol !== 'unavailable' ||
          policy.active_epoch !== null ||
          config?.IDENTITY_REGISTRATION_GUARD === 'required'
        )
          throw unavailable();
        const empty = (
          await tx.query<{ empty: boolean }>(
            `SELECT NOT EXISTS(SELECT 1 FROM whaleu_identity.registration_guards)
         AND NOT EXISTS(SELECT 1 FROM whaleu_identity.registration_guard_key_epochs) AS empty`,
          )
        ).rows;
        if (empty.length !== 1 || empty[0]?.empty !== true) throw unavailable();
        return;
      }
      if (
        policy.completion_protocol !== 'completed-account-deletion-v1' ||
        !policy.active_epoch ||
        !config?.IDENTITY_DELETION_DIGEST_KEYRING
      )
        throw unavailable();
      const keys = new ProviderIdentityDigests(
        parseDigestKeyRing(config.IDENTITY_DELETION_DIGEST_KEYRING),
      );
      const epochs = (
        await tx.query<{ epoch: unknown }>(
          'SELECT to_jsonb(k) epoch FROM whaleu_identity.registration_guard_key_epochs k ORDER BY k.epoch COLLATE "C" LIMIT $1 FOR SHARE',
          [MAXIMUM_DIGEST_EPOCHS + 1],
        )
      ).rows;
      if (
        !epochs.length ||
        epochs.length > MAXIMUM_DIGEST_EPOCHS ||
        keys.activeEpoch !== policy.active_epoch
      )
        throw unavailable();
      const required = epochs.map((row) => {
        const epoch = epochSchema.safeParse(row.epoch);
        if (
          !epoch.success ||
          !keys.matchesKeyCheck(epoch.data.epoch, epoch.data.key_check)
        )
          throw unavailable();
        return epoch.data.epoch;
      });
      if (
        new Set(required).size !== required.length ||
        !required.includes(policy.active_epoch)
      )
        throw unavailable();
      // Extra provisioned keys support safe rollout before activation. Every stored
      // epoch is mandatory, including old epochs whose last guard has expired;
      // this slice deliberately provides no unsafe secret retirement shortcut.
      const candidates = required.map((epoch) => keys.digest(identity, epoch));
      const blocked = (
        await tx.query<{ valid: boolean }>(
          `SELECT (isfinite(g.completed_at) AND isfinite(g.reregister_after)
          AND g.completed_at<=clock_timestamp()
          AND g.reregister_after=g.completed_at+interval '2592000 seconds') valid
       FROM whaleu_identity.registration_guards g
       JOIN unnest($1::text[],$2::text[]) candidate(epoch,digest)
         ON candidate.epoch=g.key_epoch AND candidate.digest=g.identity_digest
       WHERE g.reregister_after>clock_timestamp()
       ORDER BY g.reregister_after DESC LIMIT 1`,
          [candidates.map((c) => c.epoch), candidates.map((c) => c.digest)],
        )
      ).rows;
      if (blocked.length > 1) throw unavailable();
      if (blocked.length) {
        if (blocked[0]?.valid !== true) throw unavailable();
        // Any SQL-selected live guard blocks. Never compare PostgreSQL timestamps
        // through JS Date: its millisecond truncation loses up to 999 microseconds.
        // A guard expiring after the SQL selection may conservatively deny this
        // attempt; it must never let this attempt register early.
        throw new ApplicationError('LOGIN_REJECTED');
      }
    });
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    // Missing schema, unknown versions, query/parse failures and secret errors
    // cannot become an absence proof. Do not disclose a digest, epoch or DB error.
    throw unavailable();
  }
}
