import { z } from 'zod';

/** Historical scope parser. Its defaults and property order are compatibility bytes. */
export const legacyContentScopeSchema = z.strictObject({
  originalSpaceId: z.uuid(),
  originalRegionId: z.uuid().nullable(),
  authorOriginRegionId: z.uuid().nullable(),
  identityRegionId: z.uuid().nullable(),
  topologySnapshotId: z.uuid().nullable(),
  sync: z.literal('none'),
  configurationRevisionId: z.uuid().nullable().default(null),
  identityCampusId: z.uuid().nullable().default(null),
  identitySelectionId: z.uuid().nullable().default(null),
  affiliationSnapshotId: z.uuid().nullable().default(null),
  affiliationAssertionId: z.uuid().nullable().default(null),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** No defaults in v4: every private historical actor field is explicit. */
const actorScopeShape = {
  originalSpaceId: z.uuid(),
  originalRegionId: z.uuid(),
  authorOriginRegionId: z.uuid().nullable(),
  identityRegionId: z.uuid().nullable(),
  topologySnapshotId: z.uuid().nullable(),
  configurationRevisionId: z.uuid().nullable(),
  identityCampusId: z.uuid().nullable(),
  identitySelectionId: z.uuid().nullable(),
  affiliationSnapshotId: z.uuid().nullable(),
  affiliationAssertionId: z.uuid().nullable(),
};
export const relatedRootScopeSchema = z
  .strictObject({
    ...actorScopeShape,
    sync: z.literal('related'),
    authorOriginRegionId: z.uuid(),
    identityRegionId: z.uuid(),
    topologySnapshotId: z.uuid(),
    configurationRevisionId: z.uuid(),
    identityCampusId: z.uuid(),
    identitySelectionId: z.uuid(),
    affiliationSnapshotId: z.uuid(),
    affiliationAssertionId: z.uuid(),
    syncPolicyId: z.uuid(),
    publicationGroupId: z.uuid(),
    publicationMembersDigest: digest,
  })
  .refine((scope) => scope.identityRegionId === scope.originalRegionId);
export const inheritedRelatedScopeSchema = z.strictObject({
  ...actorScopeShape,
  sync: z.literal('inherited_related'),
  parentDistribution: z.strictObject({
    postId: z.uuid(),
    decisionId: z.uuid(),
    digest,
  }),
});
const exactContentScopeSchema = z.discriminatedUnion('sync', [
  legacyContentScopeSchema,
  relatedRootScopeSchema,
  inheritedRelatedScopeSchema,
]);
export const effectiveContentScopeSchema: z.ZodType<ContentScopeSnapshot> =
  exactContentScopeSchema;
type RequireProtocolAgreement<T extends true> = T;
export type ContentScopeProtocolAgreement = RequireProtocolAgreement<
  [z.input<typeof exactContentScopeSchema>] extends [ContentScopeSnapshot]
    ? [ContentScopeSnapshot] extends [z.input<typeof exactContentScopeSchema>]
      ? true
      : false
    : false
>;
/** Named protocol types keep consumers independent of Zod's recursive internals. */
export interface LegacyContentScope {
  originalSpaceId: string;
  originalRegionId: string | null;
  authorOriginRegionId: string | null;
  identityRegionId: string | null;
  topologySnapshotId: string | null;
  sync: 'none';
  configurationRevisionId?: string | null | undefined;
  identityCampusId?: string | null | undefined;
  identitySelectionId?: string | null | undefined;
  affiliationSnapshotId?: string | null | undefined;
  affiliationAssertionId?: string | null | undefined;
}
interface RelatedActorScope {
  originalSpaceId: string;
  originalRegionId: string;
  authorOriginRegionId: string | null;
  identityRegionId: string | null;
  topologySnapshotId: string | null;
  configurationRevisionId: string | null;
  identityCampusId: string | null;
  identitySelectionId: string | null;
  affiliationSnapshotId: string | null;
  affiliationAssertionId: string | null;
}
export interface RelatedRootScope extends RelatedActorScope {
  sync: 'related';
  authorOriginRegionId: string;
  identityRegionId: string;
  topologySnapshotId: string;
  configurationRevisionId: string;
  identityCampusId: string;
  identitySelectionId: string;
  affiliationSnapshotId: string;
  affiliationAssertionId: string;
  syncPolicyId: string;
  publicationGroupId: string;
  publicationMembersDigest: string;
}
export interface InheritedRelatedScope extends RelatedActorScope {
  sync: 'inherited_related';
  parentDistribution: { postId: string; decisionId: string; digest: string };
}
export type ContentScopeSnapshot =
  LegacyContentScope | RelatedRootScope | InheritedRelatedScope;
