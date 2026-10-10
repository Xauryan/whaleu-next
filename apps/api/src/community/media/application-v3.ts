import { withDiscussionMediaMutation } from '../../media/discussion-ancestor-proof.js';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.js';
import type { CurrentMediaSession } from '../../identity/current-media-session.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../database/transaction-deadlines.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import type { CommunityAccessService } from '../community-access.service.js';
import type { MediaBatchApplication } from '../../media/application-v3.js';
import type { MediaIngressClaim } from '../../media/application-v2.js';
import type { MediaPrepareScopes } from '../../media/prepare-scope.js';
import type { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import type { MediaIngressRepository } from '../../media/ingress-repository.js';
import type { MediaBatchRepository } from '../../media/batch-repository.js';
import type { StoredObjectMeasurement } from '../../media/storage-port.js';
import { prepareMediaV3Schema } from '../../media/contracts-v3.js';
import { prepareMediaV4Schema } from '../../media/contracts-v4.js';
import { lockMediaBatchesForIntents } from '../../media/batch-locks.js';
import { lockMediaActor } from '../../media/intent-repository.js';

export class UnavailableCommunityMediaBatchApplication implements MediaBatchApplication {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: CommunityAccessService,
  ) {}
  private unavailable(token: string): Promise<never> {
    return this.database.transaction(
      async (tx) => {
        await this.access.mediaSession(token, tx);
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      },
      { isolationLevel: 'read committed' },
    );
  }
  fencePublication(token: string): Promise<never> {
    return this.unavailable(token);
  }
  prepareBatch(token: string): Promise<never> {
    return this.unavailable(token);
  }
  recoverBatch(token: string): Promise<never> {
    return this.unavailable(token);
  }
  cancelBatch(token: string): Promise<never> {
    return this.unavailable(token);
  }
  recoverPublication(token: string): Promise<never> {
    return this.unavailable(token);
  }
  layout(token: string): Promise<never> {
    return this.unavailable(token);
  }
  seal(token: string): Promise<never> {
    return this.unavailable(token);
  }
  reopen(token: string): Promise<never> {
    return this.unavailable(token);
  }
  prepareMember(token: string): Promise<never> {
    return this.unavailable(token);
  }
  memberStatus(token: string): Promise<never> {
    return this.unavailable(token);
  }
  finalizeMember(token: string): Promise<never> {
    return this.unavailable(token);
  }
  cancelMember(token: string): Promise<never> {
    return this.unavailable(token);
  }
  grant(token: string): Promise<never> {
    return this.unavailable(token);
  }
  admit(token: string): Promise<never> {
    return this.unavailable(token);
  }
  observe(token: string): Promise<never> {
    return this.unavailable(token);
  }
  retire(): Promise<never> {
    return Promise.reject(new ApplicationError('MEDIA_UNAVAILABLE'));
  }
}
/** Constructor-only synthetic wiring. Uses the identical v2 parser/storage and
 * protocol-dispatched intent/recovery/ingress engines; no production flag. */
