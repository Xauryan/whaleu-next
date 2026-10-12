import { hashToken } from '../../identity/tokens.js';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { RatingVerificationFacade } from '../../verification/rating-eligibility.facade.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { floorDetailSchema, floorReceiptSchema } from './contracts.js';
import type { FloorSetScore, FloorReceipt, FloorCancel } from './contracts.js';
import { FloorRepository } from './repository.js';
import {
  catalogSource,
  floorSource,
  floorEpoch,
  retainFloors,
  retainFloorSession,
} from './proof.js';
export function floorIntentHash(
  actorId: string,
  floorId: string,
  command: FloorSetScore,
) {
  return createHash('sha256')
    .update(
      'whaleu:floor-score-first:v1\n' +
        canonicalJson({ actorId, floorId, command }),
    )
    .digest('hex');
}
@Injectable()
export class FloorRatingsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(FloorRepository) private readonly records: FloorRepository,
  ) {}
  private run<T>(f: (tx: PoolClient) => Promise<T>) {
    return this.db
      .transaction(f, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              error.constraint === 'floor_score_causal'))
        )
          throw new ApplicationError('FLOOR_HISTORY_UNAVAILABLE');
        throw error;
      });
  }
  private async session(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    const session = await this.identity.session(token, tx);
    await retainFloorSession(
      session.accountId,
      session.sessionId,
      hashToken(token),
      tx,
    );
    return session;
  }
  private async eligible(actor: string, tx: PoolClient) {
    const phone = await this.verification.phone(actor, tx);
    if (phone.status !== 'verified')
      throw new ApplicationError(
        phone.status === 'unverified'
          ? 'PHONE_VERIFICATION_REQUIRED'
          : 'VERIFICATION_UNAVAILABLE',
      );
    await this.safety.requireAllowed(actor, tx);
    return {
      phone: phone.fingerprint,
      safety: await this.safety.navigation(tx),
    };
  }
  catalog(token: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      await this.eligible(session.accountId, tx);
      const source = await catalogSource(tx),
        epoch = await floorEpoch(tx),
        result = await this.records.catalog(source.catalog, tx);
      await retainFloors(
        session.accountId,
        session.sessionId,
        source,
        tx,
        epoch,
      );
      await this.identity.session(token, tx);
      return result;
    });
  }
  detail(token: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      await this.eligible(session.accountId, tx);
      const source = await catalogSource(tx),
        epoch = await floorEpoch(tx),
        floor = await this.records.detail(source.catalog, id, tx),
        myScore = await this.records.own(id, session.accountId, tx);
      await retainFloors(
        session.accountId,
        session.sessionId,
        source,
        tx,
        epoch,
      );
      await this.identity.session(token, tx);
      return floorDetailSchema.parse({
        catalogRevision: source.catalog,
        floor,
        myScore,
      });
    });
  }
  async own(token: string, id: string) {
    return (await this.detail(token, id)).myScore;
  }
  async summary(token: string, id: string) {
    return (await this.detail(token, id)).floor.summary;
  }
  private async prior(actor: string, key: string, tx: PoolClient) {
    return (
      await tx.query<{ intent_hash: string; receipt: unknown }>(
        'SELECT intent_hash,receipt FROM whaleu_ratings.floor_commands WHERE actor_id=$1 AND request_id=$2',
        [actor, key],
      )
    ).rows[0];
  }
  private async record(
    actor: string,
    session: string,
    id: string,
    command: FloorSetScore,
    receipt: FloorReceipt,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_ratings.floor_commands(actor_id,request_id,session_id,floor_id,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        actor,
        command.clientRequestId,
        session,
        id,
        command,
        floorIntentHash(actor, id, command),
        receipt,
      ],
    );
  }
  private async replay(
    actor: string,
    id: string,
    command: FloorSetScore,
    tx: PoolClient,
  ) {
    const prior = await this.prior(actor, command.clientRequestId, tx);
    if (!prior) return null;
    if (prior.intent_hash !== floorIntentHash(actor, id, command))
      throw new ApplicationError('REQUEST_CONFLICT');
    return floorReceiptSchema.parse(prior.receipt);
  }
  setScore(
    token: string,
    id: string,
    command: FloorSetScore,
  ): Promise<FloorReceipt> {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId;
      await tx.query('SELECT whaleu_ratings.floor_lock($1,$2,$3)', [
        actor,
        command.clientRequestId,
        id,
      ]);
      const prior = await this.replay(actor, id, command, tx);
      if (prior) {
        await this.identity.session(token, tx);
        return prior;
      }
      await this.eligible(actor, tx);
      const catalog = await catalogSource(tx),
        source = await floorSource(id, tx);
      if (!source.history)
        throw new ApplicationError('FLOOR_HISTORY_UNAVAILABLE');
      const own = await this.records.score(id, actor, tx),
        base = {
          requestId: command.clientRequestId,
          operation: 'floor.score.first.v1' as const,
          floorId: id,
        };
      let receipt: FloorReceipt;
      if (
        source.catalog !== command.expectedCatalogRevision ||
        source.revision !== command.expectedCanteenRevision
      )
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'FLOOR_REVISION_CONFLICT',
        };
      else if (own)
        receipt = { ...base, outcome: 'rejected', code: 'FLOOR_ALREADY_RATED' };
      else {
        const revision = randomUUID(),
          event = (
            await tx.query<{ recorded_at: Date }>(
              'INSERT INTO whaleu_ratings.floor_score_events(id,floor_id,actor_id,request_id,catalog_id,canteen_revision,history_assertion_id,score) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING recorded_at',
              [
                revision,
                id,
                actor,
                command.clientRequestId,
                source.catalog,
                source.revision,
                source.history,
                command.score,
              ],
            )
          ).rows[0]!;
        await tx.query(
          'INSERT INTO whaleu_ratings.floor_score_heads(floor_id,actor_id,revision) VALUES($1,$2,$3)',
          [id, actor, revision],
        );
        receipt = {
          ...base,
          outcome: 'applied',
          score: command.score,
          scoreRevision: revision,
          recordedAt: event.recorded_at.toISOString(),
        };
      }
      await this.record(actor, session.sessionId, id, command, receipt, tx);
      await retainFloors(actor, session.sessionId, catalog, tx);
      await this.identity.session(token, tx);
      return floorReceiptSchema.parse(receipt);
    });
  }
  receipt(token: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        prior = await this.prior(session.accountId, id, tx);
      if (!prior) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.identity.session(token, tx);
      return floorReceiptSchema.parse(prior.receipt);
    });
  }
  cancel(token: string, id: string, body: FloorCancel) {
    return this.run(async (tx) => {
      if (id !== body.command.clientRequestId)
        throw new ApplicationError('REQUEST_CONFLICT');
      const session = await this.session(token, tx),
        actor = session.accountId;
      await tx.query('SELECT whaleu_ratings.floor_lock($1,$2,$3)', [
        actor,
        id,
        body.floorId,
      ]);
      const prior = await this.replay(actor, body.floorId, body.command, tx);
      if (prior) {
        await this.identity.session(token, tx);
        return prior;
      }
      if (
        !(
          await tx.query(
            'SELECT 1 FROM whaleu_ratings.window_floor_identities WHERE id=$1',
            [body.floorId],
          )
        ).rowCount
      )
        throw new ApplicationError('FLOOR_NOT_FOUND');
      const receipt: FloorReceipt = {
        requestId: id,
        operation: 'floor.score.first.v1',
        floorId: body.floorId,
        outcome: 'rejected',
        code: 'FLOOR_SCORE_CANCELLED',
      };
      await this.record(
        actor,
        session.sessionId,
        body.floorId,
        body.command,
        receipt,
        tx,
      );
      await this.identity.session(token, tx);
      return receipt;
    });
  }
}
