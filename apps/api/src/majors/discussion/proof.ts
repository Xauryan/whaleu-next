import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
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
export interface DiscussionSource {
  catalog: string;
  revision: string;
  owner: string;
  population: string | null;
  likes: string | null;
}
export async function discussionSource(id: string, tx: PoolClient) {
  const row = (
    await tx.query<{ source: DiscussionSource | null; until: string | null }>(
      `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_majors.major_discussion_source($1,instant.now) source,whaleu_majors.major_discussion_deadline($1,instant.now)::text until FROM instant`,
      [id],
    )
  ).rows[0]!;
  if (!row.source) throw new ApplicationError('MAJOR_NOT_FOUND');
  if (!row.source.population || !row.source.likes)
    throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
  registerTransactionExactDeadline(
    tx,
    row.until,
    'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
  );
  return row.source;
}
export const majorDiscussionEpochSql = `SELECT
 (SELECT revision::text FROM whaleu_majors.major_discussion_epoch WHERE singleton) content,
 (SELECT revision::text FROM whaleu_community.major_discussion_review_epoch WHERE singleton) review`;
export async function discussionEpoch(tx: PoolClient) {
  const r = (
    await tx.query<{ content: string | null; review: string | null }>(
      majorDiscussionEpochSql,
    )
  ).rows[0];
  if (!r?.content || !r.review)
    throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
  return { content: r.content, review: r.review };
}
interface Fact {
  actor: string;
  session: string;
  major: string;
  epoch: string;
  review: string | null;
  source: string | null;
  history: string | null;
  publish: boolean;
}
export const majorDiscussionProofSql = `
 WITH instant AS MATERIALIZED(SELECT clock_timestamp() now),
 inputs AS MATERIALIZED(SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::boolean[]) WITH ORDINALITY f(actor,session_id,major_id,publish,ordinal)),
 sources AS MATERIALIZED(SELECT s.* FROM instant CROSS JOIN LATERAL whaleu_majors.major_discussion_sources($3::uuid[],instant.now) s)
 SELECT inputs.ordinal::text ordinal,inputs.major_id,
  whaleu_identity.major_rating_session(inputs.actor,inputs.session_id,instant.now) session,
  whaleu_majors.major_access(inputs.actor,inputs.session_id,instant.now) access,
  CASE WHEN inputs.publish THEN whaleu_majors.major_publish_base(inputs.actor,instant.now) ELSE true END base,
  sources.source,whaleu_majors.major_discussion_history(inputs.major_id,'likes',instant.now)::text history
 FROM inputs CROSS JOIN instant LEFT JOIN sources ON sources.ordinal=inputs.ordinal AND sources.major_id=inputs.major_id
 ORDER BY inputs.ordinal`;
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 50,
  failureCode: 'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(
      tx,
      'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
      async (read) => {
        await read.query('SELECT whaleu_majors.major_discussion_fence()');
        const epoch = await discussionEpoch(read);
        const rows = (
          await read.query<{
            ordinal: string;
            major_id: string;
            session: boolean;
            access: boolean;
            base: boolean;
            source: DiscussionSource | null;
            history: string | null;
          }>(majorDiscussionProofSql, [
            facts.map((f) => f.actor),
            facts.map((f) => f.session),
            facts.map((f) => f.major),
            facts.map((f) => f.publish),
          ])
        ).rows;
        if (rows.length !== facts.length)
          throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
        for (const [index, f] of facts.entries()) {
          const row = rows[index]!;
          if (
            row.ordinal !== String(index + 1) ||
            row.major_id !== f.major ||
            !row.session ||
            (f.publish && !row.base) ||
            epoch.content !== f.epoch ||
            (f.review !== null && epoch.review !== f.review) ||
            (f.source !== null &&
              (!row.access || ownerFingerprint(row.source) !== f.source)) ||
            (f.history !== null && row.history !== f.history)
          )
            throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
        }
      },
    ),
};
export async function retainDiscussion(
  actor: string,
  session: string,
  major: string,
  tx: PoolClient,
  options: {
    source?: DiscussionSource;
    observation?: DiscussionSource | null;
    epoch?: Awaited<ReturnType<typeof discussionEpoch>>;
    history?: string;
    publish?: boolean;
  } = {},
) {
  const epoch = await discussionEpoch(tx);
  if (
    options.epoch &&
    (epoch.content !== options.epoch.content ||
      epoch.review !== options.epoch.review)
  )
    throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
  if (options.source || 'observation' in options) {
    const row = (
      await tx.query<{ until: string | null }>(
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT least(whaleu_majors.major_discussion_access_deadline($1,$2,instant.now),whaleu_majors.major_discussion_source_boundary(instant.now),whaleu_majors.major_discussion_deadline($3,instant.now))::text until FROM instant`,
        [actor, session, major],
      )
    ).rows[0]!;
    registerTransactionExactDeadline(
      tx,
      row.until,
      'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
    );
  }
  // A session-only known-absence read has already retained its independent
  // like-history boundary. It must not inherit unrelated phone/Safety/catalog time.

  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    major,
    Object.freeze({
      actor,
      session,
      publish: options.publish ?? false,
      major,
      epoch: epoch.content,
      review: options.source || 'observation' in options ? epoch.review : null,
      source: options.source
        ? ownerFingerprint(options.source)
        : 'observation' in options
          ? ownerFingerprint(options.observation)
          : null,
      history: options.history ?? null,
    }),
  );
}
