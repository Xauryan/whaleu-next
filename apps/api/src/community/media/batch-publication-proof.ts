import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type {
  MediaBatchPublicationProofPort,
  PublicationMediaContext,
} from '../../media/batch-repository.js';
import type { MediaBatchPublicationCancellation } from '../../media/contracts-v3.js';
import { publicationReferenceSchema } from '../../media/contracts-v2.js';
import { lockPublicationCommand } from '../publication-cancel-fence.js';
import { z } from 'zod';
const actualReceipt = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: z.uuid(),
    operation: z.literal('publish_post'),
    outcome: z.literal('rejected'),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  }),
  z.strictObject({
    requestId: z.uuid(),
    operation: z.literal('publish_post'),
    outcome: z.literal('created'),
    resourceId: z.uuid(),
    createdAt: z.string().datetime(),
  }),
]);
interface RequestRow {
  payload_hash: string;
  operation: string;
  receipt: unknown;
}
/** Community owns cancellation evidence as well as publication receipts. A
 * cancellation is a distinct durable result, never a fabricated Review rejection. */
export class CommunityMediaBatchPublicationProof implements MediaBatchPublicationProofPort {
  async requireNonCreatedTerminal(
    actor: string,
    raw: PublicationMediaContext,
    tx: PoolClient,
  ): Promise<void> {
    const reference = publicationReferenceSchema.parse(raw);
    await lockPublicationCommand(actor, reference.clientRequestId, tx);
    if (await this.fence(actor, reference, tx)) return;
    const row = await this.request(actor, reference, tx);
    const receipt = actualReceipt.safeParse(row?.receipt);
    if (
      !receipt.success ||
      receipt.data.outcome !== 'rejected' ||
      receipt.data.requestId !== reference.clientRequestId
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
  }
  async fenceNonCreated(
    actor: string,
    raw: PublicationMediaContext,
    tx: PoolClient,
  ): Promise<MediaBatchPublicationCancellation> {
    const reference = publicationReferenceSchema.parse(raw);
    await lockPublicationCommand(actor, reference.clientRequestId, tx);
    // Historical success wins. The key lock and row lock use the exact same
    // serialization point as PublicationRepository.execute before owner work.
    const row = await this.request(actor, reference, tx);
    if (row?.receipt !== null && row?.receipt !== undefined) {
      const receipt = actualReceipt.safeParse(row.receipt);
      if (
        !receipt.success ||
        receipt.data.requestId !== reference.clientRequestId
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      return receipt.data;
    }
    if (!(await this.fence(actor, reference, tx))) {
      // Same-account quota lock serializes different cancelled keys. No prior
      // terminal fence is evicted in order to admit another request.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `whaleu:publication-cancel-budget:v1:${actor}`,
      ]);
      const count = (
        await tx.query<{ n: number }>(
          "SELECT count(*)::integer n FROM whaleu_community.publication_cancel_fences WHERE account_id=$1 AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
          [actor],
        )
      ).rows[0]?.n;
      if (count === undefined || count >= 128)
        throw new ApplicationError('MEDIA_RATE_LIMITED');
      await tx.query(
        'INSERT INTO whaleu_community.publication_cancel_fences(account_id,client_request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
        [
          actor,
          reference.clientRequestId,
          reference.operation,
          reference.intentHash,
        ],
      );
    }
    return {
      requestId: reference.clientRequestId,
      operation: 'publish_post',
      outcome: 'cancelled',
      intentHash: reference.intentHash,
    };
  }
  private async request(
    actor: string,
    reference: PublicationMediaContext,
    tx: PoolClient,
  ): Promise<RequestRow | undefined> {
    const row = (
      await tx.query<RequestRow>(
        'SELECT payload_hash,operation,receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE',
        [actor, reference.clientRequestId],
      )
    ).rows[0];
    if (
      row &&
      (row.payload_hash !== reference.intentHash ||
        row.operation !== reference.operation)
    )
      throw new ApplicationError('REQUEST_CONFLICT');
    return row;
  }
  private async fence(
    actor: string,
    reference: PublicationMediaContext,
    tx: PoolClient,
  ): Promise<boolean> {
    const row = (
      await tx.query<{ operation: string; intent_hash: string }>(
        'SELECT operation,intent_hash FROM whaleu_community.publication_cancel_fences WHERE account_id=$1 AND client_request_id=$2',
        [actor, reference.clientRequestId],
      )
    ).rows[0];
    if (
      row &&
      (row.operation !== reference.operation ||
        row.intent_hash !== reference.intentHash)
    )
      throw new ApplicationError('REQUEST_CONFLICT');
    return !!row;
  }
}
