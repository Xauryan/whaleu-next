/** TEST ONLY: exact c27 producers for the two pre-Home upgrade witnesses.
 * No production fallback and no replacement Review, Safety, Media or journal.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Injectable } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../../src/config/config.js';
import type { RuntimeConfig } from '../../../src/config/config.js';
import { DatabaseService } from '../../../src/database/database.js';
import type { TransactionOptions } from '../../../src/database/database.js';
import { readMigrations } from '../../../src/database/migrations.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../../src/http/application-error.js';
import { AppLogger } from '../../../src/observability/logger.js';
import { AccountPunishmentPolicy } from '../../../src/safety/account-moderation/policy.js';
import { PublicationService } from '../../../src/community/publication.service.js';
import type {
  PublishPost,
  PublishComment,
  PublicationReceipt,
} from '../../../src/community/contracts.js';
import type { TextReviewStatus } from '../../../src/community/text-review/contracts.js';
import { historicalContentDefinitionBoundary } from '../historical-content-definition/configure.js';
import { PublicationService as PredecessorPublicationService } from './publication.service.js';

export const historicalPublicationPrefixes = Object.freeze([137, 144]);

// Finite names from the checked-in Home migrations, not a catalog-wide prefix
// scan. Renamed predecessors and independent columns/constraints count too.
let homeObjects: Promise<readonly string[][]> | undefined;
const homeSuccessors = () =>
  (homeObjects ??= (async () => {
    const migrations = (
      await readMigrations(
        fileURLToPath(new URL('../../../migrations', import.meta.url)),
      )
    ).filter(({ name }) => /^(0177|0178)_/.test(name));
    assert.equal(migrations.length, 2);
    const sql = migrations.map(({ sql }) => sql).join('\n');
    const names = (pattern: RegExp) =>
      [...new Set([...sql.matchAll(pattern)].map((match) => match[1]!))].sort();
    const relations = names(
      /\bCREATE\s+(?:TABLE\s+whaleu_community\.|(?:UNIQUE\s+)?INDEX\s+)(home_[a-z_]+)/g,
    );
    const functions = names(
      /\bCREATE\s+FUNCTION\s+whaleu_community\.(home_[a-z_]+)/g,
    );
    const renamed = names(/\bRENAME\s+TO\s+([a-z_]+_pre_home)/g);
    const triggers = names(
      /\bCREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+(home_[a-z_]+)/g,
    );
    const columns = names(/\bADD\s+COLUMN\s+(home_[a-z_]+)/g);
    const constraints = names(/\bADD\s+CONSTRAINT\s+(home_[a-z_]+)/g);
    return [
      relations,
      [...functions, ...renamed],
      triggers,
      columns,
      constraints,
    ];
  })());

export const historicalHomeAbsenceSql = `SELECT
  NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace=to_regnamespace('whaleu_community') AND relname=ANY($1::text[]))
  AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace=to_regnamespace('whaleu_community') AND (typname=ANY($1::text[]) OR typname=ANY(SELECT '_' || name FROM unnest($1::text[]) name)))
  AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace=to_regnamespace('whaleu_community') AND proname=ANY($2::text[]))
  AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=ANY(ARRAY['whaleu_community.posts'::regclass,'whaleu_community.root_comments'::regclass,'whaleu_community.replies'::regclass,'whaleu_community.publication_requests'::regclass,'whaleu_community.text_review_requests'::regclass,'whaleu_community.content_approval_decisions'::regclass,'whaleu_community.content_approval_bindings'::regclass]) AND tgname=ANY($3::text[]))
  AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=ANY(ARRAY['whaleu_community.content_approval_decisions'::regclass,'whaleu_community.text_review_requests'::regclass]) AND NOT attisdropped AND attname=ANY($4::text[]))
  AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace=to_regnamespace('whaleu_community') AND conname=ANY($5::text[])) AS absent`;

export async function historicalPublicationBoundary(
  config: RuntimeConfig,
  prefix: number,
) {
  assert.ok(historicalPublicationPrefixes.includes(prefix));
  const requirePrefix = await historicalContentDefinitionBoundary(
    config,
    prefix,
  );
  const names = await homeSuccessors();
  return async (tx: PoolClient): Promise<void> => {
    await requirePrefix(tx);
    const result = await tx.query<{ absent: boolean }>(
      historicalHomeAbsenceSql,
      [...names],
    );
    assert.equal(
      result.rows[0]?.absent,
      true,
      'Partial Home ownership is not a historical producer',
    );
  };
}

/** Only transaction is wrapped. The real owner starts/commits/rolls back the
 * same transaction, owns savepoints and performs every query without rewriting.
 * Both the callback tail and the real pre-COMMIT required-proof phase recheck.
 */
