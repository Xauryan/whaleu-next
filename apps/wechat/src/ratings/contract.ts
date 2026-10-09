import { ClientError, isRecord } from '../api/errors';
import { activityTimestamp } from '../activities/contract';
import { exact } from '../community/contract';
import { isUuid } from '../profile/contract';
export const ratingId = (value: unknown): value is string => isUuid(value);
export const ratingCursor = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function invalidRating(): never {
  throw new ClientError('protocol', 'Invalid rating data');
}
const nullableId = (value: unknown): value is string | null =>
  value === null || ratingId(value);
const integer = (value: unknown, max = 2147483647): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;
const score = (value: unknown): value is number =>
  integer(value, 5) && value >= 1;
const timestamp = (value: unknown): value is string =>
  activityTimestamp(value) && /Z$/.test(value);
export function canonicalRatingText(
  value: unknown,
  maximum = 500,
  required = true,
): string {
  if (typeof value !== 'string' || value.length > maximum * 2 + 100)
    invalidRating();
  const text = value.replace(/\r\n/g, '\n').trim();
  if (
    (required && text.length === 0) ||
    [...text].length > maximum ||
    [...text].some((c) => {
      const n = c.codePointAt(0)!;
      return !(
        n === 9 ||
        n === 10 ||
        (n >= 32 && !(n >= 127 && n <= 159) && !(n >= 0xd800 && n <= 0xdfff))
      );
    })
  )
    invalidRating();
  return text;
}
function outputText(value: unknown, maximum: number, required = true): string {
  const text = canonicalRatingText(value, maximum, required);
  if (text !== value) invalidRating();
  return text;
}
export type RatingAuthorMode = 'named' | 'anonymous';
export interface RatingRegion {
  readonly id: string;
  readonly label: string;
}
export interface RatingContext {
  readonly homeRegion: RatingRegion | null;
  readonly regions: readonly (RatingRegion & {
    readonly relation: 'home' | 'related' | 'managed';
  })[];
}
export function decodeRatingContext(value: unknown): RatingContext {
  exact(value, ['homeRegion', 'regions']);
  const region = (raw: unknown): RatingRegion => {
    exact(raw, ['id', 'label']);
    if (!ratingId(raw.id)) invalidRating();
    return Object.freeze({ id: raw.id, label: outputText(raw.label, 200) });
  };
  if (!Array.isArray(value.regions) || value.regions.length > 200)
    invalidRating();
  const regions = value.regions.map((raw: unknown) => {
    exact(raw, ['id', 'label', 'relation']);
    if (!['home', 'related', 'managed'].includes(String(raw.relation)))
      invalidRating();
    return Object.freeze({
      ...region({ id: raw.id, label: raw.label }),
      relation: raw.relation as 'home' | 'related' | 'managed',
    });
  });
  if (new Set(regions.map((item) => item.id)).size !== regions.length)
    invalidRating();
  return Object.freeze({
    homeRegion: value.homeRegion === null ? null : region(value.homeRegion),
    regions: Object.freeze(regions),
  });
}
export interface RatingCategory {
  readonly id: string;
  readonly parentId: string | null;
  readonly level: 1 | 2 | 3;
  readonly kind: string;
  readonly systemKey: string | null;
  readonly name: string;
  readonly description: string;
  readonly revision: string;
}
export function decodeRatingCategory(value: unknown): RatingCategory {
  exact(value, [
    'id',
    'parentId',
    'level',
    'kind',
    'systemKey',
    'name',
    'description',
    'revision',
  ]);
  if (
    !ratingId(value.id) ||
    !nullableId(value.parentId) ||
    !ratingId(value.revision) ||
    ![1, 2, 3].includes(Number(value.level)) ||
    typeof value.level !== 'number' ||
    (value.level === 1) !== (value.parentId === null) ||
    value.parentId === value.id ||
    typeof value.kind !== 'string' ||
    !/^[a-z][a-z0-9_]{0,49}$/.test(value.kind) ||
    !(
      value.systemKey === null ||
      (typeof value.systemKey === 'string' &&
        /^[a-z][a-z0-9_]{1,48}$/.test(value.systemKey))
    )
  )
    invalidRating();
  return Object.freeze({
    id: value.id,
    parentId: value.parentId,
    level: value.level as 1 | 2 | 3,
    kind: value.kind,
    systemKey: value.systemKey,
    name: outputText(value.name, 100),
    description: outputText(value.description, 500, false),
    revision: value.revision,
  });
}
export interface RatingTarget {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly description: string;
  readonly revision: string;
  readonly allowedActions: {
    readonly setScore: boolean;
    readonly createComment: boolean;
    readonly authorModes: readonly RatingAuthorMode[];
  };
}
export function decodeRatingTarget(value: unknown): RatingTarget {
  exact(value, [
    'id',
    'categoryId',
    'name',
    'description',
    'revision',
    'allowedActions',
  ]);
  exact(value.allowedActions, ['setScore', 'createComment', 'authorModes']);
  const actions = value.allowedActions;
  if (
    !ratingId(value.id) ||
    !ratingId(value.categoryId) ||
    !ratingId(value.revision) ||
    typeof actions.setScore !== 'boolean' ||
    typeof actions.createComment !== 'boolean' ||
    !Array.isArray(actions.authorModes) ||
    actions.authorModes.length < 1 ||
    actions.authorModes.length > 2 ||
    actions.authorModes[0] !== 'named' ||
    actions.authorModes.some(
      (mode: unknown) => mode !== 'named' && mode !== 'anonymous',
    ) ||
    new Set(actions.authorModes).size !== actions.authorModes.length
  )
    invalidRating();
  return Object.freeze({
    id: value.id,
    categoryId: value.categoryId,
    name: outputText(value.name, 100),
    description: outputText(value.description, 500, false),
    revision: value.revision,
    allowedActions: Object.freeze({
      setScore: actions.setScore,
      createComment: actions.createComment,
      authorModes: Object.freeze([
        ...actions.authorModes,
      ] as RatingAuthorMode[]),
    }),
  });
}
export interface RatingMyScore {
  readonly myScore: {
    readonly score: number;
    readonly revision: string;
  } | null;
}
export function decodeRatingMyScore(value: unknown): RatingMyScore {
  exact(value, ['myScore']);
  if (value.myScore === null) return Object.freeze({ myScore: null });
  exact(value.myScore, ['score', 'revision']);
  if (!score(value.myScore.score) || !ratingId(value.myScore.revision))
    invalidRating();
  return Object.freeze({
    myScore: Object.freeze({
      score: value.myScore.score,
      revision: value.myScore.revision,
    }),
  });
}
export type RatingSummary =
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'known';
      readonly count: number;
      readonly sum: number;
      readonly average: number | null;
      readonly distribution: Readonly<
        Record<'1' | '2' | '3' | '4' | '5', number>
      >;
      readonly revision: string;
    };
