import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { invalidRating, ratingId } from './contract';
import {
  canonicalRatingScopedJson,
  ratingScopedDigest,
} from './scoped-contract';
import {
  decodeRatingCategoryScopedIntent,
  decodeRatingCategoryScopedContext,
  decodeRatingCategoryScopedReceipt,
  decodeRatingCategoryScopedPreparation,
  decodeRatingManagedCategory,
  ratingCategoryScopedIntentHash,
  ratingCategoryScopedJsonByteLength,
  type RatingCategoryScopedIntent,
  type RatingCategoryScopedPayloads,
  type RatingCategoryScopedOperation,
  type RatingCategoryScopedContext,
  type RatingCategoryScopedReceipt,
  type RatingCategoryScopedPreparation,
  type RatingManagedCategory,
} from './category-scoped-contract';

export const RATING_CATEGORY_ICON_PROTOCOL = 5 as const;
export const RATING_CATEGORY_ICON_JOURNAL = 13 as const;
export const RATING_CATEGORY_ICON_CAPABILITY = 'category_icon' as const;
export type CategoryIconReplacement = {
  readonly mode: 'replace';
  readonly assetId: string;
  readonly uploadScopeId: string;
};
export type CategoryIconCreate =
  { readonly mode: 'clear' } | CategoryIconReplacement;
export type CategoryIconBaseEdit =
  { readonly mode: 'keep' } | CategoryIconCreate;
export type CategoryIconOverrideEdit =
  | { readonly mode: 'inherit' }
  | {
      readonly mode: 'set';
      readonly value:
        null | { readonly mode: 'keep' } | CategoryIconReplacement;
    };
type IconPayload<K extends RatingCategoryScopedOperation> =
  K extends 'create_categories_scoped'
    ? Omit<RatingCategoryScopedPayloads[K], 'nodes'> & {
        readonly nodes: readonly (RatingCategoryScopedPayloads['create_categories_scoped']['nodes'][number] & {
          readonly icon: CategoryIconCreate;
        })[];
      }
    : K extends 'batch_update_subcategories_scoped'
      ? Omit<RatingCategoryScopedPayloads[K], 'addNodes'> & {
          readonly addNodes: readonly (RatingCategoryScopedPayloads['batch_update_subcategories_scoped']['addNodes'][number] & {
            readonly icon: CategoryIconCreate;
          })[];
        }
      : K extends 'edit_category_base_scoped'
        ? RatingCategoryScopedPayloads[K] & {
            readonly icon: CategoryIconBaseEdit;
          }
        : K extends 'set_category_override_scoped'
          ? RatingCategoryScopedPayloads[K] & {
              readonly icon: CategoryIconOverrideEdit;
            }
          : K extends 'create_system_category_scoped'
            ? RatingCategoryScopedPayloads[K] & {
                readonly icon: CategoryIconCreate;
              }
            : RatingCategoryScopedPayloads[K];
export type RatingCategoryIconIntent = {
  [K in RatingCategoryScopedOperation]: {
    readonly protocolVersion: 5;
    readonly mediaSnapshot: string;
    readonly context: RatingCategoryScopedIntent['context'];
    readonly operation: K;
    readonly payload: IconPayload<K>;
  };
}[RatingCategoryScopedOperation];
export interface RatingCategoryIconContext extends Omit<
  RatingCategoryScopedContext,
  'protocolVersion'
> {
  readonly protocolVersion: 5;
  readonly mediaSnapshot: string;
  readonly capabilities: readonly ['category_icon'];
}
export interface CategoryIconState {
  readonly state: 'image' | 'absent' | 'inherit' | 'unavailable';
  readonly appearanceId: string | null;
}
export interface RatingManagedIconCategory extends RatingManagedCategory {
  readonly icon: {
    readonly base: CategoryIconState;
    readonly override: {
      readonly mode: 'inherit' | 'set';
      readonly state: CategoryIconState;
    };
    readonly effective: CategoryIconState;
  };
}
export interface RatingManagedIconCategories {
  readonly items: readonly RatingManagedIconCategory[];
  readonly snapshotRevision: string;
  readonly mediaSnapshot: string;
  readonly complete: true;
}
export type RatingCategoryIconReceipt = Omit<
  RatingCategoryScopedReceipt,
  'protocolVersion' | 'result'
> & { readonly protocolVersion: 5 } & (
    | {
        readonly outcome: 'closed';
        readonly code: Extract<
          RatingCategoryScopedReceipt,
          { outcome: 'closed' }
        >['code'];
      }
    | {
        readonly outcome: 'applied' | 'noop';
        readonly result: Extract<
          RatingCategoryScopedReceipt,
          { outcome: 'applied' | 'noop' }
        >['result'] & { readonly mediaReleaseDigest: string | null };
      }
  );
