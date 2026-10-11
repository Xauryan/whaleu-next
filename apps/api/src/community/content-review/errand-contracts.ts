import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  errandPublisherContactsSchema,
  errandRewardSchema,
  errandText,
} from '../../errands/contracts.js';
import { canonicalJson } from './contracts.js';
import { errandImageFactSchema } from '../../errands/publication-contracts.js';

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
export const errandContentEnvelopeV1Schema = z.strictObject({
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
/** New exact media definition. The v1 encoder and digest bytes remain unchanged. */
export const errandContentEnvelopeV2Schema = errandContentEnvelopeV1Schema
  .omit({ version: true, publicAssetIds: true, privateAssetIds: true })
  .extend({
    version: z.literal(2),
    draftId: id,
    draftRevision: z.number().int().positive().safe(),
    mediaRevision: z.number().int().positive().safe(),
    publicMedia: z.array(errandImageFactSchema).max(3),
    privateMedia: z.array(errandImageFactSchema).max(3),
  })
  .superRefine((v, ctx) => {
    const all = [...v.publicMedia, ...v.privateMedia];
    for (const audience of ['public', 'private'] as const) {
      const slots = v[`${audience}Media`].map((x) => x.slot);
      if (
        slots.some((x) => !x.startsWith(audience)) ||
        slots.join(',') !== [...slots].sort().join(',') ||
        new Set(slots).size !== slots.length
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid exact media audience/slot order',
        });
    }
    if (new Set(all.map((x) => x.assetId)).size !== all.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate media asset' });
  });
export const errandContentEnvelopeSchema = z.union([
  errandContentEnvelopeV1Schema,
  errandContentEnvelopeV2Schema,
]);
export type ErrandContentScope = z.infer<typeof errandContentScopeSchema>;
export type ErrandContentEnvelope = z.infer<typeof errandContentEnvelopeSchema>;
export interface AcceptedErrandApproval {
  decisionId: string;
  digest: string;
  version: 1 | 2;
  envelope: ErrandContentEnvelope;
}

export function canonicalErrandEnvelope(value: unknown): ErrandContentEnvelope {
  const envelope = errandContentEnvelopeSchema.parse(value);
  Object.freeze(envelope.scope);
  Object.freeze(envelope.publisherContacts);
  if (envelope.version === 1) {
    Object.freeze(envelope.publicAssetIds);
    Object.freeze(envelope.privateAssetIds);
  } else {
    for (const item of [...envelope.publicMedia, ...envelope.privateMedia])
      Object.freeze(item);
    Object.freeze(envelope.publicMedia);
    Object.freeze(envelope.privateMedia);
  }
  return Object.freeze(envelope);
}
export function errandApprovalDigest(value: ErrandContentEnvelope): string {
  return createHash('sha256')
    .update(
      `whaleu-errand-content-approval:v${value.version}\n${canonicalJson(canonicalErrandEnvelope(value))}`,
    )
    .digest('hex');
}
