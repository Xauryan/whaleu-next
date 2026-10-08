import { Inject, Injectable } from '@nestjs/common';
import { z, ZodError } from 'zod';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { CountProofCollector } from '../database/count-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  registerOptionalTransactionProof,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import {
  OptionalCountRunner,
  OptionalCountUnavailable,
  budgetedClient,
  configuredTimeout,
  DISCOVERY_COUNT_BATCH,
  DISCOVERY_COUNT_BUDGET_MS,
} from '../database/optional-count.js';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { ApplicationError } from '../http/application-error.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { CampusErrandScopeFacade } from '../campus/errand-scope.facade.js';
import { ProfileAdminParticipantFacade } from '../profile/admin-participant.facade.js';
import {
  profileCountProofOwner,
  fenceProfileAdminReads,
} from '../profile/count-epochs.js';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../community/discovery-continuation.module.js';
import { ErrandAccessService } from './access.js';
import {
  errandCountProofOwner,
  fenceErrandAdminReads,
} from './count-epochs.js';
import {
  ErrandAdminRepository,
  adminSeek,
  errandAdminSeekSchema,
} from './admin-repository.js';
import type { ErrandAdminRow, ErrandAdminSeek } from './admin-repository.js';
import {
  errandAdminOrderSchema,
  errandAdminPageSchema,
} from './admin-contracts.js';
import type {
  ErrandAdminQuery,
  ErrandAdminOrder,
  ErrandAdminParticipant,
  ErrandAdminPage,
} from './admin-contracts.js';
import { errandTimeSchema } from './contracts.js';

const positionSchema = z.strictObject({
  v: z.literal(1),
  anchor: errandTimeSchema,
  validUntil: z.number().finite(),
  after: errandAdminSeekSchema.nullable(),
});
type Position = z.infer<typeof positionSchema>;
const SEARCH = {
  matcher: 'public-text-name-uuid-v1' as const,
  legacyNumericReferences: 'unavailable' as const,
};
const PAGE_SCAN = 100;

/** One literal, Unicode-aware predicate for both page and count. No SQL LIKE
 * wildcard interpretation, private fields, internal IDs or guessed legacy UID. */
