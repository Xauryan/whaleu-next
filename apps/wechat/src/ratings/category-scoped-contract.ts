import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  canonicalRatingText,
  invalidRating,
  ratingCursor,
  ratingId,
} from './contract';
import { ratingTimestamp } from './discussion-contract';
import {
  canonicalRatingScopedJson,
  decodeRatingScopedCommandContext,
  ratingScopedDigest,
  RATING_SCOPED_HASH_DOMAIN,
  type RatingScopedCommandContext,
  type RatingScopedHead,
} from './scoped-contract';

export const RATING_CATEGORY_SCOPED_JOURNAL_VERSION = 10 as const;
export const ratingCategoryScopedOperations = [
  'create_categories_scoped',
  'edit_category_base_scoped',
  'set_category_override_scoped',
  'set_category_visibility_scoped',
  'reorder_categories_scoped',
  'set_category_scope_scoped',
  'set_category_lifecycle_scoped',
  'batch_update_subcategories_scoped',
  'create_system_category_scoped',
] as const;
export type RatingCategoryScopedOperation =
  (typeof ratingCategoryScopedOperations)[number];
export type RatingCategoryPlacement =
  | { readonly kind: 'global' }
  | {
      readonly kind: 'campuses';
      readonly campusIds: readonly string[];
    };
export interface RatingCategoryNode {
  readonly key: string;
  readonly parentKey: string | null;
  readonly name: string;
  readonly description: string;
}
export type RatingCategoryOverride =
  | { readonly mode: 'inherit' }
  | { readonly mode: 'set'; readonly value: string };
export type RatingCategoryState = 'enabled' | 'disabled' | 'archived';
interface CommonPayload {
  readonly clientRequestId: string;
  readonly expectedSnapshot: string;
}
interface CategoryPayload extends CommonPayload {
  readonly categoryId: string;
}
export type RatingCategoryChildRef =
  | { readonly kind: 'existing'; readonly id: string }
  | { readonly kind: 'new'; readonly key: string };
export interface RatingCategoryScopedPayloads {
  readonly create_categories_scoped: CommonPayload & {
    readonly parentId: string | null;
    readonly placement: RatingCategoryPlacement;
    readonly nodes: readonly RatingCategoryNode[];
  };
  readonly edit_category_base_scoped: CategoryPayload & {
    readonly name: string;
    readonly description: string;
  };
  readonly set_category_override_scoped: CategoryPayload & {
    readonly name: RatingCategoryOverride;
    readonly description: RatingCategoryOverride;
  };
  readonly set_category_visibility_scoped: CategoryPayload & {
    readonly hidden: boolean;
  };
  readonly reorder_categories_scoped: CommonPayload & {
    readonly parentId: string | null;
    readonly action: 'set' | 'inherit';
    readonly orderedIds: readonly string[];
  };
  readonly set_category_scope_scoped: CategoryPayload & {
    readonly placement: RatingCategoryPlacement;
    readonly propagation: 'self' | 'subtree';
  };
  readonly set_category_lifecycle_scoped: CategoryPayload & {
    readonly state: RatingCategoryState;
    readonly restore: boolean;
  };
  readonly batch_update_subcategories_scoped: CommonPayload & {
    readonly parentId: string;
    readonly addNodes: readonly RatingCategoryNode[];
    readonly disableIds: readonly string[];
    readonly restoreIds: readonly string[];
    readonly enableIds: readonly string[];
    readonly orderedChildren: readonly RatingCategoryChildRef[];
  };
  readonly create_system_category_scoped: CommonPayload & {
    readonly systemKey: string;
    readonly name: string;
    readonly description: string;
    readonly placement: RatingCategoryPlacement;
    readonly levelCount: 1 | 2 | 3;
  };
}
export type RatingCategoryScopedIntent = {
  [K in RatingCategoryScopedOperation]: {
    readonly protocolVersion: 2;
    readonly context: RatingScopedCommandContext;
    readonly operation: K;
    readonly payload: RatingCategoryScopedPayloads[K];
  };
}[RatingCategoryScopedOperation];
/** The shared server JSON parser remains 64 KiB. Reserve is deliberate room for
 * future request-envelope fields, not permission to omit current fields. Any
 * envelope/token change must update these golden byte-boundary tests. */