export class CommunityMediaBatchApplication {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: CommunityAccessService,
    private readonly scopes: MediaPrepareScopes,
    private readonly lifecycle: MediaLifecycleRepository,
    private readonly batches: MediaBatchRepository,
    private readonly ingress: MediaIngressRepository,
  ) {}
  fencePublication(token: string, id: string, input: unknown) {
    return this.authorized(token, (s, tx) =>
      this.batches.fencePublication(s.accountId, id, input, tx),
    );
  }
  prepareBatch(token: string, input: unknown) {
    return this.authorized(token, (s, tx) =>
      this.batches.prepare(s.accountId, input, tx),
    );
  }
  recoverBatch(token: string, id: string) {
    return this.authorized(
      token,
      (s, tx) => this.batches.recover(s.accountId, id, tx),
      false,
    );
  }
  async cancelBatch(token: string, id: string, input: unknown) {
    const fenced = await this.authorized(token, (s, tx) =>
      this.batches.beginCancel(s.accountId, id, input, tx),
    );
    if (
      fenced.state !== 'recorded' ||
      fenced.status.status !== 'cancelling' ||
      !fenced.status.batchId
    )
      return fenced;
    const batchId = fenced.status.batchId;
    const status = await this.authorized(token, (s, tx) =>
      this.batches.finishCancellation(s.accountId, batchId, tx),
    );
    return {
      version: this.batches.protocolVersion,
      state: 'recorded' as const,
      status,
    };
  }
  recoverPublication(token: string, input: unknown) {
    return this.authorized(
      token,
      (s, tx) => this.batches.recoverPublication(s.accountId, input, tx),
      false,
    );
  }
  layout(token: string, id: string, input: unknown) {
    return this.authorized(token, (s, tx) =>
      this.batches.layout(s.accountId, id, input, tx),
    );
  }
  seal(token: string, id: string, input: unknown) {
    return this.authorized(token, (s, tx) =>
      this.batches.seal(s.accountId, id, input, tx),
    );
  }
  reopen(token: string, id: string, input: unknown) {
    return this.authorized(token, (s, tx) =>
      this.batches.reopen(s.accountId, id, input, tx),
    );
  }
  prepareMember(token: string, id: string, input: unknown) {
    return this.authorized(token, (s, tx) =>
      this.batches.prepareMember(s.accountId, id, input, tx),
    );
  }
  memberStatus(token: string, id: string) {
    return this.authorized(
      token,
      (s, tx) => this.batches.memberStatus(s.accountId, id, tx),
      false,
    );
  }
  async finalizeMember(token: string, id: string) {
    const status = await this.memberStatus(token, id);
    if (
      ['bound_history', 'terminal', 'ready_unbound', 'unavailable'].includes(
        status.observation.status,
      )
    )
      return status;
    return this.authorized(token, async (s, tx) => {
      await this.scopes.authorizeBatch(
        s.accountId,
        (this.batches.protocolVersion === 4
          ? prepareMediaV4Schema
          : prepareMediaV3Schema
        ).parse(await this.ingress.originalInput(s.accountId, id, tx)),
        tx,
      );
      await this.requireEditing(s.accountId, id, tx);
      await this.lifecycle.finalize(s.accountId, id, tx);
      return this.batches.memberStatus(s.accountId, id, tx);
    });
  }
  cancelMember(token: string, id: string) {
    return this.authorized(token, async (s, tx) => {
      await lockMediaBatchesForIntents([id], tx, true);
      await lockMediaActor(s.accountId, tx);
      const checkpoint = checkpointTransactionDeadlines(tx);
      const status = await this.batches.memberStatus(s.accountId, id, tx);
      if (
        status.observation.status === 'bound_history' ||
        status.observation.status === 'terminal'
      )
        return status;
      restoreTransactionDeadlines(tx, checkpoint);
      await this.requireEditing(s.accountId, id, tx);
      await this.batches.recovery.cancel(s.accountId, id, tx);
      return this.batches.memberStatus(s.accountId, id, tx);
    });
  }
  async grant(token: string, id: string) {
    const result = await this.authorized(token, async (s, tx) =>
      this.ingress.grant(
        s,
        id,
        await this.scopes.authorizeBatch(
          s.accountId,
          (this.batches.protocolVersion === 4
            ? prepareMediaV4Schema
            : prepareMediaV3Schema
          ).parse(await this.ingress.originalInput(s.accountId, id, tx)),
          tx,
        ),
        this.scopes,
        tx,
      ),
    );
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    return result;
  }
  admit(token: string, id: string, grantId: string) {
    return this.authorized(token, async (s, tx) =>
      this.ingress.admit(
        s,
        id,
        grantId,
        await this.scopes.authorizeBatch(
          s.accountId,
          (this.batches.protocolVersion === 4
            ? prepareMediaV4Schema
            : prepareMediaV3Schema
          ).parse(await this.ingress.originalInput(s.accountId, id, tx)),
          tx,
        ),
        this.scopes,
        tx,
      ),
    );
  }
  observe(
    token: string,
    claim: MediaIngressClaim,
    measurement: StoredObjectMeasurement,
  ) {
    return this.authorized(token, async (s, tx) =>
      this.ingress.observe(
        s,
        claim,
        measurement,
        await this.scopes.authorizeBatch(
          s.accountId,
          (this.batches.protocolVersion === 4
            ? prepareMediaV4Schema
            : prepareMediaV3Schema
          ).parse(
            await this.ingress.originalInput(s.accountId, claim.intentId, tx),
          ),
          tx,
        ),
        this.scopes,
        tx,
      ),
    );
  }
  retire(
    claim: MediaIngressClaim,
    proof?: unknown,
    transferredBytes = 0,
  ): Promise<void> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        if (await this.ingress.retire(claim, proof, transferredBytes, tx))
          await this.batches.recovery.cancel(
            claim.actorAccountId,
            claim.intentId,
            tx,
          );
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async requireEditing(
    actor: string,
    id: string,
    tx: PoolClient,
  ): Promise<void> {
    await lockMediaBatchesForIntents([id], tx, true);
    const row = await tx.query(
      `SELECT 1 FROM whaleu_media.publication_batch_members m JOIN whaleu_media.publication_batches b ON b.id=m.batch_id WHERE m.intent_id=$1 AND m.actor_id=$2 AND m.state='live' AND b.state='editing'`,
      [id, actor],
    );
    if (row.rowCount !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
  }
  private authorized<T>(
    token: string,
    run: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    write = true,
  ): Promise<T> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, write);
        const session = await this.access.mediaSession(token, tx);
        return this.batches.protocolVersion === 4 && write
          ? withDiscussionMediaMutation(
              tx,
              { actor: session.accountId, protocolVersion: 4 },
              () => run(session, tx),
            )
          : run(session, tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
}