export function matchesErrandAdmin(
  row: Pick<ErrandAdminRow, 'title' | 'public_text' | 'accepter_id'>,
  publisher: ErrandAdminParticipant,
  accepter: ErrandAdminParticipant | null,
  keyword: string,
): boolean | null {
  if (!keyword) return true;
  const term = keyword.toLowerCase();
  if (
    row.title.toLowerCase().includes(term) ||
    row.public_text.toLowerCase().includes(term)
  )
    return true;
  const participants = [publisher, ...(accepter ? [accepter] : [])];
  if (
    participants.some(
      (p) =>
        p.status === 'available' &&
        (p.displayName.toLowerCase().includes(term) || p.profileId === term),
    )
  )
    return true;
  if (
    participants.some((p) => p.status === 'unavailable') ||
    (row.accepter_id !== null && accepter === null)
  )
    return null;
  return false;
}
interface PageRead {
  items: ErrandAdminOrder[];
  after: ErrandAdminSeek | null;
  more: boolean;
  /** Includes every bounded candidate, even negative matches and lookahead. */
  witness: string;
}
@Injectable()
export class ErrandAdminService {
  private readonly counts: OptionalCountRunner;
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ErrandAccessService) private readonly access: ErrandAccessService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(ErrandAdminRepository)
    private readonly records: ErrandAdminRepository,
    @Inject(ProfileAdminParticipantFacade)
    private readonly profiles: ProfileAdminParticipantFacade,
    @Inject(CampusErrandScopeFacade)
    private readonly campuses: CampusErrandScopeFacade,
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
    @Inject(APP_CONFIG) config: Pick<RuntimeConfig, 'PG_POOL_MAX'>,
  ) {
    this.counts = new OptionalCountRunner(config.PG_POOL_MAX, config);
  }

  private async batch(rows: readonly ErrandAdminRow[], tx: PoolClient) {
    return this.profiles.batch(
      rows.flatMap((row) => [
        row.publisher_id,
        ...(row.accepter_id ? [row.accepter_id] : []),
      ]),
      tx,
    );
  }
  private participant(
    facts: Awaited<ReturnType<ProfileAdminParticipantFacade['batch']>>,
    id: string,
  ): ErrandAdminParticipant {
    const fact = facts.get(id);
    if (!fact) throw new ApplicationError('ERRAND_UNAVAILABLE');
    return fact;
  }
  private async page(
    actor: string,
    regionId: string,
    query: ErrandAdminQuery,
    position: Position,
    tx: PoolClient,
  ): Promise<PageRead> {
    const rows = await this.records.candidates(
      regionId,
      query.status,
      position.anchor,
      position.after,
      PAGE_SCAN + 1,
      tx,
    );
    const profiles = await this.batch(rows, tx);
    const labels = await this.campuses.historicalBatch(
      rows.flatMap((row) => [row.source_region_id, row.target_region_id]),
      tx,
    );
    const evaluated = rows.map((row) => {
      const publisher = this.participant(profiles, row.publisher_id);
      const accepter = row.accepter_id
        ? this.participant(profiles, row.accepter_id)
        : null;
      const match = matchesErrandAdmin(row, publisher, accepter, query.keyword);
      const item = errandAdminOrderSchema.parse({
        id: row.id,
        revision: row.revision,
        title: row.title,
        publicText: row.public_text,
        expectedTimeText: row.expected_time_text,
        reward: row.reward,
        state: row.state,
        displayState: row.deleted_at ? 'deleted' : row.state,
        createdAt: row.created_at.toISOString(),
        acceptedAt: row.accepted_at?.toISOString() ?? null,
        completedAt: row.completed_at?.toISOString() ?? null,
        cancelledAt: row.cancelled_at?.toISOString() ?? null,
        deletedAt: row.deleted_at?.toISOString() ?? null,
        deletionReason: row.deleted_at ? { status: 'unavailable' } : null,
        publisher,
        accepter,
        relation:
          row.publisher_id === actor
            ? 'publisher'
            : row.accepter_id === actor
              ? 'accepter'
              : 'none',
        sourceRegion: labels.get(row.source_region_id),
        targetRegion: labels.get(row.target_region_id),
      });
      return { row, item, match };
    });
    const items: ErrandAdminOrder[] = [];
    let scanned = 0,
      after = position.after;
    for (const entry of evaluated.slice(0, PAGE_SCAN)) {
      if (items.length === query.limit) break;
      if (entry.match === null)
        throw new ApplicationError('ERRAND_UNAVAILABLE');
      scanned++;
      after = adminSeek(entry.row);
      if (entry.match) items.push(entry.item);
    }
    const more = scanned < rows.length;
    return {
      items,
      after,
      more,
      witness: JSON.stringify({
        candidates: evaluated.map(({ row, item, match }) => ({
          seek: adminSeek(row),
          item,
          match,
        })),
        scanned,
        after,
        more,
      }),
    };
  }
  private async count(
    regionId: string,
    query: ErrandAdminQuery,
    position: Position,
    tx: PoolClient,
  ) {
    return this.counts.attempt<bigint>(
      tx,
      async (read, _until, maxCandidates) => {
        let after: ErrandAdminSeek | null = null,
          value = 0n,
          candidates = 0;
        for (;;) {
          let rows: ErrandAdminRow[];
          try {
            rows = await this.records.candidates(
              regionId,
              query.status,
              position.anchor,
              after,
              DISCOVERY_COUNT_BATCH + 1,
              read,
            );
          } catch (error) {
            if (error instanceof ZodError) throw new OptionalCountUnavailable();
            throw error;
          }
          const current = rows.slice(0, DISCOVERY_COUNT_BATCH);
          candidates += current.length;
          if (candidates > maxCandidates) throw new OptionalCountUnavailable();
          let facts: Awaited<
            ReturnType<ProfileAdminParticipantFacade['batch']>
          >;
          try {
            facts = await this.batch(current, read);
          } catch (error) {
            if (
              error instanceof ApplicationError &&
              error.code === 'ERRAND_UNAVAILABLE'
            )
              throw new OptionalCountUnavailable();
            throw error;
          }
          for (const row of current) {
            const matched = matchesErrandAdmin(
              row,
              this.participant(facts, row.publisher_id),
              row.accepter_id ? this.participant(facts, row.accepter_id) : null,
              query.keyword,
            );
            if (matched === null) throw new OptionalCountUnavailable();
            if (matched) value++;
          }
          if (rows.length <= DISCOVERY_COUNT_BATCH)
            return { value, candidates };
          if (candidates >= maxCandidates) throw new OptionalCountUnavailable();
          after = adminSeek(current.at(-1)!);
        }
      },
      DISCOVERY_COUNT_BUDGET_MS,
      (managed, read) =>
        CountProofCollector.capture(
          managed,
          [errandCountProofOwner, profileCountProofOwner],
          read,
        ),
      async (read) => {
        await fenceErrandAdminReads(read);
        await fenceProfileAdminReads(read);
      },
    );
  }

  async list(token: string, query: ErrandAdminQuery): Promise<ErrandAdminPage> {
    try {
      return await this.db.transaction(
        async (tx) => {
          const session = await this.access.common(token, tx);
          const selected = await this.authorization.requireErrandManagement(
            session.accountId,
            query.regionId,
            tx,
          );
          const { regionId, management, grant } = selected;
          const context = {
            regionId,
            management,
            status: query.status,
            keyword: query.keyword,
            search: SEARCH,
          };
          const scope = discoveryContinuationScope([
            'errand-admin-v1',
            session.accountId,
            session.sessionId,
            grant.id,
            context,
            query.limit,
          ]);
          const now = (
            await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
          ).rows[0]!.now.getTime();
          const position: Position = query.cursor
            ? await this.cursors.get(query.cursor, scope, tx, (v) =>
                positionSchema.parse(v),
              )
            : {
                v: 1,
                anchor: new Date(now).toISOString(),
                validUntil: now + 5 * 60000,
                after: null,
              };
          if (
            position.validUntil <= now ||
            Date.parse(position.anchor) > now ||
            position.validUntil !== Date.parse(position.anchor) + 5 * 60000
          )
            throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
          registerTransactionDeadline(
            tx,
            position.validUntil,
            'DISCOVERY_RESTART_REQUIRED',
          );
          // Capture/scan precede page. Numeric legacy reference coverage is unknown;
          // declared text matches remain useful without claiming a complete total.
          const count = /^[0-9]+$/.test(query.keyword)
            ? null
            : await this.count(regionId, query, position, tx);
          const page = await this.page(
            session.accountId,
            regionId,
            query,
            position,
            tx,
          );
          await this.access.recheck(token, tx);
          const nextCursor =
            page.more && page.after
              ? await this.cursors.create(
                  scope,
                  session.accountId,
                  { ...position, after: page.after },
                  tx,
                )
              : null;
          const result: ErrandAdminPage = errandAdminPageSchema.parse({
            context,
            items: page.items,
            continuation: nextCursor ? 'more' : 'end',
            nextCursor,
            total:
              count?.status === 'known'
                ? { status: 'known', value: count.value.toString() }
                : { status: 'unavailable' },
          });
          const proof: RequiredTransactionProof<string> = {
            maximumFacts: 1,
            failureCode: 'ERRAND_UNAVAILABLE',
            validate: async ([witness], client) => {
              const end = performance.now() + 500;
              try {
                const settings = (
                  await client.query<{
                    statement_timeout: string;
                    lock_timeout: string;
                  }>(
                    "SELECT current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout",
                  )
                ).rows[0];
                if (!settings) throw new ApplicationError('ERRAND_UNAVAILABLE');
                const read = budgetedClient(
                  client,
                  end,
                  configuredTimeout(settings.statement_timeout),
                  Math.min(1, configuredTimeout(settings.lock_timeout)),
                );
                await fenceErrandAdminReads(read);
                await fenceProfileAdminReads(read);
                await this.campuses.fenceAdminLabels(read);
                const current = await this.page(
                  session.accountId,
                  regionId,
                  query,
                  position,
                  read,
                );
                if (performance.now() >= end || current.witness !== witness)
                  throw new ApplicationError('ERRAND_UNAVAILABLE');
                await client.query(
                  "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
                  [settings.statement_timeout, settings.lock_timeout],
                );
              } catch {
                throw new ApplicationError('ERRAND_UNAVAILABLE');
              }
            },
          };
          enableRequiredTransactionProof(tx, proof);
          registerRequiredTransactionFact(tx, proof, 'page', page.witness);
          if (count?.status === 'known' && count.proof)
            registerOptionalTransactionProof(tx, {
              validate: count.proof,
              invalidate: () => {
                result.total = { status: 'unavailable' };
              },
              get until() {
                return count.optionalUntil;
              },
            });
          return result;
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (error instanceof ZodError)
        throw new ApplicationError('ERRAND_UNAVAILABLE');
      throw error;
    }
  }
}