export function guardedHistoricalPublicationDatabase(
  database: DatabaseService,
  requirePrefix: (tx: PoolClient) => Promise<void>,
): DatabaseService {
  const proof: RequiredTransactionProof<true> = {
    maximumFacts: 1,
    failureCode: 'COMMUNITY_UNAVAILABLE',
    validate: async (facts, tx) => {
      assert.deepEqual(facts, [true]);
      await requirePrefix(tx);
    },
  };
  const retain = async (tx: PoolClient) => {
    await requirePrefix(tx);
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(tx, proof, 'historical-publication', true);
  };
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'transaction')
        return <T>(
          operation: (tx: PoolClient) => Promise<T>,
          options?: TransactionOptions,
        ) =>
          database.transaction(async (tx) => {
            await retain(tx);
            const result = await operation(tx);
            await retain(tx);
            return result;
          }, options);
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function rejectFutureSource(body: PublishPost | PublishComment): void {
  if (body.textSource !== undefined)
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
}

@Injectable()
export class HistoricalPublicationService extends PredecessorPublicationService {
  override post(
    token: string,
    body: PublishPost,
    reviewOnly: true,
  ): Promise<TextReviewStatus>;
  override post(token: string, body: PublishPost): Promise<PublicationReceipt>;
  override post(
    token: string,
    body: PublishPost,
    reviewOnly = false,
  ): Promise<PublicationReceipt | TextReviewStatus> {
    rejectFutureSource(body);
    return reviewOnly ? super.post(token, body, true) : super.post(token, body);
  }
  override comment(
    token: string,
    postId: string,
    body: PublishComment,
    reviewOnly: true,
  ): Promise<TextReviewStatus>;
  override comment(
    token: string,
    postId: string,
    body: PublishComment,
  ): Promise<PublicationReceipt>;
  override comment(
    token: string,
    postId: string,
    body: PublishComment,
    reviewOnly = false,
  ): Promise<PublicationReceipt | TextReviewStatus> {
    rejectFutureSource(body);
    return reviewOnly
      ? super.comment(token, postId, body, true)
      : super.comment(token, postId, body);
  }
  // Current reply callers invoke this only for a new text-source request.
  // Such a request has no predecessor meaning and must never become plain text.
  requireSourceParent(): Promise<never> {
    return Promise.reject(new ApplicationError('CONTENT_REVIEW_UNAVAILABLE'));
  }
}

export async function configureHistoricalPublication(
  builder: TestingModuleBuilder,
  config: RuntimeConfig,
  prefix: number,
): Promise<void> {
  const boundary = await historicalPublicationBoundary(config, prefix);
  builder.overrideProvider(DatabaseService).useFactory({
    inject: [APP_CONFIG, AppLogger, AccountPunishmentPolicy],
    factory: (
      current: RuntimeConfig,
      logger: AppLogger,
      policy: AccountPunishmentPolicy,
    ) => {
      assert.equal(current.DATABASE_URL, config.DATABASE_URL);
      assert.equal(current.NODE_ENV, 'test');
      assert.equal(current.PG_SSL_MODE, 'disable');
      return guardedHistoricalPublicationDatabase(
        new DatabaseService(current, logger, policy),
        boundary,
      );
    },
  });
  builder
    .overrideProvider(PublicationService)
    .useClass(HistoricalPublicationService);
}
