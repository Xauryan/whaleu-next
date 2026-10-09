import type { ExperienceAction } from './catalog.js';

export type ExperienceSourceDomain = 'community' | 'ratings';

/** Immutable settlement input. Public display and current content authority
 * belong to their domain owners and are never part of reward consumption. */
export interface ExperienceSourceUnit {
  unitId: string;
  groupId: string;
  beneficiaryId: string;
  action: ExperienceAction;
  /** Preserve PostgreSQL's exact source coordinate, including microseconds. */
  occurredAt: string | null;
  sourceKind: 'community_outbox' | 'saved_obligation' | 'rating_event';
  sourceId: string;
}

/** Only the typed registry can choose which owner supplies a source unit. */
export interface RoutedExperienceSourceUnit extends ExperienceSourceUnit {
  sourceDomain: ExperienceSourceDomain;
  enrollmentOrder: string;
}
