import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import {
  assertLocalExperienceWorker,
  assertLocalExperienceConnection,
} from '../../experience/worker.js';
import {
  hotScoreOptionsSchema,
  validateHotScoreSnapshot,
} from './contracts.js';
import type { HotScoreOptions, HotScoreResult } from './contracts.js';
import { HotScoreEvaluator, HotScoreNumericError } from './evaluator.js';
import { HotScoreRepository } from './repository.js';
import {
  HOT_SCORE_FORMULA,
  HOT_SCORE_FORMULA_FINGERPRINT,
  HOT_SCORE_NUMERIC_PROFILE,
  HOT_SCORE_NUMERIC_PROFILE_VERSION,
  HOT_SCORE_EXPRESSION_FINGERPRINT,
} from './formula.js';

export const assertLocalHotScore = assertLocalExperienceWorker;
export const assertLocalHotScoreConnection = assertLocalExperienceConnection;
@Injectable()
export class HotScoreService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HotScoreRepository) private readonly repository: HotScoreRepository,
    @Inject(HotScoreEvaluator) private readonly evaluator: HotScoreEvaluator,
  ) {}
  async inspect(
    postId: string,
    mode: HotScoreOptions['mode'] = 'dry-run',
  ): Promise<HotScoreResult> {
    const options = hotScoreOptionsSchema.parse({ mode, postIds: [postId] });
    postId = options.postIds[0]!;
    assertLocalHotScore(this.config);
    if (
      mode === 'compute' &&
      this.config.HOT_SCORE_COMPUTATION !== 'manual_only'
    )
      throw new Error('Internal score computation is disabled');
    const advisory = mode === 'dry-run';
    try {
      return await this.database.transaction(
        async (tx): Promise<HotScoreResult> => {
          if (advisory) await tx.query('SET TRANSACTION READ ONLY');
          // PostgreSQL 18 transaction_timeout bounds the whole selected-post unit,
          // including a blocked lock acquisition, not just each individual query.
          await tx.query("SET LOCAL statement_timeout='1500ms'");
          await tx.query("SET LOCAL lock_timeout='500ms'");
          await tx.query("SET LOCAL transaction_timeout='5000ms'");
          await assertLocalHotScoreConnection(tx);
          if (!advisory) {
            if (!(await this.repository.lockPost(postId, tx)))
              return { status: 'missing', postId, advisory };
            if (!(await this.repository.coverage(postId, tx)))
              return { status: 'blockedCoverage', postId, advisory };
            await this.repository.lockStates(postId, tx);
          }
          const snapshot = await this.repository.snapshot(postId, tx);
          if (!snapshot) return { status: 'missing', postId, advisory };
          const validation = validateHotScoreSnapshot(snapshot);
          if (validation.status !== 'ready')
            return { status: validation.status, postId, advisory };
          const score = await this.evaluator.evaluate(validation.inputs, tx);
          return {
            status: 'computed',
            postId,
            advisory,
            score,
            sourceFormulaVersion: HOT_SCORE_FORMULA.sourceFormulaVersion,
            numericProfile: HOT_SCORE_NUMERIC_PROFILE,
            numericProfileVersion: HOT_SCORE_NUMERIC_PROFILE_VERSION,
            formulaFingerprint: HOT_SCORE_FORMULA_FINGERPRINT,
            expressionFingerprint: HOT_SCORE_EXPRESSION_FINGERPRINT,
            snapshot: validation.snapshot,
            viewCoverage: 'synchronous_accepted_aggregate',
            viewIntegrity: 'trusted_reporting_owner_and_access_controls',
          };
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      return {
        status:
          error instanceof HotScoreNumericError ? 'numericFailure' : 'failed',
        postId,
        advisory,
      };
    }
  }
  async run(input: Partial<HotScoreOptions> = {}) {
    const options = hotScoreOptionsSchema.parse(input);
    assertLocalHotScore(this.config);
    if (
      options.mode === 'compute' &&
      this.config.HOT_SCORE_COMPUTATION !== 'manual_only'
    )
      throw new Error('Internal score computation is disabled');
    const summary = {
      requested: options.postIds.length,
      computed: 0,
      missing: 0,
      blockedCoverage: 0,
      blockedFreshness: 0,
      unavailable: 0,
      numericFailure: 0,
      failed: 0,
    };
    for (const id of options.postIds)
      summary[(await this.inspect(id, options.mode)).status]++;
    return {
      mode: options.mode,
      advisory: options.mode === 'dry-run',
      ...summary,
    };
  }
}
