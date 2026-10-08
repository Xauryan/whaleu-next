import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.js';
import {
  checkpointTransactionDeadlines,
  registerTransactionDeadline,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { ExperienceRankingSourceFacade } from '../experience/ranking-source.facade.js';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { AuthorDisplayService } from '../profile/author-display.service.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { ProfileVisibilityFacade } from '../safety/profile-visibility.facade.js';
import { enableSafetyRelationshipProof } from '../safety/relationship-proof.js';
import type { ExperienceRanking, RankingQuery } from './contracts.js';

export const RANKING_SCAN_MS = 1000;
export const RANKING_COMPLETION_MS = 1500;
export const RANKING_STATEMENT_MS = 250;
export const RANKING_LOCK_MS = 100;

function boundedTimeout(value: string, maximum: number): string {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
  };
  const inherited = match
    ? Number(match[1]) * multipliers[match[2] ?? 'ms']!
    : NaN;
  if (!Number.isFinite(inherited))
    throw new ApplicationError('EXPERIENCE_RANKING_UNAVAILABLE');
  return `${Math.max(1, Math.min(inherited || maximum, maximum))}ms`;
}

/** Read composition only: source order and cosmetics share one statement;
 * accepted identity locks and bilateral policy proofs survive until commit. */
@Injectable()
export class ExperienceRankingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorDisplayService)
    private readonly profiles: AuthorDisplayService,
    @Inject(ProfileVisibilityFacade)
    private readonly safety: ProfileVisibilityFacade,
    @Inject(ExperienceRankingSourceFacade)
    private readonly source: ExperienceRankingSourceFacade,
  ) {}

  ranking(
    token: string | null,
    query: RankingQuery,
  ): Promise<ExperienceRanking> {
    return this.database.transaction(
      async (tx) => {
        const settings = (
          await tx.query<{ statement_timeout: string; lock_timeout: string }>(
            `SELECT current_setting('statement_timeout') AS statement_timeout,
                current_setting('lock_timeout') AS lock_timeout`,
          )
        ).rows[0];
        if (!settings)
          throw new ApplicationError('EXPERIENCE_RANKING_UNAVAILABLE');
        await tx.query(
          `SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)`,
          [
            boundedTimeout(settings.statement_timeout, RANKING_STATEMENT_MS),
            boundedTimeout(settings.lock_timeout, RANKING_LOCK_MS),
          ],
        );
        await lockSafetyPolicy(tx);
        enableSafetyRelationshipProof(tx);
        const session =
          token !== null ? await this.identity.session(token, tx) : null;
        const now = (
          await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        ).rows[0]?.now.getTime();
        if (now === undefined || !Number.isFinite(now))
          throw new ApplicationError('EXPERIENCE_RANKING_UNAVAILABLE');
        registerTransactionDeadline(
          tx,
          now + RANKING_COMPLETION_MS,
          'EXPERIENCE_RANKING_UNAVAILABLE',
        );
        const expires = performance.now() + RANKING_SCAN_MS;
        const window = await this.source.read(tx);
        const items: ExperienceRanking['items'] = [];
        let scanLimited = window.hasMore;
        for (const candidate of window.candidates) {
          if (performance.now() >= expires) {
            scanLimited = true;
            break;
          }
          const profile = await this.profiles.find(candidate.accountId, tx);
          if (performance.now() >= expires) {
            scanLimited = true;
            break;
          }
          if (!profile) continue;
          const checkpoint = checkpointTransactionDeadlines(tx);
          await tx.query('SAVEPOINT ranking_candidate');
          const rollback = async () => {
            await tx.query('ROLLBACK TO SAVEPOINT ranking_candidate');
            await tx.query('RELEASE SAVEPOINT ranking_candidate');
            restoreTransactionDeadlines(tx, checkpoint);
          };
          const active = await this.identity.activeAccount(
            candidate.accountId,
            tx,
          );
          if (performance.now() >= expires) {
            await rollback();
            scanLimited = true;
            break;
          }
          if (!active) {
            await rollback();
            continue;
          }
          const relationship = await this.safety.read(
            session?.accountId ?? null,
            candidate.accountId,
            tx,
          );
          if (performance.now() >= expires) {
            await rollback();
            scanLimited = true;
            break;
          }
          if (relationship.status !== 'available') {
            await rollback();
            continue;
          }
          await tx.query('RELEASE SAVEPOINT ranking_candidate');
          items.push({
            profileId: profile.profileId,
            displayName: profile.displayName,
            experienceDisplay: candidate.experienceDisplay,
          });
          if (items.length === query.limit) break;
        }
        if (token !== null) await this.identity.session(token, tx);
        // Restore only inherited transaction-local settings. The wrapper still
        // flushes deferred waits, validates mandatory facts, and checks deadlines.
        await tx.query(
          `SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)`,
          [settings.statement_timeout, settings.lock_timeout],
        );
        return {
          scope: 'global',
          population: 'known_participants',
          populationCompleteness: 'incomplete',
          selectionStatus:
            items.length === query.limit
              ? 'limit_reached'
              : scanLimited
                ? 'scan_limited'
                : 'available_candidates_exhausted',
          items,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
