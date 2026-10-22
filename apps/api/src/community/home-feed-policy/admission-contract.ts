import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../content-review/canonical-json.js';

export const HOME_POLICY_SOURCE =
  '4494e36b9451e3a92874ccf85f574a36e28e3d48' as const;
export const HOME_ADMISSION_DOMAIN = 'whaleu-home-admission:v1\n';
/** Canonical evidence text: preserve bytes and count Unicode scalars, like SQL. */
const evidence = (maximum: number) =>
  z.string().refine(
    (value) =>
      value.length > 0 &&
      value === value.trim() &&
      [...value].length <= maximum &&
      [...value].every((c) => {
        const n = c.codePointAt(0)!;
        return (
          n >= 32 && !(n >= 127 && n <= 159) && !(n >= 0xd800 && n <= 0xdfff)
        );
      }),
    'Canonical non-control evidence required',
  );
const id = z
  .uuid()
  .refine((v) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      v,
    ),
  );
export const homeNativeCategorySchema = z.enum([
  'discussion',
  'confession',
  'companions',
  'pets',
  'internships',
  'scenery',
  'dorms',
  'research',
  'deep_sea',
  'trading',
  'water',
]);
const schoolCodes: Record<z.infer<typeof homeNativeCategorySchema>, number> = {
  discussion: 2,
  confession: 4,
  companions: 99,
  pets: 10,
  internships: 11,
  scenery: 12,
  dorms: 13,
  research: 14,
  deep_sea: 15,
  trading: 3,
  water: 9,
};
const categoryMapping = z
  .strictObject({
    nativeCategory: homeNativeCategorySchema,
    sourceKind: z.enum(['regional', 'global']),
    legacyChoose: z.number().int(),
  })
  .refine(
    (m) =>
      m.sourceKind === 'global'
        ? m.nativeCategory === 'discussion' && m.legacyChoose === 100
        : schoolCodes[m.nativeCategory] === m.legacyChoose,
    'Unsupported fixed-source category mapping',
  );
const scopeMapping = z
  .strictObject({
    sourceSpaceId: id,
    sourceKind: z.enum(['regional', 'global']),
    sourceRegionId: id.nullable(),
    targetWaterSpaceId: id,
    targetRegionId: id,
  })
  .refine(
    (m) =>
      m.sourceKind === 'global'
        ? m.sourceRegionId === null
        : m.sourceRegionId === m.targetRegionId &&
          m.sourceSpaceId === m.targetWaterSpaceId,
    'Unsupported placement mapping',
  );
export const homeAdmissionDefinitionSchema = z
  .strictObject({
    version: z.literal(1),
    sourceCommit: z.literal(HOME_POLICY_SOURCE),
    categoryMappings: z.array(categoryMapping).min(1).max(12),
    scopeMappings: z.array(scopeMapping).min(1).max(16),
    authorModes: z
      .array(z.enum(['named', 'anonymous']))
      .min(1)
      .max(2),
    exemptions: z.discriminatedUnion('audit', [
      z.strictObject({
        audit: z.literal('none'),
        attachments: z.literal('normalized_server_facts'),
      }),
      z.strictObject({
        audit: z.literal('institution5_owner'),
        attachments: z.literal('normalized_server_facts'),
        owner: z.literal('verification_assertion_institution'),
        legacyInstitution: z.literal(5),
        institutionId: id,
        regionId: id,
        evidenceRef: evidence(500),
      }),
    ]),
    surfaces: z.strictObject({
      home: z.literal(true),
      hot: z.enum(['disabled', 'exclude_water']),
      following: z.enum(['excluded', 'named_only_author_filter']),
    }),
    markdownReferences: z.literal(false),
  })
  .superRefine((v, ctx) => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (
      !unique(
        v.categoryMappings.map((m) => `${m.sourceKind}:${m.nativeCategory}`),
      ) ||
      !unique(
        v.scopeMappings.map((m) => `${m.sourceSpaceId}:${m.targetRegionId}`),
      ) ||
      !unique(v.authorModes)
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate admission mapping' });
    if (
      !v.categoryMappings.some(
        (m) =>
          m.nativeCategory === 'water' &&
          m.sourceKind === 'regional' &&
          m.legacyChoose === 9,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Explicit water mapping required',
      });
    if (
      v.categoryMappings.some(
        (m) => !v.scopeMappings.some((s) => s.sourceKind === m.sourceKind),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Category mapping has no admitted scope kind',
      });
  });
export type HomeAdmissionDefinition = z.infer<
  typeof homeAdmissionDefinitionSchema
>;
export interface AdmissionRef {
  readonly id: string;
  readonly revision: number;
  readonly digest: string;
  readonly sourceCommit: typeof HOME_POLICY_SOURCE;
  readonly validUntil: string;
}
export interface HomeAdmission {
  readonly ref: AdmissionRef;
  readonly definition: HomeAdmissionDefinition;
}
export interface HomeMappingInput {
  category: string;
  spaceId: string;
  spaceKind: 'regional' | 'global';
  regionId: string | null;
  authorMode: 'named' | 'anonymous';
  authorOriginRegionId: string | null;
}
export interface HomeMapping {
  legacyChoose: number;
  targetWaterSpaceId: string;
  targetWaterRegionId: string;
  admission: AdmissionRef;
}
export function admissionDefinitionDigest(
  definition: HomeAdmissionDefinition,
): string {
  return createHash('sha256')
    .update(
      HOME_ADMISSION_DOMAIN +
        canonicalJson(homeAdmissionDefinitionSchema.parse(definition)),
    )
    .digest('hex');
}
const fields = {
  definition: homeAdmissionDefinitionSchema,
  evidenceRef: evidence(1000),
  validForHours: z.number().int().min(1).max(168),
};
export const homeAdmissionCommandSchema = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('prepare'), ...fields }),
  z.strictObject({
    command: z.literal('apply'),
    ...fields,
    preparationId: id,
    expectedRevision: z.number().int().min(0).max(2147483646),
    previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ command: z.literal('preflight') }),
]);
export type HomeAdmissionCommand = z.infer<typeof homeAdmissionCommandSchema>;
