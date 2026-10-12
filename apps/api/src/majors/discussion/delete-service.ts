import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { RatingVerificationFacade } from '../../verification/rating-eligibility.facade.js';
import { RatingSafetyFacade } from '../../safety/rating.facade.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import {
  majorDiscussionDeleteReceiptSchema,
  majorDiscussionDeleteCapabilitySchema,
} from './delete-contracts.js';
import type {
  MajorDiscussionDelete,
  MajorDiscussionDeleteCancel,
} from './delete-contracts.js';
export function majorDiscussionDeleteIntentHash(
  actorId: string,
  majorId: string,
  commentId: string,
  command: MajorDiscussionDelete,
) {
  return createHash('sha256')
    .update(
      'whaleu:major-discussion-delete-command:v1\n' +
        canonicalJson({
          actorId,
          majorId,
          commentId,
          operation: 'major.discussion.delete.v1',
          command,
        }),
    )
    .digest('hex');
}
interface Authority {
  kind: 'author' | 'administrator';
}
interface Fact {
  actor: string;
  session: string;
  major: string;
  comment: string;
  root: string | null;
  authority: Authority | null;
  fingerprint: string;
  epoch: string;
}
const captureSql = `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now)
 SELECT whaleu_majors.major_delete_authority($1,$3,$4,$5,instant.now) authority,whaleu_majors.major_access($1,$2,instant.now) access,
 (SELECT revision::text FROM whaleu_majors.major_discussion_epoch WHERE singleton) epoch FROM instant`;
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(
      tx,
      'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
      async (read) => {
        for (const f of facts) {
          await read.query('SELECT whaleu_majors.major_delete_fence($1)', [
            f.authority?.kind !== 'author',
          ]);
          const row = (
            await read.query<{
              authority: Authority | null;
              access: boolean;
              epoch: string;
            }>(captureSql, [f.actor, f.session, f.major, f.comment, f.root])
          ).rows[0];
          if (
            !row?.access ||
            ownerFingerprint(row.authority) !== f.fingerprint ||
            row.epoch !== f.epoch
          )
            throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
        }
      },
    ),
};
@Injectable()
export class MajorDiscussionDeleteService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
  ) {}
  private run<T>(f: (tx: PoolClient) => Promise<T>) {
    return this.db
      .transaction(f, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              String(error.constraint) === 'major_discussion_causal'))
        )
          throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
        throw error;
      });
  }
  private async prior(actor: string, key: string, tx: PoolClient) {
    return (
      await tx.query<{ intent_hash: string; receipt: unknown }>(
        'SELECT intent_hash,receipt FROM whaleu_majors.major_discussion_delete_commands WHERE actor_id=$1 AND request_id=$2',
        [actor, key],
      )
    ).rows[0];
  }
  receipt(token: string, key: string) {
    return this.run(async (tx) => {
      const session = await this.identity.session(token, tx),
        prior = await this.prior(session.accountId, key, tx);
      if (!prior) throw new ApplicationError('REQUEST_NOT_FOUND');
      await this.identity.session(token, tx);
      return majorDiscussionDeleteReceiptSchema.parse(prior.receipt);
    });
  }
  cancel(token: string, key: string, input: MajorDiscussionDeleteCancel) {
    if (key !== input.command.clientRequestId)
      throw new ApplicationError('REQUEST_CONFLICT');
    return this.mutate(
      token,
      input.majorId,
      input.commentId,
      input.command,
      true,
    );
  }
  delete(
    token: string,
    major: string,
    comment: string,
    command: MajorDiscussionDelete,
  ) {
    return this.mutate(token, major, comment, command, false);
  }
  capability(
    token: string,
    major: string,
    comment: string,
    root: string | null,
  ) {
    return this.run(async (tx) => {
      const session = await this.identity.session(token, tx),
        actor = session.accountId;
      await lockSafetyPolicy(tx);
      const phone = await this.verification.phone(actor, tx);
      if (phone.status !== 'verified')
        throw new ApplicationError(
          phone.status === 'unverified'
            ? 'PHONE_VERIFICATION_REQUIRED'
            : 'VERIFICATION_UNAVAILABLE',
        );
      await this.safety.requireAllowed(actor, tx);
      const row = (
        await tx.query<{
          authority: Authority | null;
          access: boolean;
          epoch: string;
        }>(captureSql, [actor, session.sessionId, major, comment, root])
      ).rows[0];
      if (!row?.access || !row.epoch)
        throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
      const until = (
        await tx.query<{ until: string | null }>(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT least(whaleu_majors.major_discussion_access_deadline($1,$2,instant.now),CASE WHEN $3 THEN whaleu_majors.major_discussion_source_boundary(instant.now) END,CASE WHEN $3 THEN (SELECT min(b.value) FROM whaleu_authorization.role_grants g CROSS JOIN LATERAL(VALUES(g.valid_from),(g.expires_at)) b(value) WHERE g.account_id=$1 AND g.revoked_at IS NULL AND b.value>instant.now) END)::text until FROM instant`,
          [actor, session.sessionId, row.authority?.kind !== 'author'],
        )
      ).rows[0]!.until;
      registerTransactionExactDeadline(
        tx,
        until,
        'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
      );
      enableRequiredTransactionProof(tx, proof);
      registerRequiredTransactionFact(
        tx,
        proof,
        comment,
        Object.freeze({
          actor,
          session: session.sessionId,
          major,
          comment,
          root,
          authority: row.authority,
          fingerprint: ownerFingerprint(row.authority),
          epoch: row.epoch,
        }),
      );
      await this.identity.session(token, tx);
      return majorDiscussionDeleteCapabilitySchema.parse({
        majorId: major,
        commentId: comment,
        rootId: root,
        allowed: row.authority !== null,
      });
    });
  }
  private mutate(
    token: string,
    major: string,
    comment: string,
    command: MajorDiscussionDelete,
    cancel: boolean,
  ) {
    return this.run(async (tx) => {
      const session = await this.identity.session(token, tx),
        actor = session.accountId,
        hash = majorDiscussionDeleteIntentHash(actor, major, comment, command);
      await tx.query('SELECT whaleu_majors.major_delete_lock($1,$2,$3)', [
        actor,
        command.clientRequestId,
        comment,
      ]);
      const prior = await this.prior(actor, command.clientRequestId, tx);
      if (prior) {
        if (prior.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        await this.identity.session(token, tx);
        return majorDiscussionDeleteReceiptSchema.parse(prior.receipt);
      }
      const base = {
        requestId: command.clientRequestId,
        operation: 'major.discussion.delete.v1',
        majorId: major,
        commentId: comment,
        rootId: command.rootId,
      };
      let authority: Authority | null = null;
      let result: unknown;
      if (cancel)
        result = {
          ...base,
          outcome: 'rejected',
          code: 'MAJOR_DISCUSSION_CANCELLED',
        };
      else {
        await lockSafetyPolicy(tx);
        const phone = await this.verification.phone(actor, tx);
        if (phone.status !== 'verified')
          throw new ApplicationError(
            phone.status === 'unverified'
              ? 'PHONE_VERIFICATION_REQUIRED'
              : 'VERIFICATION_UNAVAILABLE',
          );
        await this.safety.requireAllowed(actor, tx);
        const capture = (
          await tx.query<{ authority: Authority | null; access: boolean }>(
            captureSql,
            [actor, session.sessionId, major, comment, command.rootId],
          )
        ).rows[0];
        if (!capture?.access || !capture.authority)
          throw new ApplicationError('MAJOR_DISCUSSION_NOT_FOUND');
        authority = capture.authority;
        const until = (
          await tx.query<{ until: string | null }>(
            `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT least(whaleu_majors.major_discussion_access_deadline($1,$2,instant.now),CASE WHEN $3 THEN whaleu_majors.major_discussion_source_boundary(instant.now) END,CASE WHEN $3 THEN (SELECT min(b.value) FROM whaleu_authorization.role_grants g CROSS JOIN LATERAL(VALUES(g.valid_from),(g.expires_at)) b(value) WHERE g.account_id=$1 AND g.revoked_at IS NULL AND b.value>instant.now) END)::text until FROM instant`,
            [actor, session.sessionId, authority.kind === 'administrator'],
          )
        ).rows[0]!.until;
        registerTransactionExactDeadline(
          tx,
          until,
          'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
        );
        let tombstone = (
          await tx.query<{ id: string; recorded_at: Date }>(
            'SELECT id,recorded_at FROM whaleu_majors.major_discussion_tombstones WHERE comment_id=$1',
            [comment],
          )
        ).rows[0];
        const outcome = tombstone ? 'noop' : 'applied';
        if (!tombstone)
          tombstone = (
            await tx.query<{ id: string; recorded_at: Date }>(
              'INSERT INTO whaleu_majors.major_discussion_tombstones(id,major_id,comment_id,actor_id,request_id) VALUES($1,$2,$3,$4,$5) RETURNING id,recorded_at',
              [randomUUID(), major, comment, actor, command.clientRequestId],
            )
          ).rows[0]!;
        result = {
          ...base,
          outcome,
          tombstoneId: tombstone.id,
          recordedAt: tombstone.recorded_at.toISOString(),
        };
      }
      const receipt = majorDiscussionDeleteReceiptSchema.parse(result);
      await tx.query(
        'INSERT INTO whaleu_majors.major_discussion_delete_commands(actor_id,request_id,session_id,major_id,comment_id,command,intent_hash,receipt,authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          actor,
          command.clientRequestId,
          session.sessionId,
          major,
          comment,
          command,
          hash,
          receipt,
          authority,
        ],
      );
      if (authority) {
        const epoch = (
          await tx.query<{ epoch: string }>(
            'SELECT revision::text epoch FROM whaleu_majors.major_discussion_epoch WHERE singleton',
          )
        ).rows[0]?.epoch;
        if (!epoch)
          throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
        enableRequiredTransactionProof(tx, proof);
        registerRequiredTransactionFact(
          tx,
          proof,
          comment,
          Object.freeze({
            actor,
            session: session.sessionId,
            major,
            comment,
            root: command.rootId,
            authority,
            fingerprint: ownerFingerprint(authority),
            epoch,
          }),
        );
      }
      await this.identity.session(token, tx);
      return receipt;
    });
  }
}