export const RATING_CATEGORY_SCOPED_HTTP_BODY_LIMIT = 64 * 1024;
export const RATING_CATEGORY_SCOPED_BODY_RESERVE = 1024;
export const RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET =
  RATING_CATEGORY_SCOPED_HTTP_BODY_LIMIT - RATING_CATEGORY_SCOPED_BODY_RESERVE;
export const RATING_CATEGORY_SCOPED_PREPARATION_TOKEN_LENGTH = 43;

/** Count the actual JSON encoding, including escapes and Unicode. Mini Program
 * runtimes need neither TextEncoder nor Node Buffer. Lone surrogates use UTF-8
 * replacement length if a runtime does not produce well-formed JSON escapes. */
export function ratingCategoryScopedJsonByteLength(value: unknown): number {
  let encoded: string;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') invalidRating();
    encoded = serialized;
  } catch {
    return invalidRating();
  }
  let bytes = 0;
  for (let index = 0; index < encoded.length; index++) {
    const code = encoded.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < encoded.length &&
      encoded.charCodeAt(index + 1) >= 0xdc00 &&
      encoded.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** Shared with the gateway so preflight measures the actual commit envelope. */
export function ratingCategoryScopedCommitEnvelope(
  intent: RatingCategoryScopedIntent,
  preparationContextRevision: string,
): {
  readonly intent: RatingCategoryScopedIntent;
  readonly preparationContextRevision: string;
} {
  return { intent, preparationContextRevision };
}

/** New-draft preflight only. Never apply this to decoding or recovering an
 * existing journal. Status is a GET with no body; response/header bytes are not
 * request-body bytes. Prepare and cancel transmit the same untouched intent. */
export function ratingCategoryScopedRequestBodyBytes(
  intent: RatingCategoryScopedIntent,
): {
  readonly prepare: number;
  readonly commit: number;
  readonly cancel: number;
  readonly status: 0;
  readonly maximum: number;
} {
  const prepare = ratingCategoryScopedJsonByteLength(intent);
  const commit = ratingCategoryScopedJsonByteLength(
    ratingCategoryScopedCommitEnvelope(
      intent,
      '0'.repeat(RATING_CATEGORY_SCOPED_PREPARATION_TOKEN_LENGTH),
    ),
  );
  return Object.freeze({
    prepare,
    commit,
    cancel: prepare,
    status: 0,
    maximum: Math.max(prepare, commit),
  });
}

export interface RatingCategoryScopedContext {
  readonly protocolVersion: 2;
  readonly commandContext: RatingScopedCommandContext;
  readonly expiresAt: string;
  readonly snapshotRevision: string;
  readonly campusIds: readonly string[];
  readonly canManageGlobal: boolean;
  readonly operations: readonly RatingCategoryScopedOperation[];
}
export interface RatingManagedCategory {
  readonly id: string;
  readonly parentId: string | null;
  readonly level: 1 | 2 | 3;
  readonly kind: string;
  readonly systemKey: string | null;
  readonly name: string | null;
  readonly description: string | null;
  readonly revision: string;
  readonly baseRevision: string;
  readonly placementRevision: string;
  readonly lifecycleRevision: string | null;
  readonly overrideRevision: string | null;
  readonly orderRevision: string | null;
  readonly ordinal: string;
  readonly businessState: RatingCategoryState;
  readonly hidden: boolean;
  readonly scopeKeys: readonly string[];
  readonly baseName: string | null;
  readonly baseDescription: string | null;
  readonly override: {
    readonly name: RatingCategoryOverride;
    readonly description: RatingCategoryOverride;
  };
  readonly blockedReason: string | null;
}
export interface RatingManagedCategories {
  readonly items: readonly RatingManagedCategory[];
  readonly snapshotRevision: string;
  readonly complete: true;
}
export interface RatingCategorySystemOption {
  readonly systemKey: string;
  readonly kind: string;
  readonly maximumDepth: 1 | 2 | 3;
  readonly allowCampusOverride: boolean;
  readonly allowDisable: boolean;
}
export interface RatingCategorySystemOptions {
  readonly items: readonly RatingCategorySystemOption[];
}
export const ratingCategoryScopedClosureCodes = [
  'RATING_CATEGORY_CANCELLED',
  'RATING_SCOPED_CONTEXT_CHANGED',
  'RATING_REVISION_CONFLICT',
  'RATING_NOT_FOUND',
  'CONTENT_REJECTED',
  'PHONE_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
] as const;
interface ReceiptCommon {
  readonly protocolVersion: 2;
  readonly requestId: string;
  readonly operation: RatingCategoryScopedOperation;
  readonly intentHash: string;
}
export type RatingCategoryScopedReceipt = ReceiptCommon &
  (
    | {
        readonly outcome: 'closed';
        readonly code: (typeof ratingCategoryScopedClosureCodes)[number];
      }
    | {
        readonly outcome: 'applied' | 'noop';
        readonly result: {
          readonly releaseId: string | null;
          readonly categoryIds: readonly string[];
          readonly heads: readonly RatingScopedHead[];
          readonly occurredAt: string;
        };
      }
  );
export interface RatingCategoryScopedPreparation {
  readonly requestId: string;
  readonly contextRevision: string;
  readonly categoryIds: readonly string[];
  readonly affectedScopeKeys: readonly string[];
  readonly changedSourceCount: number;
  readonly affectedTargetCount: number;
  readonly previewDigest: string;
  readonly summary: string;
  readonly changes: readonly {
    readonly categoryId: string;
    readonly scopeKeys: readonly string[];
    readonly field:
      | 'body'
      | 'base_body'
      | 'effective_body'
      | 'visibility'
      | 'lifecycle'
      | 'scope'
      | 'order'
      | 'create';
    readonly before: string | null;
    readonly after: string | null;
    readonly beforeStatus: 'available' | 'absent' | 'unavailable';
    readonly afterStatus: 'available' | 'absent' | 'unavailable';
  }[];
  readonly expiresAt: string;
}
export type RatingCategoryScopedPrepared =
  RatingCategoryScopedPreparation | RatingCategoryScopedReceipt;
export interface RatingCategoryScopedHistory {
  readonly items: readonly {
    readonly requestId: string;
    readonly operation: RatingCategoryScopedOperation;
    readonly outcome: 'applied' | 'noop' | 'closed';
    readonly releaseId: string | null;
    readonly occurredAt: string;
  }[];
  readonly nextCursor: string | null;
}
const id = (v: unknown): string => {
  if (!ratingId(v)) invalidRating();
  return v;
};
const nullableId = (v: unknown): string | null => (v === null ? null : id(v));
const str = (v: unknown): string => {
  if (typeof v !== 'string') invalidRating();
  return v;
};
const nullableString = (v: unknown): string | null =>
  v === null ? null : str(v);
const bool = (v: unknown): boolean => {
  if (typeof v !== 'boolean') invalidRating();
  return v;
};
const digest = (v: unknown): string => {
  if (!ratingScopedDigest(v)) invalidRating();
  return v;
};
const token = (v: unknown): string => {
  if (!ratingCursor(v)) invalidRating();
  return v;
};
const time = (v: unknown): string => {
  if (!ratingTimestamp(v)) invalidRating();
  return v;
};
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max)
    invalidRating();
  return v;
};
const level = (v: unknown): 1 | 2 | 3 => {
  if (v !== 1 && v !== 2 && v !== 3) invalidRating();
  return v;
};
const key = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(v))
    invalidRating();
  return v;
};
const systemKey = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{1,48}$/.test(v))
    invalidRating();
  return v;
};
const canonical = (v: unknown, max: number, required = true): string => {
  const value = canonicalRatingText(v, max, required);
  if (value !== v) invalidRating();
  return value;
};
function array<T>(
  v: unknown,
  maximum: number,
  decode: (v: unknown) => T,
  minimum = 0,
): readonly T[] {
  if (!Array.isArray(v) || v.length < minimum || v.length > maximum)
    invalidRating();
  return Object.freeze(v.map(decode));
}
function unique<T>(values: readonly T[]): readonly T[] {
  if (new Set(values).size !== values.length) invalidRating();
  return values;
}
const ids = (v: unknown, maximum = 10000): readonly string[] =>
  unique(array(v, maximum, id));