export function decodeRatingSummary(value: unknown): RatingSummary {
  if (!isRecord(value)) invalidRating();
  if (value.status === 'unavailable') {
    exact(value, ['status']);
    return Object.freeze({ status: 'unavailable' });
  }
  exact(value, [
    'status',
    'count',
    'sum',
    'average',
    'distribution',
    'revision',
  ]);
  exact(value.distribution, ['1', '2', '3', '4', '5']);
  if (
    value.status !== 'known' ||
    !integer(value.count) ||
    !integer(value.sum, 10737418235) ||
    !ratingId(value.revision) ||
    Object.values(value.distribution).some((n) => !integer(n))
  )
    invalidRating();
  const distribution = value.distribution as Record<
    '1' | '2' | '3' | '4' | '5',
    number
  >;
  if (
    value.count !== Object.values(distribution).reduce((a, b) => a + b, 0) ||
    value.sum !==
      Object.entries(distribution).reduce(
        (sum, [s, n]) => sum + Number(s) * n,
        0,
      ) ||
    (value.count === 0
      ? value.average !== null
      : value.average !== Math.round((value.sum * 10) / value.count) / 10)
  )
    invalidRating();
  return Object.freeze({
    status: 'known',
    count: value.count,
    sum: value.sum,
    average: value.average as number | null,
    distribution: Object.freeze({ ...distribution }),
    revision: value.revision,
  });
}
export type RatingAuthor =
  | {
      readonly mode: 'named';
      readonly profileId: string;
      readonly displayName: string;
    }
  | {
      readonly mode: 'anonymous';
      readonly targetId: string;
      readonly personaId: string;
      readonly displayName: string;
    };
