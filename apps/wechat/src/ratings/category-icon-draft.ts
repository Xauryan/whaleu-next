import { invalidRating } from './contract';
import {
  decodeRatingCategoryScopedIntent,
  ratingCategoryScopedJsonByteLength,
  type RatingCategoryScopedIntent,
} from './category-scoped-contract';
import {
  decodeRatingCategoryIconIntent,
  type RatingCategoryIconIntent,
} from './category-icon-contract';
export type CategoryIconSelection =
  'keep' | 'clear' | 'inherit' | 'set-empty' | 'replace';
export interface CategoryIconDraftSlot {
  readonly key: string;
  readonly kind: 'base' | 'override';
  readonly campusId: string | null;
  readonly categoryId: string | null;
  readonly nodeKey: string | null;
  readonly selection: CategoryIconSelection;
}
export function categoryIconDraftSlots(
  raw: RatingCategoryScopedIntent,
  selection: ReadonlyMap<string, CategoryIconSelection>,
): readonly CategoryIconDraftSlot[] {
  const text = decodeRatingCategoryScopedIntent(raw);
  const node = (key: string): CategoryIconDraftSlot => ({
    key: `new:${key}`,
    kind: 'base',
    campusId: null,
    categoryId: null,
    nodeKey: key,
    selection: selection.get(`new:${key}`) ?? 'clear',
  });
  let slots: CategoryIconDraftSlot[] = [];
  switch (text.operation) {
    case 'create_categories_scoped':
      slots = text.payload.nodes.map((n) => node(n.key));
      break;
    case 'batch_update_subcategories_scoped':
      slots = text.payload.addNodes.map((n) => node(n.key));
      break;
    case 'create_system_category_scoped':
      slots = [node('root')];
      break;
    case 'edit_category_base_scoped': {
      const key = `base:${text.payload.categoryId}`;
      slots = [
        {
          key,
          kind: 'base',
          campusId: null,
          categoryId: text.payload.categoryId,
          nodeKey: null,
          selection: selection.get(key) ?? 'keep',
        },
      ];
      break;
    }
    case 'set_category_override_scoped': {
      if (text.context.selector.kind !== 'campus') invalidRating();
      const campusId = text.context.selector.campusId,
        key = `override:${text.payload.categoryId}:${campusId}`;
      slots = [
        {
          key,
          kind: 'override',
          campusId,
          categoryId: text.payload.categoryId,
          nodeKey: null,
          selection: selection.get(key) ?? 'inherit',
        },
      ];
      break;
    }
  }
  for (const slot of slots) {
    const allowed =
      slot.nodeKey !== null
        ? ['clear', 'replace']
        : slot.kind === 'override'
          ? ['inherit', 'set-empty', 'keep', 'replace']
          : ['keep', 'clear', 'replace'];
    if (!allowed.includes(slot.selection)) invalidRating();
  }
  return Object.freeze(slots.map((s) => Object.freeze(s)));
}
export interface CategoryIconDraftReady {
  readonly slotKey: string;
  readonly assetId: string;
  readonly uploadScopeId: string;
}
/** Draft selection uses explicit pending slots. No asset is invented while an
 * image is being picked, authorized, uploaded or processed. */
export function categoryIconDraftBodyBytes(
  text: RatingCategoryScopedIntent,
  mediaSnapshot: string,
  slots: readonly CategoryIconDraftSlot[],
): number {
  const draft = {
    protocolVersion: 5,
    mediaSnapshot,
    text,
    slots: slots.map((slot) => ({
      ...slot,
      value: slot.selection === 'replace' ? { mode: 'replace_pending' } : null,
    })),
  };
  // The fixed-width future UUID fields are a byte reservation, never an intent.
  return ratingCategoryScopedJsonByteLength(draft) + slots.length * 160 + 1024;
}
export function sealCategoryIconDraft(
  text: RatingCategoryScopedIntent,
  mediaSnapshot: string,
  slots: readonly CategoryIconDraftSlot[],
  ready: readonly CategoryIconDraftReady[],
): RatingCategoryIconIntent {
  const lookup = (key: string): unknown => {
    const slot = slots.find((s) => s.key === key);
    if (!slot) invalidRating();
    if (slot.selection === 'replace') {
      const image = ready.filter((r) => r.slotKey === key);
      if (image.length !== 1) invalidRating();
      return {
        mode: 'replace',
        assetId: image[0]!.assetId,
        uploadScopeId: image[0]!.uploadScopeId,
      };
    }
    if (slot.selection === 'set-empty') return null;
    return { mode: slot.selection };
  };
  let payload: unknown = text.payload;
  switch (text.operation) {
    case 'create_categories_scoped':
      payload = {
        ...text.payload,
        nodes: text.payload.nodes.map((n) => ({
          ...n,
          icon: lookup(`new:${n.key}`),
        })),
      };
      break;
    case 'batch_update_subcategories_scoped':
      payload = {
        ...text.payload,
        addNodes: text.payload.addNodes.map((n) => ({
          ...n,
          icon: lookup(`new:${n.key}`),
        })),
      };
      break;
    case 'create_system_category_scoped':
      payload = { ...text.payload, icon: lookup('new:root') };
      break;
    case 'edit_category_base_scoped':
      payload = {
        ...text.payload,
        icon: lookup(`base:${text.payload.categoryId}`),
      };
      break;
    case 'set_category_override_scoped': {
      if (text.context.selector.kind !== 'campus') invalidRating();
      const key = `override:${text.payload.categoryId}:${text.context.selector.campusId}`,
        slot = slots.find((s) => s.key === key);
      payload = {
        ...text.payload,
        icon:
          slot?.selection === 'inherit'
            ? { mode: 'inherit' }
            : { mode: 'set', value: lookup(key) },
      };
      break;
    }
  }
  return decodeRatingCategoryIconIntent({
    ...text,
    protocolVersion: 5,
    mediaSnapshot,
    payload,
  });
}
