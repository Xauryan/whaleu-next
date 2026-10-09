import {
  HttpRatingDeletionGateway,
  type RatingDeletionGateway,
} from '../ratings/deletion-gateway';
import {
  HttpRatingSubscriptionsGateway,
  type RatingSubscriptionsGateway,
} from '../ratings/subscription-gateway';
import {
  HttpRatingSubscriptionUpdatesGateway,
  type RatingSubscriptionUpdatesGateway,
} from '../ratings/subscription-updates-gateway';
import {
  HttpRatingLikesGateway,
  type RatingLikesGateway,
} from '../ratings/like-gateway';
import {
  HttpRatingLikeUpdatesGateway,
  type RatingLikeUpdatesGateway,
} from '../ratings/like-updates-gateway';
import {
  HttpRatingDiscussionGateway,
  type RatingDiscussionGateway,
} from '../ratings/discussion-gateway';
import {
  HttpRatingUpdatesGateway,
  type RatingUpdatesGateway,
} from '../ratings/updates-gateway';
import { HttpRatingsGateway, type RatingsGateway } from '../ratings/gateway';
import {
  HttpRatingRandomGateway,
  type RatingRandomGateway,
} from '../ratings/random-gateway';
import { PendingRatingStore } from '../ratings/pending';
import {
  HttpErrandAdminCommandsGateway,
  type ErrandAdminCommandsGateway,
} from '../errands/admin-command-gateway';
import { PendingErrandAdminStore } from '../errands/admin-pending';
import {
  HttpErrandAdminGateway,
  type ErrandAdminGateway,
} from '../errands/admin-gateway';
import {
  HttpErrandNoticesGateway,
  type ErrandNoticesGateway,
} from '../errands/notices';
import { HttpErrandsGateway, type ErrandsGateway } from '../errands/gateway';
import { PendingErrandStore } from '../errands/pending';
import {
  HttpActivitiesGateway,
  type ActivitiesGateway,
} from '../activities/gateway';
import { PendingActivityVisitStore } from '../activities/pending';
import {
  HttpAnnouncementsGateway,
  type AnnouncementsGateway,
} from '../announcements/gateway';
import {
  HttpDirectoryGateway,
  type DirectoryGateway,
} from '../directory/gateway';
import { HttpHotGateway, type HotGateway } from './hot-gateway';
import { ViewRuntime } from './view-runtime';
import { PendingViewStore } from './view-pending';
import { HttpViewGateway } from './view-gateway';
import { HttpSearchGateway, type SearchGateway } from './search-gateway';
import { PendingPostLikeStore } from './post-like-pending';
import {
  HttpDiscoveryGateway,
  type DiscoveryGateway,
} from '../profile/discovery-gateway';
import {
  HttpSystemNoticesGateway,
  type SystemNoticesGateway,
} from './system-notices-gateway';
import { HttpReportGateway, type ReportGateway } from './report-gateway';
import { PendingReportStore } from './report-pending';
import { SafetyChanges } from './safety-changes';
import { HttpBlockGateway, type BlockGateway } from './block-gateway';
import { PendingBlockStore } from './block-pending';
import { PendingSavedStore } from './saved-pending';
import { PendingFormationJoinStore } from './formation-pending';
import { PendingTradingStore } from './trading-pending';
import { PendingDiscussionStore } from './discussion-pending';
import {
  HttpIdentityPrivacyGateway,
  PrivateViewLifecycle,
  type IdentityPrivacyGateway,
} from '../identity-privacy/overlay';
import type { IdentityRuntime } from '../auth/runtime';
import type { SessionStore } from '../auth/session';
import { systemClock } from '../platform/clock';
import type { Clock } from '../platform/contracts';
import { bounded } from '../platform/deadline';
import { ClientError } from '../api/errors';
import { WechatStorage, type WxApi } from '../platform/wechat';
import { HttpProfileGateway, type ProfileGateway } from '../profile/gateway';
import { HttpCommunityGateway, type CommunityGateway } from './gateway';
import { DraftStore, PendingAttemptStore } from './pending-attempt';
import { PendingBallotStore } from './poll-pending';
export interface CommunityRuntime {
  readonly ratingRandom?: RatingRandomGateway;
  readonly ratingDeletion?: RatingDeletionGateway;
  readonly ratingSubscriptions?: RatingSubscriptionsGateway;
  readonly ratingSubscriptionUpdates?: RatingSubscriptionUpdatesGateway;
  readonly ratingLikes?: RatingLikesGateway;
  readonly ratingLikeUpdates?: RatingLikeUpdatesGateway;
  readonly ratingDiscussion?: RatingDiscussionGateway;
  readonly ratingUpdates?: RatingUpdatesGateway;
  readonly ratings?: RatingsGateway;
  readonly pendingRatings?: PendingRatingStore;
  readonly errandAdminCommands?: ErrandAdminCommandsGateway;
  readonly pendingErrandAdmin?: PendingErrandAdminStore;
  readonly errandAdmin?: ErrandAdminGateway;
  readonly errands?: ErrandsGateway;
  readonly errandNotices?: ErrandNoticesGateway;
  readonly pendingErrands?: PendingErrandStore;
  readonly activities?: ActivitiesGateway;
  readonly pendingActivityVisits?: PendingActivityVisitStore;
  readonly announcements?: AnnouncementsGateway;
  readonly browsingScopeChanges?: PrivateViewLifecycle;
  readonly hot?: HotGateway;
  readonly directory?: DirectoryGateway;
  readonly directoryScopeChanges?: PrivateViewLifecycle;
  readonly views?: ViewRuntime;
  readonly search?: SearchGateway;
  readonly discovery?: DiscoveryGateway;
  readonly sessions: SessionStore;
  readonly safetyChanges?: SafetyChanges;
  readonly systemNotices?: SystemNoticesGateway;
  readonly reports?: ReportGateway;
  readonly pendingReports?: PendingReportStore;
  readonly pendingJuryVotes?: PendingReportStore;
  readonly blocks?: BlockGateway;
  readonly pendingBlocks?: PendingBlockStore;
  readonly identityPrivacy?: IdentityPrivacyGateway;
  readonly privateViews?: PrivateViewLifecycle;
  readonly gateway: CommunityGateway | undefined;
  readonly profiles: ProfileGateway | undefined;
  readonly pending: PendingAttemptStore;
  readonly pendingFormations: PendingFormationJoinStore;
  readonly pendingBallots: PendingBallotStore;
  readonly pendingDiscussion: PendingDiscussionStore;
  readonly pendingTrading: PendingTradingStore;
  readonly pendingSaved: PendingSavedStore;
  readonly pendingPostLikes: PendingPostLikeStore;
  readonly drafts: DraftStore;
  readonly newRequestId: () => Promise<string>;
}
/** Typed root facade. Credentials never enter page data; privileged identity has a separate transient overlay. */
export function createCommunityRuntime(
  identity: IdentityRuntime,
  wx: WxApi,
  origin: string,
  clock: Clock = systemClock,
): CommunityRuntime {
  const storage = new WechatStorage(wx);
  const privateViews = new PrivateViewLifecycle();
  const browsingScopeChanges = new PrivateViewLifecycle();
  const runtime: CommunityRuntime = {
    sessions: identity.sessions,
    ...(identity.api ? { ratings: new HttpRatingsGateway(identity.api) } : {}),
    ...(identity.api
      ? { ratingRandom: new HttpRatingRandomGateway(identity.api) }
      : {}),
    ...(identity.api
      ? {
          ratingDeletion: new HttpRatingDeletionGateway(identity.api),
          ratingSubscriptions: new HttpRatingSubscriptionsGateway(identity.api),
          ratingSubscriptionUpdates: new HttpRatingSubscriptionUpdatesGateway(
            identity.api,
          ),
          ratingLikes: new HttpRatingLikesGateway(identity.api),
          ratingLikeUpdates: new HttpRatingLikeUpdatesGateway(identity.api),
          ratingDiscussion: new HttpRatingDiscussionGateway(identity.api),
          ratingUpdates: new HttpRatingUpdatesGateway(identity.api),
        }
      : {}),
    pendingRatings: new PendingRatingStore(storage, origin),
    ...(identity.api
      ? {
          errandAdminCommands: new HttpErrandAdminCommandsGateway(identity.api),
        }
      : {}),
    pendingErrandAdmin: new PendingErrandAdminStore(storage, origin),
    ...(identity.api
      ? { errandAdmin: new HttpErrandAdminGateway(identity.api) }
      : {}),
    ...(identity.api
      ? { errandNotices: new HttpErrandNoticesGateway(identity.api) }
      : {}),
    ...(identity.api ? { errands: new HttpErrandsGateway(identity.api) } : {}),
    pendingErrands: new PendingErrandStore(storage, origin),
    ...(identity.api
      ? { activities: new HttpActivitiesGateway(identity.api) }
      : {}),
    pendingActivityVisits: new PendingActivityVisitStore(storage, origin),
    browsingScopeChanges,
    ...(identity.api
      ? { announcements: new HttpAnnouncementsGateway(identity.api) }
      : {}),
    ...(identity.api ? { hot: new HttpHotGateway(identity.api) } : {}),
    directoryScopeChanges: new PrivateViewLifecycle(),
    ...(identity.api
      ? { directory: new HttpDirectoryGateway(identity.api) }
      : {}),
    ...(identity.api ? { search: new HttpSearchGateway(identity.api) } : {}),
    ...(identity.api
      ? { discovery: new HttpDiscoveryGateway(identity.api) }
      : {}),
    privateViews,
    safetyChanges: new SafetyChanges(privateViews),
    ...(identity.api
      ? { systemNotices: new HttpSystemNoticesGateway(identity.api) }
      : {}),
    pendingReports: new PendingReportStore(storage, origin, 'report'),
    pendingJuryVotes: new PendingReportStore(storage, origin, 'vote'),
    ...(identity.api ? { reports: new HttpReportGateway(identity.api) } : {}),
    pendingBlocks: new PendingBlockStore(storage, origin),
    ...(identity.api ? { blocks: new HttpBlockGateway(identity.api) } : {}),
    ...(identity.api
      ? { identityPrivacy: new HttpIdentityPrivacyGateway(identity.api) }
      : {}),
    gateway: identity.api ? new HttpCommunityGateway(identity.api) : undefined,
    profiles: identity.api
      ? new HttpProfileGateway(identity.api, (accountId) =>
          browsingScopeChanges.clear(accountId),
        )
      : undefined,
    pending: new PendingAttemptStore(storage, origin),
    pendingFormations: new PendingFormationJoinStore(storage, origin),
    pendingBallots: new PendingBallotStore(storage, origin),
    pendingDiscussion: new PendingDiscussionStore(storage, origin),
    pendingTrading: new PendingTradingStore(storage, origin),
    pendingSaved: new PendingSavedStore(storage, origin),
    pendingPostLikes: new PendingPostLikeStore(storage, origin),
    drafts: new DraftStore(storage, origin),
    newRequestId: () =>
      bounded(
        () =>
          new Promise<string>((resolve, reject) => {
            if (!wx.getRandomValues) {
              reject(
                new ClientError(
                  'configuration',
                  'Secure request IDs are unavailable',
                ),
              );
              return;
            }
            wx.getRandomValues({
              length: 16,
              success(result) {
                if (
                  !(result.randomValues instanceof ArrayBuffer) ||
                  result.randomValues.byteLength !== 16
                ) {
                  reject(new ClientError('protocol', 'Invalid random bytes'));
                  return;
                }
                const bytes = new Uint8Array(result.randomValues);
                bytes[6] = (bytes[6]! & 15) | 64;
                bytes[8] = (bytes[8]! & 63) | 128;
                const hex = Array.from(bytes, (b) =>
                  b.toString(16).padStart(2, '0'),
                ).join('');
                resolve(
                  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
                );
              },
              fail() {
                reject(
                  new ClientError(
                    'configuration',
                    'Secure request IDs are unavailable',
                  ),
                );
              },
            });
          }),
        5000,
        clock,
      ),
  };
  return {
    ...runtime,
    ...(identity.api
      ? {
          views: new ViewRuntime(
            identity.sessions,
            new HttpViewGateway(identity.api),
            new PendingViewStore(storage, origin, clock.now()),
            runtime.newRequestId,
            clock,
          ),
        }
      : {}),
  };
}