export function decodeRatingAuthor(
  raw: unknown,
  targetId: string,
): RatingAuthor {
  if (!isRecord(raw) || !ratingId(targetId)) invalidRating();
  let author: RatingAuthor;
  if (raw.mode === 'named') {
    exact(raw, ['mode', 'profileId', 'displayName']);
    if (!ratingId(raw.profileId)) invalidRating();
    author = {
      mode: 'named',
      profileId: raw.profileId,
      displayName: outputText(raw.displayName, 100),
    };
  } else {
    exact(raw, ['mode', 'targetId', 'personaId', 'displayName']);
    if (
      raw.mode !== 'anonymous' ||
      !ratingId(raw.personaId) ||
      raw.targetId !== targetId
    )
      invalidRating();
    author = {
      mode: 'anonymous',
      targetId: targetId,
      personaId: raw.personaId,
      displayName: outputText(raw.displayName, 100),
    };
  }
  return Object.freeze(author);
}
export interface RatingComment {
  readonly id: string;
  readonly targetId: string;
  readonly body: string;
  readonly revision: string;
  readonly createdAt: string;
  readonly author: RatingAuthor;
  readonly isMine: boolean;
  readonly allowedActions: { readonly delete: boolean };
}
export function decodeRatingComment(value: unknown): RatingComment {
  exact(value, [
    'id',
    'targetId',
    'body',
    'revision',
    'createdAt',
    'author',
    'isMine',
    'allowedActions',
  ]);
  exact(value.allowedActions, ['delete']);
  if (
    !ratingId(value.id) ||
    !ratingId(value.targetId) ||
    !ratingId(value.revision) ||
    !timestamp(value.createdAt) ||
    typeof value.isMine !== 'boolean' ||
    typeof value.allowedActions.delete !== 'boolean' ||
    (value.allowedActions.delete && !value.isMine) ||
    !isRecord(value.author)
  )
    invalidRating();
  const author = decodeRatingAuthor(value.author, value.targetId);
  return Object.freeze({
    id: value.id,
    targetId: value.targetId,
    body: outputText(value.body, 500),
    revision: value.revision,
    createdAt: value.createdAt,
    author: Object.freeze(author),
    isMine: value.isMine,
    allowedActions: Object.freeze({ delete: value.allowedActions.delete }),
  });
}
interface PageContext {
  readonly regionId: string | null;
  readonly catalogRevision: string;
}
interface RatingPage<T, C extends PageContext> {
  readonly context: C;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly continuation: 'more' | 'scan' | 'end';
}
export type RatingCategoryPage = RatingPage<
  RatingCategory,
  PageContext & { readonly parentId: string | null }
>;
export type RatingTargetPage = RatingPage<
  RatingTarget,
  PageContext & { readonly categoryId: string }
>;
export type RatingCommentPage = RatingPage<
  RatingComment,
  PageContext & { readonly targetId: string }
