import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import {
  CommunitySocialSourceFacade,
  lockSocialSource,
  lockSocialSourceAccounts,
  socialSourceDeletionState,
} from '../../community/social-source/facade.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { SocialUpdatesRepository } from './repository.js';
import { socialIdSchema } from './contracts.js';
export const socialWorkerSchema = z
  .strictObject({
    mode: z.enum(['dry-run', 'apply']).default('dry-run'),
    sourceIds: z
      .array(socialIdSchema)
      .max(50)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .refine((value) => value.mode !== 'apply' || value.sourceIds.length > 0);
export function assertLocalSocialWorker(config: RuntimeConfig) {
  const url = new URL(config.DATABASE_URL);
  if (
    config.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !['/whaleu_test', '/whaleu_dev'].includes(url.pathname)
  )
    throw new Error('Social updates require a disposable local database');
}
export async function assertLocalSocialConnection(tx: PoolClient) {
  const peer = (
    tx as PoolClient & { connection?: { stream?: { remoteAddress?: string } } }
  ).connection?.stream?.remoteAddress;
  if (
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(tx.host) ||
    !peer ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)
  )
    throw new Error('Social updates require an actual loopback connection');
  const name = (
    await tx.query<{ name: string }>('SELECT current_database() AS name')
  ).rows[0]?.name;
  if (!name || !['whaleu_test', 'whaleu_dev'].includes(name))
    throw new Error('Social updates require a disposable database');
}
const empty = () => ({
  materialized: 0,
  existing: 0,
  alreadyProcessed: 0,
  missing: 0,
  retryable: 0,
});
/** Materialization retains private source metadata regardless of present access.
 * It never snapshots an actor or target grant; every consumer reprojects later. */
@Injectable()
export class SocialUpdatesWorker {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(CommunitySocialSourceFacade)
    private readonly source: CommunitySocialSourceFacade,
    @Inject(SocialUpdatesRepository)
    private readonly records: SocialUpdatesRepository,
  ) {}
  private async lockedSource(id: string, tx: PoolClient) {
    const locator = await this.source.locate(id, tx);
    if (!locator) return null;
    const active = await lockSocialSourceAccounts(locator, tx);
    await lockSocialSource(id, tx, true);
    const source = await this.source.source(id, tx);
    if (!source) return null;
    if (
      source.actorAccountId !== locator.actorAccountId ||
      source.recipientAccountId !== locator.recipientAccountId
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return { source, active };
  }

  private async disposition(id: string, tx: PoolClient) {
    const deletion = await socialSourceDeletionState(id, tx);
    if (deletion.erasing) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const receipt = await this.records.receipt(id, tx);
    const state = await this.records.workState(id, tx);
    if (receipt) {
      if (state !== 'completed')
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      return 'alreadyProcessed' as const;
    }
    if (deletion.retired || state !== 'pending')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return 'pending' as const;
  }

  async run(input: Partial<z.infer<typeof socialWorkerSchema>> = {}) {
    const options = socialWorkerSchema.parse(input);
    assertLocalSocialWorker(this.config);
    if (
      options.mode === 'apply' &&
      this.config.COMMUNITY_UPDATES_PROCESSING === 'disabled'
    )
      throw new Error('Social updates processing is disabled');
    await this.database.transaction(assertLocalSocialConnection, {
      isolationLevel: 'read committed',
    });
    const result = {
      mode: options.mode,
      requested: options.sourceIds.length,
      ...empty(),
    };
    for (const id of options.sourceIds) {
      try {
        const outcome = await this.database.transaction(
          async (tx) => {
            await assertLocalSocialConnection(tx);
            await lockSafetyPolicy(tx);
            enableSafetyRelationshipProof(tx);
            const locked = await this.lockedSource(id, tx);
            if (!locked) return 'missing' as const;
            const { source, active } = locked;
            if ((await this.disposition(id, tx)) === 'alreadyProcessed')
              return 'alreadyProcessed' as const;
            // Cooling is retryable, not a synthetic terminal receipt and never
            // an opportunity to materialize a new visible notice.
            if (!active) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
            if (options.mode === 'dry-run')
              return (await this.records.existing(source, tx))
                ? ('existing' as const)
                : ('materialized' as const);
            await this.records.owner(source.recipientAccountId, tx, true);
            const current = await this.source.source(id, tx);
            if (
              !current ||
              current.actorAccountId !== source.actorAccountId ||
              current.recipientAccountId !== source.recipientAccountId
            )
              throw new ApplicationError('COMMUNITY_UNAVAILABLE');
            if ((await this.disposition(id, tx)) === 'alreadyProcessed')
              return 'alreadyProcessed' as const;
            return this.records.settle(current, tx);
          },
          { isolationLevel: 'read committed' },
        );
        result[outcome]++;
      } catch {
        result.retryable++;
        if (options.mode === 'apply')
          await this.database
            .transaction(
              async (tx) => {
                await assertLocalSocialConnection(tx);
                await lockSafetyPolicy(tx);
                enableSafetyRelationshipProof(tx);
                const locked = await this.lockedSource(id, tx);
                if (!locked || !locked.active) return;
                if ((await this.disposition(id, tx)) !== 'pending') return;
                await this.records.retry(id, tx);
              },
              { isolationLevel: 'read committed' },
            )
            .catch(() => undefined);
      }
    }
    return result;
  }
}
