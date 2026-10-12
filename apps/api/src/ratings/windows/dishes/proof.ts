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
export interface DishSource {
  catalog: string;
  revision: string;
  population: string | null;
  membership: string | null;
}
export async function dishSource(id: string, tx: PoolClient) {
  const row = (
    await tx.query<{ source: DishSource | null; until: string | null }>(
      `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_ratings.dish_source($1,instant.now) source,whaleu_ratings.dish_deadline($1,instant.now)::text until FROM instant`,
      [id],
    )
  ).rows[0]!;
  if (!row.source) throw new ApplicationError('WINDOW_NOT_FOUND');
  if (!row.source.population || !row.source.membership)
    throw new ApplicationError('DISH_HISTORY_UNAVAILABLE');
  registerTransactionExactDeadline(tx, row.until, 'DISH_HISTORY_UNAVAILABLE');
  return row.source;
}
export async function dishEpoch(tx: PoolClient) {
  const row = (
    await tx.query<{ membership: string; review: string }>(
      'SELECT d.revision::text membership,r.revision::text review FROM whaleu_ratings.dish_epoch d CROSS JOIN whaleu_community.dish_review_epoch r WHERE d.singleton AND r.singleton',
    )
  ).rows[0];
  if (!row) throw new ApplicationError('DISH_HISTORY_UNAVAILABLE');
  return row;
}
interface Fact {
  actor: string;
  session: string;
  window: string;
  epoch: string;
  review: string | null;
  source: string | null;
  catalog: string | null;
  history: string | null;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'DISH_HISTORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'DISH_HISTORY_UNAVAILABLE', async (read) => {
      await read.query('SELECT whaleu_ratings.dish_fence()');
      const epoch = await dishEpoch(read);
      for (const f of facts) {
        const row = (
          await read.query<{
            session: boolean;
            access: boolean;
            source: DishSource | null;
            catalog: unknown;
            history: string | null;
          }>(
            `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_identity.window_rating_session($1,$2,instant.now) session,whaleu_ratings.window_access($1,$2,instant.now) access,whaleu_ratings.dish_source($3,instant.now) source,whaleu_ratings.window_catalog_source(instant.now) catalog,whaleu_ratings.dish_history($3,'membership',instant.now)::text history FROM instant`,
            [f.actor, f.session, f.window],
          )
        ).rows[0]!;
        if (
          !row.session ||
          epoch.membership !== f.epoch ||
          (f.review !== null && epoch.review !== f.review) ||
          (f.source !== null &&
            (!row.access ||
              ownerFingerprint(row.source) !== f.source ||
              ownerFingerprint(row.catalog) !== f.catalog)) ||
          (f.history !== null && row.history !== f.history)
        )
          throw new ApplicationError('DISH_HISTORY_UNAVAILABLE');
      }
    }),
};
export async function retainDishes(
  actor: string,
  session: string,
  window: string,
  tx: PoolClient,
  options: {
    source?: DishSource;
    catalog?: unknown;
    epoch?: Awaited<ReturnType<typeof dishEpoch>>;
    history?: string;
  } = {},
) {
  const epoch = await dishEpoch(tx);
  if (
    options.epoch &&
    (epoch.membership !== options.epoch.membership ||
      epoch.review !== options.epoch.review)
  )
    throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
  if (options.source) {
    const row = (
      await tx.query<{ until: string | null }>(
        'SELECT whaleu_ratings.window_deadline($1,$2,clock_timestamp())::text until',
        [actor, session],
      )
    ).rows[0]!;
    registerTransactionExactDeadline(tx, row.until, 'DISH_HISTORY_UNAVAILABLE');
  }
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'dish-current',
    Object.freeze({
      actor,
      session,
      window,
      epoch: epoch.membership,
      review: options.source ? epoch.review : null,
      source: options.source ? ownerFingerprint(options.source) : null,
      catalog: options.source ? ownerFingerprint(options.catalog) : null,
      history: options.history ?? null,
    }),
  );
}
