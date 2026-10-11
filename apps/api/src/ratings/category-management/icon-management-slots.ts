import { canonicalJson } from '../../community/content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import type { CategoryIconContent } from './icon-extension.js';
import type {
  CategoryIconBaseRoot,
  CategoryIconRoot,
} from './icon-references.js';

const unavailable = (): never => {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
};

/** Exact management slots are independent of public placement. A base slot uses
 * its original base body even where a campus override supplies the public body.
 * The caller has already expanded base mutations to the full recovery closure;
 * selecting only affected existing scopes never grants a new global placement. */
export function categoryIconManagementSlots(
  roots: readonly CategoryIconRoot[],
  scopeKeys: readonly string[],
): readonly {
  root: CategoryIconRoot;
  base: CategoryIconBaseRoot;
  selector: CategoryIconContent['selector'];
}[] {
  const basesBySource = new Map<string, CategoryIconBaseRoot[]>();
  const sourceKey = (
    categoryId: string,
    identityId: string,
    source: { id: string; revision: string },
  ) => canonicalJson([categoryId, identityId, source]);
  for (const root of roots) {
    if (root.kind !== 'base') continue;
    const key = sourceKey(root.categoryId, root.identityId, root.source),
      bases = basesBySource.get(key) ?? [];
    bases.push(root);
    basesBySource.set(key, bases);
  }
  const affected = new Set(scopeKeys);
  const slots: {
    root: CategoryIconRoot;
    base: CategoryIconBaseRoot;
    selector: CategoryIconContent['selector'];
  }[] = [];
  for (const root of roots) {
    if (root.value.kind !== 'image') continue;
    const source = root.kind === 'base' ? root.source : root.baseSource;
    const bases =
      basesBySource.get(sourceKey(root.categoryId, root.identityId, source)) ??
      [];
    if (bases.length !== 1) return unavailable();
    const keys =
      root.kind === 'base' ? root.scopeKeys : [`campus:${root.campusId}`];
    for (const key of keys) {
      if (!affected.has(key)) continue;
      if (slots.length >= 100000) unavailable();
      slots.push({
        root,
        base: bases[0]!,
        selector:
          key === 'global'
            ? { kind: 'global' }
            : { kind: 'campus', campusId: key.slice(7) },
      });
    }
  }
  return slots;
}
