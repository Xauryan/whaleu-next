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
  readonly sessions: SessionStore;
  readonly safetyChanges?: SafetyChanges;
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
  return {
    sessions: identity.sessions,
    privateViews,
    safetyChanges: new SafetyChanges(privateViews),
    pendingBlocks: new PendingBlockStore(storage, origin),
    ...(identity.api ? { blocks: new HttpBlockGateway(identity.api) } : {}),
    ...(identity.api
      ? { identityPrivacy: new HttpIdentityPrivacyGateway(identity.api) }
      : {}),
    gateway: identity.api ? new HttpCommunityGateway(identity.api) : undefined,
    profiles: identity.api ? new HttpProfileGateway(identity.api) : undefined,
    pending: new PendingAttemptStore(storage, origin),
    pendingFormations: new PendingFormationJoinStore(storage, origin),
    pendingBallots: new PendingBallotStore(storage, origin),
    pendingDiscussion: new PendingDiscussionStore(storage, origin),
    pendingTrading: new PendingTradingStore(storage, origin),
    pendingSaved: new PendingSavedStore(storage, origin),
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
}