>;
function decodePage<T extends { readonly id: string }>(
  value: unknown,
  key: string,
  decode: (raw: unknown) => T,
) {
  exact(value, ['context', 'items', 'nextCursor', 'continuation']);
  exact(value.context, ['regionId', 'catalogRevision', key]);
  if (
    !nullableId(value.context.regionId) ||
    !ratingId(value.context.catalogRevision) ||
    !(key === 'parentId'
      ? nullableId(value.context[key])
      : ratingId(value.context[key])) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextCursor === null || ratingCursor(value.nextCursor)) ||
    !['more', 'scan', 'end'].includes(String(value.continuation)) ||
    (value.nextCursor === null) !== (value.continuation === 'end')
  )
    invalidRating();
  const items = value.items.map(decode);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    invalidRating();
  return Object.freeze({
    context: Object.freeze({
      regionId: value.context.regionId,
      catalogRevision: value.context.catalogRevision,
      [key]: value.context[key],
    }),
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    continuation: value.continuation as 'more' | 'scan' | 'end',
  });
}
export function decodeRatingCategoryPage(value: unknown): RatingCategoryPage {
  const page = decodePage(
    value,
    'parentId',
    decodeRatingCategory,
  ) as unknown as RatingCategoryPage;
  if (page.items.some((item) => item.parentId !== page.context.parentId))
    invalidRating();
  return page;
}
export function decodeRatingTargetPage(value: unknown): RatingTargetPage {
  const page = decodePage(
    value,
    'categoryId',
    decodeRatingTarget,
  ) as unknown as RatingTargetPage;
  if (page.items.some((item) => item.categoryId !== page.context.categoryId))
    invalidRating();
  return page;
}
export function decodeRatingCommentPage(value: unknown): RatingCommentPage {
  const page = decodePage(
    value,
    'targetId',
    decodeRatingComment,
  ) as unknown as RatingCommentPage;
  if (page.items.some((item) => item.targetId !== page.context.targetId))
    invalidRating();
  return page;
}
export type RatingOperation = 'set_score' | 'create_comment' | 'delete_comment';
export const ratingRejections = [
  'RATING_NOT_FOUND',
  'RATING_REVISION_CONFLICT',
  'PHONE_VERIFICATION_REQUIRED',
  'AFFILIATION_VERIFICATION_REQUIRED',
  'IDENTITY_CAMPUS_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
  'CONTENT_REJECTED',
] as const;
export type RatingReceipt =
  | {
      readonly requestId: string;
      readonly operation: RatingOperation;
      readonly outcome: 'applied' | 'noop';
      readonly targetId: string;
      readonly subjectId: string;
      readonly revision: string;
      readonly occurredAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: RatingOperation;
      readonly outcome: 'rejected';
      readonly code: (typeof ratingRejections)[number];
    };
export function decodeRatingReceipt(value: unknown): RatingReceipt {
  if (!isRecord(value)) invalidRating();
  exact(
    value,
    value.outcome === 'rejected'
      ? ['requestId', 'operation', 'outcome', 'code']
      : [
          'requestId',
          'operation',
          'outcome',
          'targetId',
          'subjectId',
          'revision',
          'occurredAt',
        ],
  );
  if (
    !ratingId(value.requestId) ||
    !['set_score', 'create_comment', 'delete_comment'].includes(
      String(value.operation),
    )
  )
    invalidRating();
  const operation = value.operation as RatingOperation;
  if (value.outcome === 'rejected') {
    if (!(ratingRejections as readonly unknown[]).includes(value.code))
      invalidRating();
    return Object.freeze({
      requestId: value.requestId,
      operation,
      outcome: 'rejected',
      code: value.code as (typeof ratingRejections)[number],
    });
  }
  if (
    !['applied', 'noop'].includes(String(value.outcome)) ||
    !ratingId(value.targetId) ||
    !ratingId(value.subjectId) ||
    !ratingId(value.revision) ||
    !timestamp(value.occurredAt) ||
    (operation === 'set_score' && value.subjectId !== value.targetId) ||
    (operation === 'create_comment' && value.outcome === 'noop')
  )
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    operation,
    outcome: value.outcome as 'applied' | 'noop',
    targetId: value.targetId,
    subjectId: value.subjectId,
    revision: value.revision,
    occurredAt: value.occurredAt,
  });
}
interface RatingPayload {
  readonly clientRequestId: string;
  readonly regionId: string | null;
  readonly expectedTargetRevision: string;
}
export interface SetRatingScore extends RatingPayload {
  readonly expectedRevision: string | null;
  readonly score: number;
}
export interface CreateRatingComment extends RatingPayload {
  readonly authorMode: RatingAuthorMode;
  readonly body: string;
  readonly assetIds: readonly [];
}
export interface DeleteRatingComment extends RatingPayload {
  readonly targetId: string;
  readonly expectedRevision: string;
}
export type RatingIntent =
  | {
      readonly operation: 'set_score';
      readonly targetId: string;
      readonly payload: SetRatingScore;
    }
  | {
      readonly operation: 'create_comment';
      readonly targetId: string;
      readonly payload: CreateRatingComment;
    }
  | {
      readonly operation: 'delete_comment';
      readonly commentId: string;
      readonly payload: DeleteRatingComment;
    };
