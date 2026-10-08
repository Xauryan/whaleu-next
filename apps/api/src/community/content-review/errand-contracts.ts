import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  errandPublisherContactsSchema,
  errandRewardSchema,
  errandText,
} from '../../errands/contracts.js';
import { canonicalJson } from './contracts.js';

const id = z.uuid().refine((value) => value === value.toLowerCase());
/** Publication-time provenance only. Never recomputed from a later selection. */
export const errandContentScopeSchema = z.strictObject({
  targetRegionId: id,
  sourceRegionId: id,
  identityCampusId: id,
  identitySelectionId: id,
  topologySnapshotId: id,
  affiliationAssertionId: id,
  affiliationSnapshotId: id,
});
/** A distinct text-only contract. No post/category/space aliases are permitted. */
export const errandContentEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  accountId: id,
  purpose: z.literal('publish_errand'),
  title: errandText(50),
  publicText: errandText(500),
  privateText: errandText(200, false),
  expectedTimeText: errandText(50),
  reward: errandRewardSchema,
  publisherContacts: errandPublisherContactsSchema,
  publicAssetIds: z.tuple([]),
  privateAssetIds: z.tuple([]),
  scope: errandContentScopeSchema,
});
export type ErrandContentScope = z.infer<typeof errandContentScopeSchema>;
export type ErrandContentEnvelope = z.infer<typeof errandContentEnvelopeSchema>;
export interface AcceptedErrandApproval {
  decisionId: string;
  digest: string;
  version: 1;
  envelope: ErrandContentEnvelope;
}

export function canonicalErrandEnvelope(value: unknown): ErrandContentEnvelope {
  const envelope = errandContentEnvelopeSchema.parse(value);
  Object.freeze(envelope.scope);
  Object.freeze(envelope.publisherContacts);
  Object.freeze(envelope.publicAssetIds);
  Object.freeze(envelope.privateAssetIds);
  return Object.freeze(envelope);
}
export function errandApprovalDigest(value: ErrandContentEnvelope): string {
  return createHash('sha256')
    .update(
      `whaleu-errand-content-approval:v1\n${canonicalJson(canonicalErrandEnvelope(value))}`,
    )
    .digest('hex');
}
