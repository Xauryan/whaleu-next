/** TEST ONLY: historical M1 producers with CURRENT Review and native readers.
 * This never changes current registration admission or provides a production
 * fallback. The two saved owners are complete sources, not selective SQL copies.
 */
import assert from 'node:assert/strict';
import { Injectable } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../../src/config/config.js';
import type { RuntimeConfig } from '../../../src/config/config.js';
import { DatabaseService } from '../../../src/database/database.js';
import { IdentityRepository } from '../../../src/identity/identity.repository.js';
import type { ProviderIdentity } from '../../../src/identity/contracts.js';
import { AppLogger } from '../../../src/observability/logger.js';
import { AccountPunishmentPolicy } from '../../../src/safety/account-moderation/policy.js';
import { PublicationService } from '../../../src/community/publication.service.js';
import { requireOrdinarySourceParent } from './text-source-publication.js';
import { IdentityRepository as M1IdentityRepository } from './identity.repository.js';
import type { TokenHashes } from './identity.repository.js';
import { PublicationService as M1PublicationService } from './publication.service.js';
import {
  requireM1TestConfig,
  readExactM1Migrations,
  retainExactM1,
  guardedM1Database,
  requireM1SyntheticIdentity,
} from './boundary.js';

class SyntheticM1Identity extends M1IdentityRepository {
  override createSession(identity: ProviderIdentity, tokens: TokenHashes) {
    const saved = requireM1SyntheticIdentity(identity, tokens);
    return super.createSession(saved.identity, saved.tokens);
  }
}

// Supplied transactions must receive the same retained proof as internally
// managed operations. Unknown owner methods are not automatically admitted.
const transactionArguments: Readonly<Record<string, number>> = Object.freeze({
  dmActiveAccount: 1,
  processingAccountState: 1,
  activeAccount: 1,
  beginTitleMaintenanceSweep: 0,
  titleMaintenanceCandidateWindow: 1,
  lockTitleMaintenanceAccount: 1,
  canonicalWechatTitleEligibility: 1,
  wechatAppAccount: 2,
  authenticate: 1,
});
function historicalIdentity(database: DatabaseService, config: RuntimeConfig) {
  const owner = new SyntheticM1Identity(database, config);
  return new Proxy(owner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || property === 'constructor')
        return value;
      const name = String(property),
        index = transactionArguments[name];
      assert.ok(
        index !== undefined ||
          ['createSession', 'rotate', 'revoke'].includes(name),
        `Unreviewed M1 Identity method ${name}`,
      );
      return async (...args: unknown[]) => {
        const tx =
          index === undefined
            ? undefined
            : (args[index] as PoolClient | undefined);
        if (index !== undefined && name !== 'authenticate') assert.ok(tx);
        if (tx) await retainExactM1(tx);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/** Current ReplyPublicationService extracted this method from the old inline
 * parent check. Delegate to the EXACT f21 narrowing-only helper, never a fake
 * parent approval or the current helper's added Home/version-7 semantics.
 * The current reply writer still runs authorizeDiscussionPublication FIRST.
 */
@Injectable()
class M1PublicationBridge extends M1PublicationService {
  async requireSourceParent(postId: string, tx: PoolClient): Promise<void> {
    await retainExactM1(tx);
    await requireOrdinarySourceParent(postId, tx);
  }
}

export async function configureHistoricalM1(
  builder: TestingModuleBuilder,
  config: RuntimeConfig,
): Promise<void> {
  requireM1TestConfig(config);
  await readExactM1Migrations();
  builder.overrideProvider(DatabaseService).useFactory({
    inject: [APP_CONFIG, AppLogger, AccountPunishmentPolicy],
    factory: (
      current: RuntimeConfig,
      logger: AppLogger,
      policy: AccountPunishmentPolicy,
    ) => {
      requireM1TestConfig(current);
      return guardedM1Database(new DatabaseService(current, logger, policy));
    },
  });
  builder.overrideProvider(IdentityRepository).useFactory({
    inject: [DatabaseService],
    factory: (database: DatabaseService) =>
      historicalIdentity(database, config),
  });
  builder.overrideProvider(PublicationService).useClass(M1PublicationBridge);
}
