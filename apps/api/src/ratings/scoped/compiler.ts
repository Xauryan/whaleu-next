import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';
import { scopedDigest, scopedId } from './contracts.js';
import { ratingScopedDigest } from './protocol-registry.js';
import {
  RATING_SCOPED_BYTE_LIMIT,
  RATING_SCOPED_CATEGORY_LIMIT,
  RATING_SCOPED_MEMBERSHIP_LIMIT,
  RATING_SCOPED_RELEASE_CATEGORY_LIMIT,
  RATING_SCOPED_RELEASE_MEMBERSHIP_LIMIT,
  RATING_SCOPED_SCOPE_LIMIT,
} from './constants.js';
const nullableId = scopedId.nullable();
export const scopedExpectedCategorySchema = z.strictObject({
  body: z.strictObject({
    id: scopedId,
    parentId: nullableId,
    level: z.number().int().min(1).max(3),
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    systemKey: z.string().nullable(),
    isSystem: z.boolean(),
    originKind: z.enum(['global', 'regional', 'system']),
    name: z.string(),
    description: z.string(),
    active: z.boolean(),
    hidden: z.boolean(),
    ordinal: z.string().regex(/^(0|[1-9][0-9]*)$/),
    identityKind: z.enum(['native_bridge', 'adopted', 'scoped_source']),
    identityId: scopedId,
  }),
  baseSourceId: scopedId,
  baseSourceRevision: scopedId,
  overrideSourceId: nullableId,
  overrideSourceRevision: nullableId,
  lifecycleSourceId: nullableId,
  lifecycleSourceRevision: nullableId,
  orderSourceId: nullableId,
  orderSourceRevision: nullableId,
  placementRevision: scopedId,
});
export type ScopedExpectedCategory = z.infer<
  typeof scopedExpectedCategorySchema
>;
export interface ScopedMembershipInput {
  targetId: string;
  categoryId: string;
  placementRevision: string;
  ordinal: string;
  targetRegionId: string | null;
}
export interface ScopedCompilationInput {
  scopeKey: string;
  regionId: string | null;
  campusId: string | null;
  sourceVector: unknown[];
  categories: unknown[];
  memberships: ScopedMembershipInput[];
  validUntil: Date;
  before: { catalogId: string; headRevision: string } | null;
}
export interface ScopedCompiledCategory {
  revision: string;
  digest: string;
  expected: ScopedExpectedCategory;
}
export interface ScopedCompiledCatalog {
  id: string;
  headRevision: string;
  scopeKey: string;
  regionId: string | null;
  campusId: string | null;
  sourceVector: unknown[];
  sourceDigest: string;
  categories: ScopedCompiledCategory[];
  categoryDigest: string;
  memberships: ScopedMembershipInput[];
  membershipDigest: string;
  validUntil: Date;
  before: ScopedCompilationInput['before'];
}
function unavailable(): never {
  throw new ApplicationError('RATING_UNAVAILABLE');
}
/** One ledger for the entire affected set, including negative/ancestor inputs.
 * Every overflow rejects before publication, never a per-scope 64 MiB loophole. */
