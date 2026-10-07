import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { ApplicationErrorCode } from '../http/application-error.js';
import type {
  AuthorMode,
  Category,
  CommunitySpace,
  MediaView,
  PublicationOperation,
} from './contracts.js';

export type Decision<T = undefined> =
  | { kind: 'allow'; value: T }
  | { kind: 'deny'; reason: ApplicationErrorCode }
  | { kind: 'unavailable' };
export type Action =
  | 'publish_post'
  | 'publish_comment'
  | 'like'
  | 'delete'
  | 'vote'
  | 'pin'
  | 'resolve_trading'
  | 'join_formation'
  | 'read_formation_contacts'
  | 'save_post'
  | 'set_post_update_preference';
export interface Authority {
  phoneVerified: boolean;
  studentVerified: boolean;
  identityRegionId: string | null;
  crossRegionAllowed: boolean;
  unverifiedCategories: Category[];
  unverifiedCommentsAllowed: boolean;
  restrictedActions: Action[];
  canManage: boolean;
}
/** Implementations must read LOCAL authoritative state and lock it until commit.
 * No HTTP/provider/remote work is permitted in any transactional port. These are
 * dependency-injection boundaries, never client flags or environment allowlists. */
export interface CommunityAuthorizationPort {
  resolve(
    accountId: string,
    space: CommunitySpace,
    transaction: PoolClient,
  ): Promise<Decision<Authority>>;
}
export type VisibilityPurpose =
  'list_projection' | 'direct_post' | 'named_interaction';
export type VisibilitySubject = { contentId: string } & (
  | { authorMode: 'named'; namedAccountId: string }
  | { authorMode: 'anonymous'; namedAccountId?: never }
);
/** Anonymous subjects deliberately carry no underlying account or profile ID. */
export interface CommunityVisibilityPort {
  check(
    viewerAccountId: string | null,
    subject: VisibilitySubject,
    transaction: PoolClient,
    purpose: VisibilityPurpose,
  ): Promise<Decision>;
}
export interface ApprovedAsset {
  assetId: string;
  digest: string;
}
export interface ContentPublicationGate {
  check(
    input: {
      accountId: string;
      purpose: PublicationOperation;
      text: string;
      images: ApprovedAsset[];
      structuredContent?:
        | {
            version: 5;
            publicationIntentHash: string;
            component: import('./formation/contracts.js').FormationComponent;
          }
        | {
            version: 4;
            publicationIntentHash: string;
            trading: import('./trading/contracts.js').TradingInput;
          }
        | {
            version: 3;
            publicationIntentHash: string;
            postId: string;
            rootCommentId: string;
            targetReplyId: string | null;
            effectiveAuthorMode: AuthorMode;
          }
        | {
            version: 2;
            publicationIntentHash: string;
            component: import('./polls/contracts.js').PollComponent;
          };
    },
    transaction: PoolClient,
  ): Promise<Decision>;
}
export interface MediaAttachmentPort {
  resolveOwned(
    accountId: string,
    purpose: PublicationOperation,
    ids: string[],
    transaction: PoolClient,
  ): Promise<Decision<ApprovedAsset[]>>;
  display(
    assets: ApprovedAsset[],
    transaction: PoolClient,
  ): Promise<Decision<MediaView[]>>;
}
export const COMMUNITY_AUTHORIZATION = Symbol('COMMUNITY_AUTHORIZATION');
export const COMMUNITY_VISIBILITY = Symbol('COMMUNITY_VISIBILITY');
export const COMMUNITY_BASE_VISIBILITY = Symbol('COMMUNITY_BASE_VISIBILITY');
export const CONTENT_PUBLICATION_GATE = Symbol('CONTENT_PUBLICATION_GATE');
export const MEDIA_ATTACHMENT = Symbol('MEDIA_ATTACHMENT');
export class UnavailableAuthorization implements CommunityAuthorizationPort {
  async resolve(): Promise<Decision<Authority>> {
    return { kind: 'unavailable' };
  }
}
export class UnavailableVisibility implements CommunityVisibilityPort {
  async check(): Promise<Decision> {
    return { kind: 'unavailable' };
  }
}
export class UnavailableContentGate implements ContentPublicationGate {
  async check(): Promise<Decision> {
    return { kind: 'unavailable' };
  }
}
export class UnavailableMedia implements MediaAttachmentPort {
  async resolveOwned(): Promise<Decision<ApprovedAsset[]>> {
    return { kind: 'unavailable' };
  }
  async display(): Promise<Decision<MediaView[]>> {
    return { kind: 'unavailable' };
  }
}
export function requireDecision<T>(
  decision: Decision<T>,
  unavailable: ApplicationErrorCode = 'COMMUNITY_UNAVAILABLE',
): T {
  if (decision.kind === 'unavailable') throw new ApplicationError(unavailable);
  if (decision.kind === 'deny') throw new ApplicationError(decision.reason);
  return decision.value;
}
export function requireAction(authority: Authority, action: Action): void {
  if (!authority.phoneVerified)
    throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
  if (authority.restrictedActions.includes(action))
    throw new ApplicationError('COMMUNITY_ACTION_RESTRICTED');
}
export function requirePublication(
  authority: Authority,
  space: CommunitySpace,
  category: Category,
  mode: AuthorMode,
  action: 'publish_post' | 'publish_comment',
  postMode?: AuthorMode,
): void {
  requireAction(authority, action);
  if (action === 'publish_post' && category === 'trading' && mode !== 'named')
    throw new ApplicationError('AUTHOR_MODE_NOT_ALLOWED');
  if (space.kind === 'global' && category !== 'discussion')
    throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
  if (!authority.studentVerified) {
    if (
      space.kind !== 'regional' ||
      !(action === 'publish_comment'
        ? authority.unverifiedCommentsAllowed
        : authority.unverifiedCategories.includes(category))
    )
      throw new ApplicationError('STUDENT_VERIFICATION_REQUIRED');
    if (
      mode !== 'named' ||
      (action === 'publish_comment' && postMode !== 'named')
    )
      throw new ApplicationError('AUTHOR_MODE_NOT_ALLOWED');
    return;
  }
  if (!authority.identityRegionId)
    throw new ApplicationError('IDENTITY_CAMPUS_REQUIRED');
  if (
    space.kind === 'regional' &&
    authority.identityRegionId !== space.operatingRegionId
  ) {
    if (mode === 'anonymous')
      throw new ApplicationError('AUTHOR_MODE_NOT_ALLOWED');
    if (!authority.crossRegionAllowed)
      throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
  }
}
export function actionAllowed(
  authority: Authority | null,
  action: Action,
): boolean {
  return (
    !!authority &&
    authority.phoneVerified &&
    !authority.restrictedActions.includes(action)
  );
}
