import { z } from 'zod';
import type { AuthorMode, Category } from '../contracts.js';
export type {
  RelatedRootScope,
  InheritedRelatedScope,
  LegacyContentScope,
} from '../content-review/scope-contracts.js';

export const relatedOrdinaryCategories = [
  'discussion',
  'confession',
  'companions',
  'pets',
  'internships',
  'scenery',
  'dorms',
  'research',
  'deep_sea',
] as const;
export interface RelatedPublicationShape {
  category: Category;
  authorMode: AuthorMode;
  componentKind: 'none' | 'poll' | 'formation';
  imageCount: number;
  allowAnonymousDm: boolean | null;
}
export interface RelatedCampusDisplay {
  isRelatedCampusSync: boolean;
  sourceRegion?: { id: string; name: string };
}
/** Owner methods additionally validate opaque object identity and transaction epoch. */
export interface CommunityDistributionScope {
  readonly viewSpaceId: string;
  readonly viewRegionId: string | null;
  readonly relatedCampusDistribution: 'complete' | 'unavailable';
  readonly fingerprint: string;
  readonly originalSpaceIds: readonly string[];
  readonly remoteSpaceIds: readonly string[];
}
export interface DistributionPostReference {
  id: string;
  space_id: string;
  category: Category;
  publication_envelope_version?: number;
}
export interface RelatedPublicationContext {
  clientRequestId: string;
  operation: 'publish_post';
  intentHash: string;
}

/** New v4 intent bytes are canonical; legacy none intents retain their input bytes. */
export const relatedCanonicalIdSchema = z.uuid().regex(/^[0-9a-f-]+$/);
export const relatedCanonicalIdentifiersSchema = z.strictObject({
  ids: z.array(relatedCanonicalIdSchema),
});
