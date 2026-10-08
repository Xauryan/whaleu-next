import { z } from 'zod';
import type { PublicExperienceDisplay } from '../experience/public-display.contract.js';
export const rankingQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .default('50')
    .transform(Number),
});
export const emptyBodySchema = z.strictObject({}).default({});
export type RankingQuery = z.infer<typeof rankingQuerySchema>;
export interface ExperienceRanking {
  scope: 'global';
  population: 'known_participants';
  populationCompleteness: 'incomplete';
  selectionStatus:
    'limit_reached' | 'available_candidates_exhausted' | 'scan_limited';
  items: {
    profileId: string;
    displayName: string;
    experienceDisplay: PublicExperienceDisplay;
  }[];
}
