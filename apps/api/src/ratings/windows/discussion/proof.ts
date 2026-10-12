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
export interface DiscussionSource {
  catalog: string;
  revision: string;
  population: string | null;
  likes: string | null;
}
export async function discussionSource(id: string, tx: PoolClient) {
  const row = (
    await tx.query<{ source: DiscussionSource | null; until: string | null }>(
      `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_ratings.window_discussion_source($1,instant.now) source,whaleu_ratings.window_discussion_deadline($1,instant.now)::text until FROM instant`,
      [id],
    )
  ).rows[0]!;
  if (!row.source) throw new ApplicationError('WINDOW_NOT_FOUND');
  if (!row.source.population || !row.source.likes)
    throw new ApplicationError('WINDOW_DISCUSSION_HISTORY_UNAVAILABLE');
  registerTransactionExactDeadline(
    tx,
    row.until,
    'WINDOW_DISCUSSION_HISTORY_UNAVAILABLE',
  );
  return row.source;
}
export async function discussionEpoch(tx: PoolClient) {
  const r = (
    await tx.query<{ content: string; review: string }>(
      'SELECT c.revision::text content,r.revision::text review FROM whaleu_ratings.window_discussion_epoch c CROSS JOIN whaleu_community.window_discussion_review_epoch r WHERE c.singleton AND r.singleton',
    )
  ).rows[0];
  if (!r) throw new ApplicationError('WINDOW_DISCUSSION_HISTORY_UNAVAILABLE');
  return r;
}
interface Fact {
  actor: string;
  session: string;
  window: string;
  epoch: string;
  review: string | null;
  source: string | null;
  history: string | null;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 50,
  failureCode: 'WINDOW_DISCUSSION_HISTORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(
      tx,
      'WINDOW_DISCUSSION_HISTORY_UNAVAILABLE',
      async (read) => {
        await read.query('SELECT whaleu_ratings.window_discussion_fence()');
        const epoch = await discussionEpoch(read);
        for (const f of facts) {
          const row = (
            await read.query<{
              session: boolean;
              access: boolean;
              source: DiscussionSource | null;
              history: string | null;
            }>(
              `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_identity.window_rating_session($1,$2,instant.now) session,whaleu_ratings.window_access($1,$2,instant.now) access,whaleu_ratings.window_discussion_source($3,instant.now) source,whaleu_ratings.window_discussion_history($3,'likes',instant.now)::text history FROM instant`,
              [f.actor, f.session, f.window],
            )
          ).rows[0]!;
          if (
            !row.session ||
            epoch.content !== f.epoch ||
            (f.review !== null && epoch.review !== f.review) ||
            (f.source !== null &&
              (!row.access || ownerFingerprint(row.source) !== f.source)) ||
            (f.history !== null && row.history !== f.history)
          )
            throw new ApplicationError('WINDOW_DISCUSSION_HISTORY_UNAVAILABLE');
        }
      },
    ),
};
export async function retainDiscussion(
  actor: string,
  session: string,
  window: string,
  tx: PoolClient,
  options: {
    source?: DiscussionSource;
    observation?: DiscussionSource | null;
    epoch?: Awaited<ReturnType<typeof discussionEpoch>>;
    history?: string;
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
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT least(whaleu_ratings.window_discussion_access_deadline($1,$2,instant.now),whaleu_ratings.window_discussion_source_boundary(instant.now),whaleu_ratings.window_discussion_deadline($3,instant.now))::text until FROM instant`,
        [actor, session, window],
      )
    ).rows[0]!;
    registerTransactionExactDeadline(
      tx,
      row.until,
      'WINDOW_DISCUSSION_HISTORY_UNAVAILABLE',
    );
  }
  // A session-only known-absence read has already retained its independent
  // like-history boundary. It must not inherit unrelated phone/Safety/catalog time.

  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    window,
    Object.freeze({
      actor,
      session,
      window,
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
