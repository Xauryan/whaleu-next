import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import {
  ASSISTANCE_PROFILE,
  ASSISTANCE_RUNTIME,
  type AssistanceProviderInput,
} from '../../src/ratings/assistance/contracts.js';
import type {
  AssistanceRuntime,
  AssistancePermit,
} from '../../src/ratings/assistance/provider.js';
import { ratingCategoryManagementFixture } from './rating-category-management-fixture.js';

/** Synthetic transport injected only by this disposable acceptance fixture. */
export class SyntheticRatingAssistance implements AssistanceRuntime {
  readonly mode = 'synthetic-only' as const;
  readonly profile = ASSISTANCE_PROFILE;
  readonly sends: AssistancePermit[] = [];
  readonly reconciliations: string[] = [];
  readonly accepted = new Map<string, unknown>();
  beforeReady: (() => Promise<void>) | null = null;
  action: 'allow' | 'unknown' | 'lose_ack' | 'malformed' | 'not_accepted' =
    'allow';
  measure(_input: AssistanceProviderInput) {
    return 32;
  }
  async prepare(key: string, inputDigest: string) {
    await this.beforeReady?.();
    return {
      key,
      inputDigest,
      profile: this.profile,
      dispatch: (permit: AssistancePermit) => {
        this.sends.push(permit);
        if (this.action === 'unknown')
          throw Error('Synthetic uncertain effect');
        if (this.action === 'not_accepted')
          return {
            status: 'not_accepted',
            key,
            inputDigest,
            profile: this.profile,
          };
        const value = {
          status: 'accepted',
          key,
          inputDigest,
          profile: this.profile,
          text:
            this.action === 'malformed'
              ? 'https://example.invalid/'
              : permit.input.context === 'rating_category'
                ? '共同分享真实课程体验'
                : '这门课程怎么样？',
          usage: { inputTokens: 32, outputTokens: 10, monetaryMinorUnits: 0 },
        };
        this.accepted.set(key, value);
        if (this.action === 'lose_ack')
          throw Error('Synthetic accepted with response loss');
        return value;
      },
    };
  }
  async reconcile(key: string, inputDigest: string) {
    this.reconciliations.push(key);
    return (
      this.accepted.get(key) ??
      (this.action === 'unknown'
        ? { status: 'unknown' }
        : { status: 'not_accepted', key, inputDigest, profile: this.profile })
    );
  }
}
export function ratingAssistanceFixture(
  runtime: AssistanceRuntime | null = null,
) {
  return ratingCategoryManagementFixture({
    appOptions: {
      createApp: async (config, configurePolicy) => {
        const builder = Test.createTestingModule({
          imports: [AppModule.register(config)],
        });
        builder.overrideProvider(ASSISTANCE_RUNTIME).useValue(runtime);
        await configurePolicy(builder);
        return (await builder.compile()).createNestApplication({
          logger: false,
        });
      },
    },
  });
}
