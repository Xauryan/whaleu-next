import type { PoolClient } from 'pg';
import { ApplicationError } from '../../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../../database/transaction-deadlines.js';
export interface CommentSource {
  catalog: string;
  revision: string;
  population: string | null;
  likes: string | null;
}
export async function commentSource(courseId: string, tx: PoolClient) {
  const source = (
    await tx.query<{ source: CommentSource | null }>(
      'SELECT whaleu_ratings.course_comment_source($1,clock_timestamp()) source',
      [courseId],
    )
  ).rows[0]!.source;
  if (!source) throw new ApplicationError('COURSE_CATALOG_UNAVAILABLE');
  if (!source.population || !source.likes)
    throw new ApplicationError('COURSE_COMMENT_HISTORY_UNAVAILABLE');
  return source;
}
export async function commentEpoch(tx: PoolClient) {
  const row = (
    await tx.query<{ revision: string }>(
      'SELECT revision::text FROM whaleu_ratings.course_comment_epoch WHERE singleton',
    )
  ).rows[0];
  if (!row) throw new ApplicationError('COURSE_COMMENT_HISTORY_UNAVAILABLE');
  return row.revision;
}
interface Fact {
  actor: string;
  session: string;
  course: string;
  publish: boolean;
  source: string;
  epoch: string;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 2,
  failureCode: 'COURSE_COMMENT_HISTORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(
      tx,
      'COURSE_COMMENT_HISTORY_UNAVAILABLE',
      async (read) => {
        await read.query('SELECT whaleu_ratings.course_comment_fence()');
        const revision = await commentEpoch(read);
        for (const f of facts) {
          const row = (
            await read.query<{ allowed: boolean; source: CommentSource }>(
              'WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_ratings.course_comment_access($1,$2,$3,$4,instant.now) allowed,whaleu_ratings.course_comment_source($3,instant.now) source FROM instant',
              [f.actor, f.session, f.course, f.publish],
            )
          ).rows[0]!;
          if (
            !row.allowed ||
            ownerFingerprint(row.source) !== f.source ||
            revision !== f.epoch
          )
            throw new ApplicationError('COURSE_COMMENT_HISTORY_UNAVAILABLE');
        }
      },
    ),
};
export async function retainComments(
  actor: string,
  session: string,
  course: string,
  publish: boolean,
  source: CommentSource,
  tx: PoolClient,
  expectedEpoch?: string,
) {
  const revision = await commentEpoch(tx);
  if (expectedEpoch !== undefined && revision !== expectedEpoch)
    throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
  const until = (
    await tx.query<{ until: string | null }>(
      'SELECT whaleu_ratings.course_comment_deadline($1,$2,$3,$4,clock_timestamp())::text until',
      [actor, session, course, publish],
    )
  ).rows[0]!.until;
  registerTransactionExactDeadline(
    tx,
    until,
    'COURSE_COMMENT_HISTORY_UNAVAILABLE',
  );
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    course,
    Object.freeze({
      actor,
      session,
      course,
      publish,
      source: ownerFingerprint(source),
      epoch: revision,
    }),
  );
  return revision;
}
