import { outputText } from '../ratings/text-contract';
import { sha256 } from 'js-sha256';
import { exact, invalid, type PostIntent } from './contract';
import { isUuid as ratingId } from '../profile/contract';
import type { RatingNavigationSelector } from '../ratings/scoped-contract';
const literalAssistanceText = (v: unknown): v is string =>
  typeof v === 'string' &&
  !!v &&
  v === v.trim() &&
  // eslint-disable-next-line no-control-regex -- reject unsafe literal control characters
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(
    v,
  );
function decodeRatingNavigationSelector(v: unknown): RatingNavigationSelector {
  if (
    typeof v === 'object' &&
    v !== null &&
    'kind' in v &&
    v.kind === 'global'
  ) {
    exact(v, ['kind']);
    return { kind: 'global' };
  }
  exact(v, ['kind', 'campusId']);
  if (v.kind !== 'campus' || !ratingId(v.campusId)) invalid();
  return { kind: 'campus', campusId: v.campusId };
}
export interface RatingTargetLinkReference {
  readonly targetId: string;
  readonly selector: RatingNavigationSelector;
  readonly expectedTargetRevision: string;
  readonly expectedCategoryRevision: string;
  readonly expectedSourceRevision: string;
}
export interface RatingTargetLinkCapability extends RatingTargetLinkReference {
  readonly systemKey: 'course' | 'canteen';
}
export interface RatingTargetLinkComponent extends RatingTargetLinkReference {
  readonly kind: 'rating_target_link';
  readonly label: string;
}
export interface RatingTargetLinkCard {
  readonly kind: 'rating_target_link';
  readonly label: string;
  readonly target: {
    readonly id: string;
    readonly name: string;
    readonly locator: {
      readonly targetId: string;
      readonly selector: RatingNavigationSelector;
    };
  };
}
export interface RatingLinkHandoff {
  readonly actorId: string;
  readonly targetId: string;
  readonly selector: RatingNavigationSelector;
  readonly destinationCampusId: string;
}
export function ratingLinkLabel(v: unknown): v is string {
  return literalAssistanceText(v) && [...v].length <= 12;
}
function reference(v: Record<string, unknown>): RatingTargetLinkReference {
  for (const key of [
    'targetId',
    'expectedTargetRevision',
    'expectedCategoryRevision',
    'expectedSourceRevision',
  ])
    if (!ratingId(v[key])) invalid();
  return {
    targetId: v.targetId as string,
    selector: decodeRatingNavigationSelector(v.selector),
    expectedTargetRevision: v.expectedTargetRevision as string,
    expectedCategoryRevision: v.expectedCategoryRevision as string,
    expectedSourceRevision: v.expectedSourceRevision as string,
  };
}
export function decodeRatingTargetLinkCapability(
  v: unknown,
): RatingTargetLinkCapability {
  exact(v, [
    'systemKey',
    'targetId',
    'selector',
    'expectedTargetRevision',
    'expectedCategoryRevision',
    'expectedSourceRevision',
  ]);
  if (v.systemKey !== 'course' && v.systemKey !== 'canteen') invalid();
  return Object.freeze({ ...reference(v), systemKey: v.systemKey });
}
export function decodeRatingTargetLinkComponent(
  v: unknown,
): RatingTargetLinkComponent {
  exact(v, [
    'kind',
    'targetId',
    'label',
    'selector',
    'expectedTargetRevision',
    'expectedCategoryRevision',
    'expectedSourceRevision',
  ]);
  if (v.kind !== 'rating_target_link' || !ratingLinkLabel(v.label)) invalid();
  return Object.freeze({
    kind: 'rating_target_link',
    ...reference(v),
    label: v.label,
  });
}
export function ratingLinkFallback(name: string): string {
  if (name === '') return '去评分';
  const candidate = [...outputText(name, 100)].slice(0, 12).join('');
  return ratingLinkLabel(candidate) ? candidate : '去评分';
}
export function decodeRatingTargetLinkCard(v: unknown): RatingTargetLinkCard {
  exact(v, ['kind', 'label', 'target']);
  exact(v.target, ['id', 'name', 'locator']);
  exact(v.target.locator, ['targetId', 'selector']);
  if (
    v.kind !== 'rating_target_link' ||
    !ratingLinkLabel(v.label) ||
    !ratingId(v.target.id) ||
    v.target.locator.targetId !== v.target.id ||
    typeof v.target.name !== 'string'
  )
    invalid();
  return Object.freeze({
    kind: 'rating_target_link',
    label: v.label,
    target: {
      id: v.target.id,
      name: outputText(v.target.name, 100),
      locator: {
        targetId: v.target.id,
        selector: decodeRatingNavigationSelector(v.target.locator.selector),
      },
    },
  });
}
export function ratingLinkNavigationPath(card: RatingTargetLinkCard): string {
  const checked = decodeRatingTargetLinkCard(card),
    locator = checked.target.locator;
  return `/pages/rating-scoped/rating-scoped?mode=detail&scope=${locator.selector.kind}${locator.selector.kind === 'campus' ? `&campusId=${locator.selector.campusId}` : ''}&targetId=${locator.targetId}`;
}
/** Explicit v5 domain only. Historical post hash/absent-none bytes stay untouched. */
export function ratingLinkPublicationHash(body: PostIntent): string {
  if (body.component?.kind !== 'rating_target_link') invalid();
  const intent = {
    spaceId: body.spaceId,
    category: body.category,
    text: body.text,
    imageAssetIds: body.imageAssetIds,
    authorMode: body.authorMode,
    commentsPolicy: body.commentsPolicy,
    component: {
      kind: body.component.kind,
      targetId: body.component.targetId,
      label: body.component.label,
      selector: body.component.selector,
      expectedTargetRevision: body.component.expectedTargetRevision,
      expectedCategoryRevision: body.component.expectedCategoryRevision,
      expectedSourceRevision: body.component.expectedSourceRevision,
    },
  };
  return sha256(
    `whaleu-community-rating-target-link:v1\n${JSON.stringify({ operation: 'publish_post', intent })}`,
  );
}