export function decodeRatingIntent(value: unknown): RatingIntent {
  if (!isRecord(value)) invalidRating();
  exact(
    value,
    value.operation === 'delete_comment'
      ? ['operation', 'commentId', 'payload']
      : ['operation', 'targetId', 'payload'],
  );
  const operation = value.operation;
  if (
    !['set_score', 'create_comment', 'delete_comment'].includes(
      String(operation),
    ) ||
    !ratingId(operation === 'delete_comment' ? value.commentId : value.targetId)
  )
    invalidRating();
  exact(value.payload, [
    'clientRequestId',
    'regionId',
    'expectedTargetRevision',
    ...(operation === 'set_score'
      ? ['expectedRevision', 'score']
      : operation === 'create_comment'
        ? ['authorMode', 'body', 'assetIds']
        : ['targetId', 'expectedRevision']),
  ]);
  const raw = value.payload;
  if (
    !ratingId(raw.clientRequestId) ||
    !nullableId(raw.regionId) ||
    !ratingId(raw.expectedTargetRevision)
  )
    invalidRating();
  const base = {
    clientRequestId: raw.clientRequestId,
    regionId: raw.regionId,
    expectedTargetRevision: raw.expectedTargetRevision,
  };
  if (operation === 'set_score') {
    if (!nullableId(raw.expectedRevision) || !score(raw.score)) invalidRating();
    return Object.freeze({
      operation,
      targetId: value.targetId as string,
      payload: Object.freeze({
        ...base,
        expectedRevision: raw.expectedRevision,
        score: raw.score,
      }),
    });
  }
  if (operation === 'create_comment') {
    if (
      !['named', 'anonymous'].includes(String(raw.authorMode)) ||
      !Array.isArray(raw.assetIds) ||
      raw.assetIds.length !== 0
    )
      invalidRating();
    return Object.freeze({
      operation,
      targetId: value.targetId as string,
      payload: Object.freeze({
        ...base,
        authorMode: raw.authorMode as RatingAuthorMode,
        body: canonicalRatingText(raw.body),
        assetIds: Object.freeze([]) as readonly [],
      }),
    });
  }
  if (!ratingId(raw.targetId) || !ratingId(raw.expectedRevision))
    invalidRating();
  return Object.freeze({
    operation: 'delete_comment',
    commentId: value.commentId as string,
    payload: Object.freeze({
      ...base,
      targetId: raw.targetId,
      expectedRevision: raw.expectedRevision,
    }),
  });
}
export function matchRatingReceipt(
  intent: RatingIntent,
  receipt: RatingReceipt,
): void {
  if (
    intent.payload.clientRequestId !== receipt.requestId ||
    intent.operation !== receipt.operation ||
    (receipt.outcome === 'noop' &&
      intent.operation === 'set_score' &&
      (intent.payload.expectedRevision === null ||
        receipt.revision !== intent.payload.expectedRevision)) ||
    (receipt.outcome !== 'rejected' &&
      (receipt.targetId !==
        (intent.operation === 'delete_comment'
          ? intent.payload.targetId
          : intent.targetId) ||
        (intent.operation === 'delete_comment' &&
          receipt.subjectId !== intent.commentId)))
  )
    invalidRating();
}
