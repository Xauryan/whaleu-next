import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';

export const ADMIN_PARTICIPANT_BATCH_LIMIT = 512;
const idSchema = z.uuid().refine((id) => id === id.toLowerCase());
const participantSchema = z.strictObject({
  accountId: idSchema,
  profileId: idSchema,
  displayName: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[\u4e00-\u9fa5a-zA-Z0-9_#&@.+-]+$/u),
});
export type AdminParticipant =
  | { status: 'available'; profileId: string; displayName: string }
  | { status: 'unavailable' };
/** Internal join result only; accountId must never be serialized into an admin DTO. */
export type ResolvedAdminParticipant = z.infer<typeof participantSchema>;

/** Public display facts only. Keys are internal account joins and must never be
 * serialized. Missing profiles stay explicit; reads never manufacture profiles,
 * names, references or numeric-UID mappings. Caller owns management authority
 * and final consistency for the nonlocking bounded batch snapshot. The separate
 * exact-reference resolver retains its existing row through transaction end. */
@Injectable()
export class ProfileAdminParticipantFacade {
  /** Resolve existing public references under a stable owner row lock during
   * ordinary work, before final proofs. Missing references never create rows. */
  async resolve(
    profileId: string,
    tx: PoolClient,
  ): Promise<ResolvedAdminParticipant | null> {
    try {
      idSchema.parse(profileId);
      const result = await tx.query<ResolvedAdminParticipant>(
        `SELECT account_id AS "accountId", public_id AS "profileId",
         coalesce(nickname,'鲸鱼用户') AS "displayName"
         FROM whaleu_profile.profiles WHERE public_id=$1 FOR SHARE`,
        [profileId],
      );
      if (result.rows.length > 1)
        throw new ApplicationError('ERRAND_UNAVAILABLE');
      if (!result.rows.length) return null;
      const participant = participantSchema.parse(result.rows[0]);
      if (participant.profileId !== profileId)
        throw new ApplicationError('ERRAND_UNAVAILABLE');
      return participant;
    } catch {
      throw new ApplicationError('ERRAND_UNAVAILABLE');
    }
  }

  async batch(
    accountIds: readonly string[],
    tx: PoolClient,
  ): Promise<ReadonlyMap<string, AdminParticipant>> {
    const distinct = [...new Set(accountIds)].sort();
    if (
      distinct.length > ADMIN_PARTICIPANT_BATCH_LIMIT ||
      distinct.some((id) => !idSchema.safeParse(id).success)
    )
      throw new ApplicationError('ERRAND_UNAVAILABLE');
    const participants = new Map<string, AdminParticipant>(
      distinct.map((id) => [id, { status: 'unavailable' }]),
    );
    if (!distinct.length) return participants;
    try {
      const result = await tx.query<z.infer<typeof participantSchema>>(
        `SELECT account_id AS "accountId", public_id AS "profileId",
         coalesce(nickname,'鲸鱼用户') AS "displayName"
         FROM whaleu_profile.profiles WHERE account_id=ANY($1::uuid[]) ORDER BY account_id`,
        [distinct],
      );
      const references = new Set<string>();
      for (const raw of result.rows) {
        const parsed = participantSchema.safeParse(raw);
        if (!parsed.success) throw new ApplicationError('ERRAND_UNAVAILABLE');
        const { accountId, profileId, displayName } = parsed.data;
        if (
          participants.get(accountId)?.status !== 'unavailable' ||
          references.has(profileId)
        )
          throw new ApplicationError('ERRAND_UNAVAILABLE');
        participants.set(accountId, {
          status: 'available',
          profileId,
          displayName,
        });
        references.add(profileId);
      }
      return participants;
    } catch {
      // An unsuccessful source read is never equivalent to proven absence.
      throw new ApplicationError('ERRAND_UNAVAILABLE');
    }
  }
}