export interface RatingCategoryIconPreparation extends RatingCategoryScopedPreparation {
  readonly protocolVersion: 5;
  readonly mediaSnapshot: string;
  readonly changedIconCount: number;
  readonly iconChanges: readonly {
    readonly categoryId: string;
    readonly kind: 'base' | 'override';
    readonly campusId: string | null;
    readonly before: CategoryIconState;
    readonly after: CategoryIconState;
  }[];
}
export type RatingCategoryIconPrepared =
  RatingCategoryIconPreparation | RatingCategoryIconReceipt;
export interface RatingCategoryIconRetirementRequest {
  readonly requestId: string;
  readonly appearanceIds: readonly string[];
}
export type RatingCategoryIconRetirementStatusRequest =
  { readonly requestId: string } | RatingCategoryIconRetirementRequest;
export interface RatingCategoryIconRetirementStatus {
  readonly items: readonly {
    readonly appearanceId: string;
    readonly state: 'eligible' | 'held' | 'retired';
  }[];
}
export interface RatingCategoryIconRetirementCleanup {
  readonly state: 'cleanup_pending';
  readonly appearanceIds: readonly string[];
}
const digest = (value: unknown): string => {
  if (!ratingScopedDigest(value)) invalidRating();
  return value;
};
const id = (value: unknown): string => {
  if (!ratingId(value)) invalidRating();
  return value;
};
function retirementIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256)
    invalidRating();
  const ids = value.map(id);
  if (new Set(ids).size !== ids.length) invalidRating();
  return Object.freeze(ids);
}
export function decodeRatingCategoryIconRetirementRequest(
  value: unknown,
): RatingCategoryIconRetirementRequest {
  exact(value, ['requestId', 'appearanceIds']);
  return Object.freeze({
    requestId: id(value.requestId),
    appearanceIds: retirementIds(value.appearanceIds),
  });
}
export function decodeRatingCategoryIconRetirementStatusRequest(
  value: unknown,
): RatingCategoryIconRetirementStatusRequest {
  if (!isRecord(value)) invalidRating();
  if ('appearanceIds' in value)
    return decodeRatingCategoryIconRetirementRequest(value);
  exact(value, ['requestId']);
  return Object.freeze({ requestId: id(value.requestId) });
}
export function decodeRatingCategoryIconRetirementStatus(
  value: unknown,
): RatingCategoryIconRetirementStatus {
  exact(value, ['items']);
  if (!Array.isArray(value.items) || value.items.length > 100000)
    invalidRating();
  const items = value.items.map((item: unknown) => {
    exact(item, ['appearanceId', 'state']);
    if (
      item.state !== 'eligible' &&
      item.state !== 'held' &&
      item.state !== 'retired'
    )
      invalidRating();
    return Object.freeze({
      appearanceId: id(item.appearanceId),
      state: item.state,
    });
  });
  if (new Set(items.map((item) => item.appearanceId)).size !== items.length)
    invalidRating();
  return Object.freeze({ items: Object.freeze(items) });
}
export function decodeRatingCategoryIconRetirementCleanup(
  value: unknown,
): RatingCategoryIconRetirementCleanup {
  exact(value, ['state', 'appearanceIds']);
  if (value.state !== 'cleanup_pending') invalidRating();
  return Object.freeze({
    state: 'cleanup_pending',
    appearanceIds: retirementIds(value.appearanceIds),
  });
}
export function matchRatingCategoryIconRetirementIds(
  expected: readonly string[],
  actual: readonly string[],
): void {
  const ids = new Set(actual);
  if (
    ids.size !== actual.length ||
    expected.length !== actual.length ||
    expected.some((value) => !ids.has(value))
  )
    invalidRating();
}
/** Only displaced images in this exact preparation are local cleanup candidates.
 * Inheritance, unavailable values, keeps and effective/base fallbacks prove nothing. */