export class RatingScopedCompilationBudget {
  private bytes = 0;
  private categories = 0;
  private members = 0;
  private scopes = 0;
  private readonly admittedInputs = new WeakSet<ScopedCompilationInput>();
  /** Charge the input before a repository accumulates it. The pure compiler
   * may see that same object later; it must not charge a second head. */
  observeInput(input: ScopedCompilationInput) {
    if (this.admittedInputs.has(input)) return;
    this.observe(input, {
      scopes: 1,
      categories: input.categories.length,
      members: input.memberships.length,
    });
    this.admittedInputs.add(input);
  }
  observe(
    value: unknown,
    counts: { categories?: number; members?: number; scopes?: number } = {},
  ) {
    this.bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    this.categories += counts.categories ?? 0;
    this.members += counts.members ?? 0;
    this.scopes += counts.scopes ?? 0;
    if (
      this.bytes > RATING_SCOPED_BYTE_LIMIT ||
      this.categories > RATING_SCOPED_RELEASE_CATEGORY_LIMIT ||
      this.members > RATING_SCOPED_RELEASE_MEMBERSHIP_LIMIT ||
      this.scopes > RATING_SCOPED_SCOPE_LIMIT
    )
      unavailable();
  }
  snapshot() {
    return Object.freeze({
      bytes: this.bytes,
      categories: this.categories,
      memberships: this.members,
      scopes: this.scopes,
    });
  }
}
/** No database writes or authority inference. SQL independently verifies outputs. */
export class RatingScopedCatalogCompiler {
  compile(
    inputs: readonly ScopedCompilationInput[],
    budget = new RatingScopedCompilationBudget(),
  ): ScopedCompiledCatalog[] {
    if (
      !inputs.length ||
      inputs.length > RATING_SCOPED_SCOPE_LIMIT ||
      new Set(inputs.map((i) => i.scopeKey)).size !== inputs.length
    )
      unavailable();
    const output: ScopedCompiledCatalog[] = [];
    for (const input of [...inputs].sort((a, b) =>
      a.scopeKey < b.scopeKey ? -1 : 1,
    )) {
      budget.observeInput(input);
      if (
        input.categories.length > RATING_SCOPED_CATEGORY_LIMIT ||
        input.memberships.length > RATING_SCOPED_MEMBERSHIP_LIMIT ||
        !Number.isFinite(input.validUntil.getTime()) ||
        (input.scopeKey === 'global') !==
          (input.campusId === null && input.regionId === null)
      )
        unavailable();
      const categories = input.categories.map((v) =>
        scopedExpectedCategorySchema.parse(v),
      );
      const byId = new Map(categories.map((v) => [v.body.id, v]));
      if (
        byId.size !== categories.length ||
        new Set(categories.map((v) => v.body.ordinal)).size !==
          categories.length
      )
        unavailable();
      for (const row of categories) {
        const b = row.body;
        const parent = b.parentId === null ? null : byId.get(b.parentId);
        if (
          (b.level === 1) !== (b.parentId === null) ||
          (parent &&
            (parent.body.level + 1 !== b.level ||
              parent.body.kind !== b.kind)) ||
          (b.parentId !== null && !parent) ||
          b.isSystem !== (b.systemKey !== null) ||
          !b.name.trim() ||
          b.name !== b.name.trim() ||
          [...b.name].length > 100 ||
          [...b.description].length > 500
        )
          unavailable();
      }
      const memberships = [...input.memberships].sort((a, b) =>
        BigInt(a.ordinal) < BigInt(b.ordinal) ? -1 : 1,
      );
      if (
        new Set(memberships.map((v) => v.targetId)).size !==
          memberships.length ||
        new Set(memberships.map((v) => v.ordinal)).size !== memberships.length
      )
        unavailable();
      for (const m of memberships)
        if (
          !scopedId.safeParse(m.targetId).success ||
          !scopedId.safeParse(m.placementRevision).success ||
          !byId.has(m.categoryId) ||
          !/^(0|[1-9][0-9]*)$/.test(m.ordinal)
        )
          unavailable();
      const compiled = categories
        .sort((a, b) =>
          BigInt(a.body.ordinal) < BigInt(b.body.ordinal) ? -1 : 1,
        )
        .map((expected) => ({
          revision: randomUUID(),
          digest: ratingScopedDigest('effective', expected),
          expected,
        }));
      const catalog: ScopedCompiledCatalog = {
        id: randomUUID(),
        headRevision: randomUUID(),
        scopeKey: input.scopeKey,
        regionId: input.regionId,
        campusId: input.campusId,
        sourceVector: input.sourceVector,
        sourceDigest: ratingScopedDigest('vector', input.sourceVector),
        categories: compiled,
        categoryDigest: ratingScopedDigest(
          'categories',
          compiled.map((c) => ({
            revision: c.revision,
            digest: c.digest,
            expected: c.expected,
          })),
        ),
        memberships,
        membershipDigest: ratingScopedDigest(
          'memberships',
          memberships.map(({ targetRegionId: _, ...m }) => m),
        ),
        validUntil: input.validUntil,
        before: input.before,
      };
      if (!scopedDigest.safeParse(catalog.sourceDigest).success) unavailable();
      budget.observe(catalog);
      output.push(catalog);
    }
    return output;
  }
}
