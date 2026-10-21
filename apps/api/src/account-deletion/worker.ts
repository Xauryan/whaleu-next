import {
  DeletionError,
  REREGISTRATION_MS,
  INVENTORY_VERSION,
} from './contracts.js';
import type { OwnerEvidence, OwnerKey } from './contracts.js';
import { AccountDeletionRepository, status } from './repository.js';
import { validateCompletionEvidence } from './completion-evidence.js';
import { SyntheticDeletionMedia } from './synthetic-media.js';
import { preflight, sha } from './owners/preflight.js';
import { baselineProof } from './owners/baseline.js';
import { eraseProfile } from './owners/profile.js';
import { eraseTimetable } from './owners/timetable.js';
import { eraseFollowSocial } from './owners/follow-social.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { eraseIdentity } from './owners/identity.js';
import { SYNTHETIC_APP } from './synthetic-policy.js';
const order: readonly OwnerKey[] = [
  'follow-social',
  'profile',
  'timetable',
  'native-baseline',
  'unsupported-inventory',
  'media',
  'identity',
];
export class AccountDeletionWorker {
  constructor(
    private readonly repository: AccountDeletionRepository,
    private readonly media: SyntheticDeletionMedia,
  ) {}
  /** A bounded page is one DB transaction. Every owner page and its receipt
   * commit together; NOWAIT conflicts roll back with no cursor/proof advance.
   * Full relation locks are intentionally costly and LOCAL REHEARSAL ONLY. They
   * prove the initial unsupported-owner seal, not production scalability. */
  async tick(requestId: string) {
    return this.repository.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      let row = await this.repository.request(tx, requestId);
      await this.repository.lockAccount(tx, row.account_id);
      row = await this.repository.request(tx, requestId);
      if (row.inventory !== INVENTORY_VERSION)
        throw new DeletionError('DELETION_PROTOCOL_VERSION_UNAVAILABLE');
      if (row.phase === 'cancelled' || row.phase === 'completed')
        return status(row);
      const context = await this.repository.context(tx, row.account_id);
      if (row.phase === 'cooling') {
        if (context.now_at < row.eligible_at) return status(row);
        await tx.query(
          "UPDATE whaleu_account_deletion.requests SET phase='erasing',revision=revision+1,irreversible_at=$2 WHERE id=$1",
          [row.id, context.now_at],
        );
        row = await this.repository.request(tx, row.id);
      }
      const cohort =
        (
          await tx.query<{ cohort_id: string }>(
            'SELECT cohort_id FROM whaleu_account_deletion.fixture_media_cohorts WHERE account_id=$1',
            [row.account_id],
          )
        ).rows[0]?.cohort_id ?? null;
      if (cohort !== this.media.cohortId)
        return this.repository.waiting(tx, row, ['MEDIA_COHORT_UNAVAILABLE']);
      let check: Awaited<ReturnType<typeof preflight>>;
      try {
        check = await preflight(tx, context.sandbox_id);
        await baselineProof(tx, row.account_id);
      } catch (error) {
        if (error instanceof DeletionError)
          return this.repository.waiting(tx, row, [error.code]);
        throw error;
      }
      if (check.blockers.length)
        return this.repository.waiting(tx, row, check.blockers);
      const done = new Set(
        (
          await tx.query<{ owner: OwnerKey }>(
            'SELECT owner FROM whaleu_account_deletion.owner_receipts WHERE request_id=$1',
            [row.id],
          )
        ).rows.map((r) => r.owner),
      );
      const owner = order.find((o) => !done.has(o));
      if (!owner) throw new DeletionError('FINALIZATION_RECOVERY_INCONSISTENT');
      await this.repository.cause(tx, row, owner);
      let proof: string | null;
      switch (owner) {
        case 'profile':
          proof = await eraseProfile(tx, row.account_id, row.id);
          break;
        case 'timetable':
          proof = await eraseTimetable(
            tx,
            row.account_id,
            row.id,
            context.now_at,
          );
          break;
        case 'follow-social':
          proof = await eraseFollowSocial(tx, row.id);
          break;
        case 'native-baseline':
          proof = await baselineProof(tx, row.account_id);
          break;
        case 'unsupported-inventory':
          proof = check.proof;
          break;
        case 'media': {
          const result = this.media.settle(row.account_id, row.id, cohort);
          if (result.kind === 'waiting')
            return this.repository.waiting(tx, row, result.pending);
          proof = result.proof;
          await tx.query(
            'INSERT INTO whaleu_account_deletion.media_observations(request_id,cohort_id,generation,proof) VALUES($1,$2,$3,$4)',
            [row.id, cohort, row.generation, proof],
          );
          break;
        }
        case 'identity': {
          // Login/registration takes identity key -> account. This worker already has
          // account -> table locks: never WAIT in the opposite order. A busy key is a
          // retryable waiting state and must not remove the provider mapping.
          const identities = (
            await tx.query<{
              provider: string;
              app_id: string;
              subject: string;
            }>(
              'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1 ORDER BY provider,app_id,subject',
              [row.account_id],
            )
          ).rows;
          if (
            identities.length !== 1 ||
            identities[0]!.provider !== 'wechat' ||
            identities[0]!.app_id !== SYNTHETIC_APP
          )
            throw new DeletionError('SYNTHETIC_IDENTITY_COVERAGE_CHANGED');
          const identity = identities[0]!;
          const locked = (
            await tx.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',
              [
                JSON.stringify([
                  identity.provider,
                  identity.app_id,
                  identity.subject,
                ]),
              ],
            )
          ).rows[0]?.locked;
          if (!locked)
            return this.repository.waiting(tx, row, [
              'IDENTITY_REGISTRATION_LOCK_BUSY',
            ]);
          const media = this.media.settle(row.account_id, row.id, cohort);
          if (media.kind !== 'complete')
            return this.repository.waiting(tx, row, media.pending);
          await tx.query(
            'INSERT INTO whaleu_account_deletion.media_observations(request_id,cohort_id,generation,proof) VALUES($1,$2,$3,$4)',
            [row.id, cohort, row.generation, media.proof],
          );
          proof = await eraseIdentity(tx, row.account_id, row.id);
          break;
        }
      }
      if (proof === null)
        return this.repository.waiting(tx, row, ['OWNER_PAGE_PENDING']);
      await this.repository.proof(tx, row, owner, proof);
      if (owner !== 'identity')
        return this.repository.waiting(tx, row, ['OWNER_WORK_PENDING']);
      // Identity mapping removal, all final owner predicates, completion time and
      // the keyed registration restriction commit in this SAME transaction.
      const final = await preflight(tx, context.sandbox_id, false);
      if (final.blockers.length)
        throw new DeletionError('FINAL_COVERAGE_CHANGED');
      await baselineProof(tx, row.account_id);
      const evidence = (
        await tx.query<{
          owner: OwnerKey;
          generation: string;
          inventory: string;
          proof: string;
        }>(
          'SELECT owner,generation,inventory,proof FROM whaleu_account_deletion.owner_receipts WHERE request_id=$1',
          [row.id],
        )
      ).rows.map((e) => ({
        ...e,
        requestId: row.id,
      })) satisfies OwnerEvidence[];
      validateCompletionEvidence(row.id, row.generation, evidence);
      await tx.query(
        `INSERT INTO whaleu_account_deletion.reregistration_guards(identity_digest,key_version,request_id,completed_at,reregister_after) VALUES($1,'synthetic-explicit-key-v1',$2,$3,$4)`,
        [
          context.identity_digest,
          row.id,
          context.now_at,
          new Date(context.now_at.getTime() + REREGISTRATION_MS),
        ],
      );
      await tx.query(
        "UPDATE whaleu_account_deletion.requests SET phase='completed',revision=revision+1,completed_at=$2,reregister_after=$3,pending='{}' WHERE id=$1",
        [
          row.id,
          context.now_at,
          new Date(context.now_at.getTime() + REREGISTRATION_MS),
        ],
      );
      return status(await this.repository.request(tx, row.id));
    });
  }
}
// Explicit exported protocol identity aids source-level proof review.
export const localDeletionWorkerProtocol = sha([
  'local-synthetic-only',
  ...order,
]);