export function ratingCategoryIconRetirementCandidates(
  raw: RatingCategoryIconPreparation,
): readonly string[] {
  const prepared = decodeRatingCategoryIconPreparation(raw);
  return Object.freeze([
    ...new Set(
      prepared.iconChanges.flatMap((change) =>
        change.before.state === 'image' &&
        change.before.appearanceId !== null &&
        (change.after.state === 'absent' ||
          (change.after.state === 'image' &&
            change.after.appearanceId !== change.before.appearanceId))
          ? [change.before.appearanceId]
          : [],
      ),
    ),
  ]);
}
export function decodeCategoryIconReplacement(
  value: unknown,
): CategoryIconReplacement {
  exact(value, ['mode', 'assetId', 'uploadScopeId']);
  if (value.mode !== 'replace') invalidRating();
  return Object.freeze({
    mode: 'replace',
    assetId: id(value.assetId),
    uploadScopeId: id(value.uploadScopeId),
  });
}
export function decodeCategoryIconBase(
  value: unknown,
  create = false,
): CategoryIconBaseEdit {
  if (!isRecord(value)) invalidRating();
  if (value.mode === 'replace') return decodeCategoryIconReplacement(value);
  exact(value, ['mode']);
  if (value.mode !== 'clear' && (create || value.mode !== 'keep'))
    invalidRating();
  return Object.freeze({ mode: value.mode as 'clear' | 'keep' });
}
export function decodeCategoryIconOverride(
  value: unknown,
): CategoryIconOverrideEdit {
  if (!isRecord(value)) invalidRating();
  if (value.mode === 'inherit') {
    exact(value, ['mode']);
    return Object.freeze({ mode: 'inherit' });
  }
  exact(value, ['mode', 'value']);
  if (value.mode !== 'set') invalidRating();
  const icon =
    value.value === null ? null : decodeCategoryIconBase(value.value);
  if (icon?.mode === 'clear') invalidRating();
  return Object.freeze({ mode: 'set', value: icon });
}
/** Only a pure local projection calls the frozen v2 codec. A v5 wire command is
 * version-dispatched here first; old network and journal semantics stay frozen. */
