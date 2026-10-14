import { z } from 'zod';
import {
  TOOL_CATALOG_VERSION,
  toolCatalogSchema,
  toolDigest,
  toolEntrySchema,
  toolId,
  toolLinkPolicySchema,
} from './contracts.js';
export const toolProvenanceSchema = toolCatalogSchema.shape.source
  .pick({
    maintainer: true,
    attribution: true,
    observedAt: true,
    publishedAt: true,
  })
  .extend({ validity: toolCatalogSchema.shape.validity });
const map = toolEntrySchema.options[0];
const shuttle = toolEntrySchema.options[1];
const research = toolEntrySchema.options[2].omit({ link: true }).extend({
  link: z
    .strictObject({
      action: z.literal('copy'),
      state: z.literal('available'),
    })
    .nullable(),
});
const web = toolEntrySchema.options[3].omit({ link: true }).extend({
  link: z.strictObject({
    action: z.literal('webview'),
    state: z.enum(['available', 'webview_unconfigured']),
  }),
});
const inert = map
  .pick({
    id: true,
    sourceId: true,
    ordinal: true,
    revision: true,
    title: true,
    state: true,
  })
  .extend({
    state: z.enum(['disabled', 'withdrawn']),
    kind: z.enum(['map', 'shuttle', 'research', 'web-link']),
  });
export const publicToolEntrySchema = z.union([
  inert,
  map.extend({ state: z.literal('enabled') }),
  shuttle.extend({ state: z.literal('enabled') }),
  research.extend({ state: z.literal('enabled') }),
  web.extend({ state: z.literal('enabled') }),
]);
export type PublicToolEntry = z.infer<typeof publicToolEntrySchema>;
const context = {
  campusId: toolId,
  catalogId: toolId,
  digest: toolDigest,
  version: z.literal(TOOL_CATALOG_VERSION),
  provenance: toolProvenanceSchema,
};
const unavailable = z.strictObject({
  state: z.enum(['unknown', 'expired', 'unavailable']),
  campusId: toolId,
  reason: z.string().max(100),
});
export const toolsHubSchema = z.union([
  z.strictObject({
    ...context,
    state: z.literal('ready'),
    entries: z.array(publicToolEntrySchema).min(1).max(32),
  }),
  z.strictObject({
    ...context,
    state: z.enum(['known_empty', 'not_applicable']),
    entries: z.tuple([]),
  }),
  unavailable,
]);
export const toolDetailSchema = z.union([
  z.strictObject({
    ...context,
    state: z.literal('ready'),
    entry: publicToolEntrySchema,
  }),
  unavailable,
]);
export const toolLinkSchema = z.union([
  z.strictObject({
    state: z.literal('ready'),
    campusId: toolId,
    catalogId: toolId,
    digest: toolDigest,
    entryId: toolId,
    entryRevision: toolId,
    action: z.enum(['copy', 'webview']),
    url: z.string().max(2048),
    policy: toolLinkPolicySchema,
  }),
  z.strictObject({
    state: z.literal('unavailable'),
    campusId: toolId,
    reason: z.string().max(100),
  }),
]);
export const emptyToolQuery = z.strictObject({});
export const emptyToolBody = z.union([z.undefined(), z.strictObject({})]);
export const toolDetailQuery = z.strictObject({ catalogId: toolId });
export const toolLinkQuery = toolDetailQuery.extend({
  action: z.enum(['copy', 'webview']),
});