const scopeKey = (v: unknown): string => {
  const s = str(v);
  if (s !== 'global' && !(s.startsWith('campus:') && ratingId(s.slice(7))))
    invalidRating();
  return s;
};
const scopes = (v: unknown, minimum = 0): readonly string[] =>
  unique(array(v, 1001, scopeKey, minimum));
export function isRatingCategoryScopedOperation(
  v: unknown,
): v is RatingCategoryScopedOperation {
  return (ratingCategoryScopedOperations as readonly unknown[]).includes(v);
}
const operation = (v: unknown): RatingCategoryScopedOperation => {
  if (!isRatingCategoryScopedOperation(v)) invalidRating();
  return v;
};
const state = (v: unknown): RatingCategoryState => {
  if (v !== 'enabled' && v !== 'disabled' && v !== 'archived') invalidRating();
  return v;
};
export function decodeRatingCategoryPlacement(
  v: unknown,
): RatingCategoryPlacement {
  if (!isRecord(v)) invalidRating();
  if (v.kind === 'global') {
    exact(v, ['kind']);
    return Object.freeze({ kind: 'global' });
  }
  exact(v, ['kind', 'campusIds']);
  if (v.kind !== 'campuses') invalidRating();
  const campusIds = ids(v.campusIds, 1000);
  if (
    !campusIds.length ||
    campusIds.some(
      (entry, index) => index > 0 && campusIds[index - 1]! >= entry,
    )
  )
    invalidRating();
  return Object.freeze({ kind: 'campuses', campusIds });
}
export function decodeRatingCategoryOverride(
  v: unknown,
  description = false,
): RatingCategoryOverride {
  if (!isRecord(v)) invalidRating();
  if (v.mode === 'inherit') {
    exact(v, ['mode']);
    return Object.freeze({ mode: 'inherit' });
  }
  exact(v, ['mode', 'value']);
  if (v.mode !== 'set') invalidRating();
  return Object.freeze({
    mode: 'set',
    value: canonical(v.value, description ? 500 : 100, !description),
  });
}
export function decodeRatingCategoryNode(v: unknown): RatingCategoryNode {
  exact(v, ['key', 'parentKey', 'name', 'description']);
  return Object.freeze({
    key: key(v.key),
    parentKey: v.parentKey === null ? null : key(v.parentKey),
    name: canonical(v.name, 100),
    description: canonical(v.description, 500, false),
  });
}
const payloadKeys: {
  readonly [K in RatingCategoryScopedOperation]: readonly string[];
} = {
  create_categories_scoped: [
    'clientRequestId',
    'expectedSnapshot',
    'parentId',
    'placement',
    'nodes',
  ],
  edit_category_base_scoped: [
    'clientRequestId',
    'expectedSnapshot',
    'categoryId',
    'name',
    'description',
  ],
  set_category_override_scoped: [
    'clientRequestId',
    'expectedSnapshot',
    'categoryId',
    'name',
    'description',
  ],
  set_category_visibility_scoped: [
    'clientRequestId',
    'expectedSnapshot',
    'categoryId',
    'hidden',
  ],
  reorder_categories_scoped: [
    'clientRequestId',
    'expectedSnapshot',
    'parentId',
    'action',
    'orderedIds',
  ],
  set_category_scope_scoped: [
    'clientRequestId',
    'expectedSnapshot',
    'categoryId',
    'placement',
    'propagation',
  ],
  set_category_lifecycle_scoped: [
    'clientRequestId',
    'expectedSnapshot',
    'categoryId',
    'state',
    'restore',
  ],
  batch_update_subcategories_scoped: [
    'clientRequestId',
    'expectedSnapshot',
    'parentId',
    'addNodes',
    'disableIds',
    'restoreIds',
    'enableIds',
    'orderedChildren',
  ],
  create_system_category_scoped: [
    'clientRequestId',
    'expectedSnapshot',
    'systemKey',
    'name',
    'description',
    'placement',
    'levelCount',
  ],
};
export function decodeRatingCategoryScopedIntent(
  v: unknown,
): RatingCategoryScopedIntent {
  exact(v, ['protocolVersion', 'operation', 'context', 'payload']);
  if (v.protocolVersion !== 2) invalidRating();
  const op = operation(v.operation),
    context = decodeRatingScopedCommandContext(v.context);
  exact(v.payload, payloadKeys[op]);
  const p = v.payload,
    common = {
      clientRequestId: id(p.clientRequestId),
      expectedSnapshot: digest(p.expectedSnapshot),
    };
  const envelope = { protocolVersion: 2 as const, context };
  switch (op) {
    case 'create_categories_scoped':
      return Object.freeze({
        ...envelope,
        operation: op,
        payload: Object.freeze({
          ...common,
          parentId: nullableId(p.parentId),
          placement: decodeRatingCategoryPlacement(p.placement),
          nodes: array(p.nodes, 32, decodeRatingCategoryNode, 1),
        }),
      });
    case 'edit_category_base_scoped':
      return Object.freeze({
        ...envelope,
        operation: op,
        payload: Object.freeze({
          ...common,
          categoryId: id(p.categoryId),
          name: canonical(p.name, 100),
          description: canonical(p.description, 500, false),
        }),
      });
    case 'set_category_override_scoped':
      return Object.freeze({
        ...envelope,
        operation: op,
        payload: Object.freeze({
          ...common,
          categoryId: id(p.categoryId),
          name: decodeRatingCategoryOverride(p.name),
          description: decodeRatingCategoryOverride(p.description, true),
        }),
      });
    case 'set_category_visibility_scoped':
      return Object.freeze({
        ...envelope,
        operation: op,
        payload: Object.freeze({
          ...common,
          categoryId: id(p.categoryId),
          hidden: bool(p.hidden),
        }),
      });
    case 'reorder_categories_scoped': {
      if (p.action !== 'set' && p.action !== 'inherit') invalidRating();
      return Object.freeze({
        ...envelope,
        operation: op,
        payload: Object.freeze({
          ...common,
          parentId: nullableId(p.parentId),
          action: p.action,
          orderedIds: ids(p.orderedIds),
        }),
      });
    }
    case 'set_category_scope_scoped': {
      if (p.propagation !== 'self' && p.propagation !== 'subtree')
        invalidRating();
      return Object.freeze({
        ...envelope,
        operation: op,
        payload: Object.freeze({
          ...common,
          categoryId: id(p.categoryId),
          placement: decodeRatingCategoryPlacement(p.placement),
          propagation: p.propagation,
        }),
      });
    }
    case 'set_category_lifecycle_scoped':
      return Object.freeze({
        ...envelope,
        operation: op,
        payload: Object.freeze({
          ...common,
          categoryId: id(p.categoryId),
          state: state(p.state),
          restore: bool(p.restore),
        }),
      });
    case 'batch_update_subcategories_scoped':
      return Object.freeze({
        ...envelope,
        operation: op,
        payload: Object.freeze({
          ...common,
          parentId: id(p.parentId),
          addNodes: array(p.addNodes, 32, decodeRatingCategoryNode),
          disableIds: ids(p.disableIds),
          restoreIds: ids(p.restoreIds),
          enableIds: ids(p.enableIds),
          orderedChildren: array(
            p.orderedChildren,
            10000,
            (entry): RatingCategoryChildRef => {
              if (!isRecord(entry)) invalidRating();
              if (entry.kind === 'existing') {
                exact(entry, ['kind', 'id']);
                return Object.freeze({ kind: 'existing', id: id(entry.id) });
              }
              exact(entry, ['kind', 'key']);
              if (entry.kind !== 'new') invalidRating();
              return Object.freeze({ kind: 'new', key: key(entry.key) });
            },
          ),
        }),
      });
    case 'create_system_category_scoped':
      return Object.freeze({
        ...envelope,
        operation: op,
        payload: Object.freeze({
          ...common,
          systemKey: systemKey(p.systemKey),
          name: canonical(p.name, 100),
          description: canonical(p.description, 500, false),
          placement: decodeRatingCategoryPlacement(p.placement),
          levelCount: level(p.levelCount),
        }),
      });
  }
}
export function ratingCategoryScopedIntentHash(
  raw: RatingCategoryScopedIntent,
): string {
  const { protocolVersion, operation, context, payload } =
    decodeRatingCategoryScopedIntent(raw);
  return sha256(
    RATING_SCOPED_HASH_DOMAIN +
      canonicalRatingScopedJson({
        protocolVersion,
        operation,
        intent: { context, payload },
      }),
  );
}
export function decodeRatingCategoryScopedContext(
  v: unknown,
): RatingCategoryScopedContext {
  exact(v, [
    'protocolVersion',
    'commandContext',
    'expiresAt',
    'snapshotRevision',
    'campusIds',
    'canManageGlobal',
    'operations',
  ]);
  if (v.protocolVersion !== 2) invalidRating();
  return Object.freeze({
    protocolVersion: 2,
    commandContext: decodeRatingScopedCommandContext(v.commandContext),
    expiresAt: time(v.expiresAt),
    snapshotRevision: digest(v.snapshotRevision),
    campusIds: ids(v.campusIds, 1000),
    canManageGlobal: bool(v.canManageGlobal),
    operations: unique(array(v.operations, 9, operation)),
  });
}
export function decodeRatingManagedCategory(v: unknown): RatingManagedCategory {
  exact(v, [
    'id',
    'parentId',
    'level',
    'kind',
    'systemKey',
    'name',
    'description',
    'revision',
    'baseRevision',
    'placementRevision',
    'lifecycleRevision',
    'overrideRevision',
    'orderRevision',
    'ordinal',
    'businessState',
    'hidden',
    'scopeKeys',
    'baseName',
    'baseDescription',
    'override',
    'blockedReason',
  ]);
  exact(v.override, ['name', 'description']);
  if (typeof v.ordinal !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v.ordinal))
    invalidRating();
  const result = {
    id: id(v.id),
    parentId: nullableId(v.parentId),
    level: level(v.level),
    kind: str(v.kind),
    systemKey: nullableString(v.systemKey),
    name: nullableString(v.name),
    description: nullableString(v.description),
    revision: id(v.revision),
    baseRevision: id(v.baseRevision),
    placementRevision: id(v.placementRevision),
    lifecycleRevision: nullableId(v.lifecycleRevision),
    overrideRevision: nullableId(v.overrideRevision),
    orderRevision: nullableId(v.orderRevision),
    ordinal: v.ordinal,
    businessState: state(v.businessState),
    hidden: bool(v.hidden),
    scopeKeys: scopes(v.scopeKeys),
    baseName: nullableString(v.baseName),
    baseDescription: nullableString(v.baseDescription),
    override: Object.freeze({
      name: decodeRatingCategoryOverride(v.override.name),
      description: decodeRatingCategoryOverride(v.override.description, true),
    }),
    blockedReason: nullableString(v.blockedReason),
  };
  if (result.id === result.parentId) invalidRating();
  return Object.freeze(result);
}
export function decodeRatingManagedCategories(
  v: unknown,
): RatingManagedCategories {
  exact(v, ['items', 'snapshotRevision', 'complete']);
  if (v.complete !== true) invalidRating();
  const items = array(v.items, 10000, decodeRatingManagedCategory);
  unique(items.map((item) => item.id));
  return Object.freeze({
    items,
    snapshotRevision: digest(v.snapshotRevision),
    complete: true,
  });
}
export function decodeRatingCategorySystemOptions(
  v: unknown,
): RatingCategorySystemOptions {
  exact(v, ['items']);
  const items = array(v.items, 1000, (entry): RatingCategorySystemOption => {
    exact(entry, [
      'systemKey',
      'kind',
      'maximumDepth',
      'allowCampusOverride',
      'allowDisable',
    ]);
    return Object.freeze({
      systemKey: systemKey(entry.systemKey),
      kind: str(entry.kind),
      maximumDepth: level(entry.maximumDepth),
      allowCampusOverride: bool(entry.allowCampusOverride),
      allowDisable: bool(entry.allowDisable),
    });
  });
  unique(items.map((item) => item.systemKey));
  return Object.freeze({ items });
}
function decodeHead(v: unknown): RatingScopedHead {
  exact(v, ['scopeKey', 'catalogRevision', 'headRevision']);
  return Object.freeze({
    scopeKey: scopeKey(v.scopeKey),
    catalogRevision: id(v.catalogRevision),
    headRevision: id(v.headRevision),
  });
}
export function decodeRatingCategoryScopedReceipt(
  v: unknown,
): RatingCategoryScopedReceipt {
  if (!isRecord(v)) invalidRating();
  exact(
    v,
    v.outcome === 'closed'
      ? [
          'protocolVersion',
          'requestId',
          'operation',
          'intentHash',
          'outcome',
          'code',
        ]
      : [
          'protocolVersion',
          'requestId',
          'operation',
          'intentHash',
          'outcome',
          'result',
        ],
  );
  if (v.protocolVersion !== 2) invalidRating();
  const common = {
    protocolVersion: 2 as const,
    requestId: id(v.requestId),
    operation: operation(v.operation),
    intentHash: digest(v.intentHash),
  };
  if (v.outcome === 'closed') {
    if (
      !(ratingCategoryScopedClosureCodes as readonly unknown[]).includes(v.code)
    )
      invalidRating();
    return Object.freeze({
      ...common,
      outcome: 'closed',
      code: v.code as (typeof ratingCategoryScopedClosureCodes)[number],
    });
  }
  if (v.outcome !== 'applied' && v.outcome !== 'noop') invalidRating();
  exact(v.result, ['releaseId', 'categoryIds', 'heads', 'occurredAt']);
  const heads = array(v.result.heads, 1001, decodeHead);
  unique(heads.map((head) => head.scopeKey));
  return Object.freeze({
    ...common,
    outcome: v.outcome,
    result: Object.freeze({
      releaseId: nullableId(v.result.releaseId),
      categoryIds: ids(v.result.categoryIds),
      heads,
      occurredAt: time(v.result.occurredAt),
    }),
  });
}
export function decodeRatingCategoryScopedPreparation(
  v: unknown,
): RatingCategoryScopedPreparation {
  exact(v, [
    'requestId',
    'contextRevision',
    'categoryIds',
    'affectedScopeKeys',
    'changedSourceCount',
    'affectedTargetCount',
    'previewDigest',
    'summary',
    'changes',
    'expiresAt',
  ]);
  return Object.freeze({
    requestId: id(v.requestId),
    contextRevision: token(v.contextRevision),
    categoryIds: ids(v.categoryIds),
    affectedScopeKeys: scopes(v.affectedScopeKeys, 1),
    changedSourceCount: integer(v.changedSourceCount, 100000),
    affectedTargetCount: integer(v.affectedTargetCount),
    previewDigest: digest(v.previewDigest),
    summary: str(v.summary),
    changes: array(v.changes, 100000, (entry) => {
      exact(entry, [
        'categoryId',
        'scopeKeys',
        'field',
        'before',
        'after',
        'beforeStatus',
        'afterStatus',
      ]);
      if (
        ![
          'body',
          'base_body',
          'effective_body',
          'visibility',
          'lifecycle',
          'scope',
          'order',
          'create',
        ].includes(entry.field as string)
      )
        invalidRating();
      const before = nullableString(entry.before),
        after = nullableString(entry.after);
      const beforeStatus =
        before !== null
          ? 'available'
          : entry.field === 'create'
            ? 'absent'
            : 'unavailable';
      const afterStatus = after !== null ? 'available' : 'unavailable';
      if (
        entry.beforeStatus !== beforeStatus ||
        entry.afterStatus !== afterStatus
      )
        invalidRating();
      return Object.freeze({
        categoryId: id(entry.categoryId),
        scopeKeys: scopes(entry.scopeKeys),
        field:
          entry.field as RatingCategoryScopedPreparation['changes'][number]['field'],
        before,
        after,
        beforeStatus,
        afterStatus,
      });
    }),
    expiresAt: time(v.expiresAt),
  });
}
export function decodeRatingCategoryScopedPrepared(
  v: unknown,
): RatingCategoryScopedPrepared {
  return isRecord(v) && 'outcome' in v
    ? decodeRatingCategoryScopedReceipt(v)
    : decodeRatingCategoryScopedPreparation(v);
}
export function matchRatingCategoryScopedReceipt(
  intent: RatingCategoryScopedIntent,
  receipt: RatingCategoryScopedReceipt,
): void {
  if (
    receipt.requestId !== intent.payload.clientRequestId ||
    receipt.operation !== intent.operation ||
    receipt.intentHash !== ratingCategoryScopedIntentHash(intent)
  )
    invalidRating();
}
export function matchRatingCategoryScopedPreparation(
  intent: RatingCategoryScopedIntent,
  prepared: RatingCategoryScopedPreparation,
): void {
  if (prepared.requestId !== intent.payload.clientRequestId) invalidRating();
}
export function decodeRatingCategoryScopedHistory(
  v: unknown,
): RatingCategoryScopedHistory {
  exact(v, ['items', 'nextCursor']);
  const items = array(v.items, 100, (entry) => {
    exact(entry, [
      'requestId',
      'operation',
      'outcome',
      'releaseId',
      'occurredAt',
    ]);
    if (
      entry.outcome !== 'applied' &&
      entry.outcome !== 'noop' &&
      entry.outcome !== 'closed'
    )
      invalidRating();
    return Object.freeze({
      requestId: id(entry.requestId),
      operation: operation(entry.operation),
      outcome: entry.outcome,
      releaseId: nullableId(entry.releaseId),
      occurredAt: time(entry.occurredAt),
    });
  });
  unique(items.map((item) => item.requestId));
  return Object.freeze({ items, nextCursor: nullableId(v.nextCursor) });
}