export function decodeRatingCategoryIconIntent(
  value: unknown,
): RatingCategoryIconIntent {
  exact(value, [
    'protocolVersion',
    'mediaSnapshot',
    'context',
    'operation',
    'payload',
  ]);
  if (value.protocolVersion !== 5 || !isRecord(value.payload)) invalidRating();
  const mediaSnapshot = digest(value.mediaSnapshot),
    p = value.payload;
  let textPayload: Record<string, unknown> = { ...p };
  let iconFields: Record<string, unknown> = {};
  const refs: CategoryIconReplacement[] = [];
  const remember = (icon: CategoryIconBaseEdit): void => {
    if (icon.mode === 'replace') refs.push(icon);
  };
  if (
    value.operation === 'create_categories_scoped' ||
    value.operation === 'batch_update_subcategories_scoped'
  ) {
    const key =
      value.operation === 'create_categories_scoped' ? 'nodes' : 'addNodes';
    if (!Array.isArray(p[key])) invalidRating();
    const nodes = p[key].map((node: unknown) => {
      if (!isRecord(node)) invalidRating();
      const { icon: raw, ...text } = node;
      const icon = decodeCategoryIconBase(raw, true) as CategoryIconCreate;
      remember(icon);
      return { text, icon };
    });
    textPayload[key] = nodes.map((node) => node.text);
    iconFields[key] = nodes.map((node) =>
      Object.freeze({ ...node.text, icon: node.icon }),
    );
  } else if (
    value.operation === 'edit_category_base_scoped' ||
    value.operation === 'create_system_category_scoped' ||
    value.operation === 'set_category_override_scoped'
  ) {
    const { icon: raw, ...text } = p;
    textPayload = text;
    if (value.operation === 'set_category_override_scoped') {
      const icon = decodeCategoryIconOverride(raw);
      if (icon.mode === 'set' && icon.value) remember(icon.value);
      iconFields = { icon };
    } else {
      const icon = decodeCategoryIconBase(
        raw,
        value.operation === 'create_system_category_scoped',
      );
      remember(icon);
      iconFields = { icon };
    }
  }
  const text = decodeRatingCategoryScopedIntent({
    protocolVersion: 2,
    context: value.context,
    operation: value.operation,
    payload: textPayload,
  });
  if (
    text.operation === 'set_category_override_scoped' &&
    text.context.selector.kind !== 'campus'
  )
    invalidRating();
  if (
    new Set(refs.map((r) => r.assetId)).size !== refs.length ||
    new Set(refs.map((r) => r.uploadScopeId)).size !== refs.length
  )
    invalidRating();
  return Object.freeze({
    ...text,
    protocolVersion: 5,
    mediaSnapshot,
    payload: Object.freeze({ ...text.payload, ...iconFields }),
  }) as RatingCategoryIconIntent;
}
export function categoryIconTextIntent(
  raw: RatingCategoryIconIntent,
): RatingCategoryScopedIntent {
  const intent = decodeRatingCategoryIconIntent(raw);
  let payload: unknown = intent.payload;
  if (intent.operation === 'create_categories_scoped')
    payload = {
      ...intent.payload,
      nodes: intent.payload.nodes.map(({ icon: _icon, ...node }) => node),
    };
  else if (intent.operation === 'batch_update_subcategories_scoped')
    payload = {
      ...intent.payload,
      addNodes: intent.payload.addNodes.map(({ icon: _icon, ...node }) => node),
    };
  else if (
    intent.operation === 'edit_category_base_scoped' ||
    intent.operation === 'set_category_override_scoped' ||
    intent.operation === 'create_system_category_scoped'
  ) {
    const { icon: _icon, ...text } = intent.payload;
    void _icon;
    payload = text;
  }
  return decodeRatingCategoryScopedIntent({
    protocolVersion: 2,
    operation: intent.operation,
    context: intent.context,
    payload,
  });
}
export function categoryIconTextHash(intent: RatingCategoryIconIntent): string {
  return ratingCategoryScopedIntentHash(categoryIconTextIntent(intent));
}
export function ratingCategoryIconIntentHash(
  raw: RatingCategoryIconIntent,
): string {
  return sha256(
    'ratings-category-icon-command:v1:' +
      canonicalRatingScopedJson(decodeRatingCategoryIconIntent(raw)),
  );
}
export function categoryIconReplacements(
  intent: RatingCategoryIconIntent,
): readonly CategoryIconReplacement[] {
  switch (intent.operation) {
    case 'create_categories_scoped':
      return intent.payload.nodes.flatMap((n) =>
        n.icon.mode === 'replace' ? [n.icon] : [],
      );
    case 'batch_update_subcategories_scoped':
      return intent.payload.addNodes.flatMap((n) =>
        n.icon.mode === 'replace' ? [n.icon] : [],
      );
    case 'edit_category_base_scoped':
    case 'create_system_category_scoped':
      return intent.payload.icon.mode === 'replace'
        ? [intent.payload.icon]
        : [];
    case 'set_category_override_scoped':
      return intent.payload.icon.mode === 'set' &&
        intent.payload.icon.value?.mode === 'replace'
        ? [intent.payload.icon.value]
        : [];
    default:
      return [];
  }
}
export function decodeRatingCategoryIconContext(
  value: unknown,
): RatingCategoryIconContext {
  if (!isRecord(value)) invalidRating();
  const { mediaSnapshot, capabilities, ...old } = value;
  if (
    old.protocolVersion !== 5 ||
    !Array.isArray(capabilities) ||
    capabilities.length !== 1 ||
    capabilities[0] !== 'category_icon'
  )
    invalidRating();
  return Object.freeze({
    ...decodeRatingCategoryScopedContext({ ...old, protocolVersion: 2 }),
    protocolVersion: 5,
    mediaSnapshot: digest(mediaSnapshot),
    capabilities: Object.freeze(['category_icon'] as const),
  });
}
export function decodeCategoryIconState(value: unknown): CategoryIconState {
  exact(value, ['state', 'appearanceId']);
  if (
    !['image', 'absent', 'inherit', 'unavailable'].includes(String(value.state))
  )
    invalidRating();
  const appearanceId =
    value.appearanceId === null ? null : id(value.appearanceId);
  if ((value.state === 'image') !== (appearanceId !== null)) invalidRating();
  return Object.freeze({
    state: value.state as CategoryIconState['state'],
    appearanceId,
  });
}
export function decodeRatingManagedIconCategory(
  value: unknown,
): RatingManagedIconCategory {
  if (!isRecord(value)) invalidRating();
  const { icon, ...old } = value;
  exact(icon, ['base', 'override', 'effective']);
  exact(icon.override, ['mode', 'state']);
  if (icon.override.mode !== 'inherit' && icon.override.mode !== 'set')
    invalidRating();
  const state = decodeCategoryIconState(icon.override.state);
  if (
    (icon.override.mode === 'inherit') !== (state.state === 'inherit') ||
    decodeCategoryIconState(icon.base).state === 'inherit' ||
    decodeCategoryIconState(icon.effective).state === 'inherit'
  )
    invalidRating();
  return Object.freeze({
    ...decodeRatingManagedCategory(old),
    icon: Object.freeze({
      base: decodeCategoryIconState(icon.base),
      override: Object.freeze({ mode: icon.override.mode, state }),
      effective: decodeCategoryIconState(icon.effective),
    }),
  });
}
export function decodeRatingManagedIconCategories(
  value: unknown,
): RatingManagedIconCategories {
  exact(value, ['items', 'snapshotRevision', 'mediaSnapshot', 'complete']);
  if (
    value.complete !== true ||
    !Array.isArray(value.items) ||
    value.items.length > 10000
  )
    invalidRating();
  const items = Object.freeze(value.items.map(decodeRatingManagedIconCategory));
  if (new Set(items.map((i) => i.id)).size !== items.length) invalidRating();
  return Object.freeze({
    items,
    snapshotRevision: digest(value.snapshotRevision),
    mediaSnapshot: digest(value.mediaSnapshot),
    complete: true,
  });
}
export function decodeRatingCategoryIconReceipt(
  value: unknown,
): RatingCategoryIconReceipt {
  if (!isRecord(value) || value.protocolVersion !== 5) invalidRating();
  if (value.outcome === 'closed')
    return Object.freeze({
      ...decodeRatingCategoryScopedReceipt({ ...value, protocolVersion: 2 }),
      protocolVersion: 5,
    }) as RatingCategoryIconReceipt;
  if (!isRecord(value.result)) invalidRating();
  const { mediaReleaseDigest, ...result } = value.result;
  const old = decodeRatingCategoryScopedReceipt({
    ...value,
    protocolVersion: 2,
    result,
  });
  if (old.outcome === 'closed') invalidRating();
  if ((old.result.releaseId === null) !== (mediaReleaseDigest === null))
    invalidRating();
  return Object.freeze({
    ...old,
    protocolVersion: 5,
    result: Object.freeze({
      ...old.result,
      mediaReleaseDigest:
        mediaReleaseDigest === null ? null : digest(mediaReleaseDigest),
    }),
  });
}
export function decodeRatingCategoryIconPreparation(
  value: unknown,
): RatingCategoryIconPreparation {
  if (!isRecord(value)) invalidRating();
  const {
    protocolVersion,
    mediaSnapshot,
    changedIconCount,
    iconChanges,
    ...old
  } = value;
  if (
    protocolVersion !== 5 ||
    !Number.isSafeInteger(changedIconCount) ||
    Number(changedIconCount) < 0 ||
    Number(changedIconCount) > 100000 ||
    !Array.isArray(iconChanges) ||
    iconChanges.length > 100000
  )
    invalidRating();
  const changes = Object.freeze(
    iconChanges.map((change: unknown) => {
      exact(change, ['categoryId', 'kind', 'campusId', 'before', 'after']);
      if (change.kind !== 'base' && change.kind !== 'override') invalidRating();
      const campusId = change.campusId === null ? null : id(change.campusId);
      if ((change.kind === 'base') !== (campusId === null)) invalidRating();
      return Object.freeze({
        categoryId: id(change.categoryId),
        kind: change.kind,
        campusId,
        before: decodeCategoryIconState(change.before),
        after: decodeCategoryIconState(change.after),
      });
    }),
  );
  return Object.freeze({
    ...decodeRatingCategoryScopedPreparation(old),
    protocolVersion: 5,
    mediaSnapshot: digest(mediaSnapshot),
    changedIconCount: changedIconCount as number,
    iconChanges: changes,
  });
}
export function decodeRatingCategoryIconPrepared(
  value: unknown,
): RatingCategoryIconPrepared {
  return isRecord(value) && 'outcome' in value
    ? decodeRatingCategoryIconReceipt(value)
    : decodeRatingCategoryIconPreparation(value);
}
export function matchRatingCategoryIconReceipt(
  intent: RatingCategoryIconIntent,
  receipt: RatingCategoryIconReceipt,
): void {
  if (
    receipt.protocolVersion !== 5 ||
    receipt.requestId !== intent.payload.clientRequestId ||
    receipt.operation !== intent.operation ||
    receipt.intentHash !== ratingCategoryIconIntentHash(intent)
  )
    invalidRating();
}
export function matchRatingCategoryIconPreparation(
  intent: RatingCategoryIconIntent,
  prepared: RatingCategoryIconPreparation,
): void {
  if (
    prepared.requestId !== intent.payload.clientRequestId ||
    prepared.mediaSnapshot !== intent.mediaSnapshot
  )
    invalidRating();
}
export function ratingCategoryIconRequestBodyBytes(
  intent: RatingCategoryIconIntent,
) {
  const prepare = ratingCategoryScopedJsonByteLength(intent),
    commit = ratingCategoryScopedJsonByteLength({
      intent,
      preparationContextRevision: '0'.repeat(43),
    });
  return {
    prepare,
    commit,
    cancel: prepare,
    status: 0 as const,
    maximum: Math.max(prepare, commit),
  };
}
