import {
  ExperienceRankingController,
  initialExperienceRankingView,
} from '../src/pages/experience-ranking/controller';
import type {
  ExperienceRanking,
  ExperienceRankingItem,
} from '../src/experience/ranking-contract';
import type { ExperienceRankingGateway } from '../src/experience/ranking-gateway';
import { SafetyChanges } from '../src/community/safety-changes';
import { setup, publicExperienceDisplay } from './community-helpers';
export const rankingItem = (n = 1): ExperienceRankingItem => ({
  profileId: `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`,
  displayName: `合成用户${n}`,
  experienceDisplay: publicExperienceDisplay({
    title: { status: 'known', value: null },
    color: { status: 'known', value: null },
    level: { status: 'known', value: 1 },
  }),
});
export const rankingPage = (
  patch: Partial<ExperienceRanking> = {},
): ExperienceRanking => ({
  scope: 'global',
  population: 'known_participants',
  populationCompleteness: 'incomplete',
  selectionStatus: 'available_candidates_exhausted',
  items: [rankingItem()],
  ...patch,
});
export function rankingHarness(loggedIn = true) {
  const s = setup(loggedIn),
    calls: Parameters<ExperienceRankingGateway['ranking']>[] = [];
  const behavior: ExperienceRankingGateway = {
    ranking: async () => rankingPage(),
  };
  const runtime = {
    ...s.runtime,
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
    experienceRanking: {
      ranking: (...args: Parameters<ExperienceRankingGateway['ranking']>) => {
        calls.push(args);
        return behavior.ranking(...args);
      },
    },
  };
  let view = initialExperienceRankingView();
  const controller = new ExperienceRankingController(runtime, (next) => {
    view = next;
  });
  return { ...s, runtime, behavior, calls, controller, view: () => view };
}
