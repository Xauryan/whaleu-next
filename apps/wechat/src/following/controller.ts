import { ClientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  reasonMessage,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import type { PublicProfile } from '../profile/discovery-contract';
import type { PendingFollow } from './pending';

export interface FollowView extends CommunityView {
  readonly profileId: string;
  readonly following: boolean | null;
  readonly frozen: boolean;
  readonly recoveryProfileId: string;
  readonly recoveryFollowing: boolean | null;
  readonly receiptStatus: string;
}
export const initialFollowView = (): FollowView => ({
  ...initialCommunityView(),
  profileId: '',
  following: null,
  frozen: false,
  recoveryProfileId: '',
  recoveryFollowing: null,
  receiptStatus: '',
});

/** Only an available named public profile can become a follow target.
 * Unknown mutations are journaled before dispatch and retried explicitly with
 * the original actor, target, desired state and UUID, never on page entry. */
export class FollowController extends CommunityController<FollowView> {
  private target = '';
  private availableProfile = false;
  constructor(runtime: CommunityRuntime, render: (view: FollowView) => void) {
    super(runtime, initialFollowView, render);
  }
  protected override resetPrivate(): void {
    this.target = '';
    this.availableProfile = false;
  }
  clear(): void {
    this.stop();
    this.target = '';
    this.availableProfile = false;
    this.update({
      ...initialFollowView(),
      hasSession: !!this.accountId(),
      configured: !!this.runtime.following && !!this.runtime.pendingFollowing,
    });
  }
  async setProfile(profile: PublicProfile | null): Promise<void> {
    const availableProfile = profile?.status === 'available' && !profile.isOwn;
    const target =
      profile &&
      (profile.status !== 'available' || !profile.isOwn) &&
      isUuid(profile.profileId)
        ? profile.profileId
        : '';
    if (target === this.target && availableProfile === this.availableProfile)
      return;
    this.clear();
    this.target = target;
    this.availableProfile = availableProfile;
    this.update({ profileId: target });
    if (target) await this.load();
  }
  private ready(): boolean {
    if (!this.target || !this.available()) return false;
    if (!this.runtime.following || !this.runtime.pendingFollowing) {
      this.update({
        configured: false,
        status: '关注暂不可用',
        error: '当前环境尚未连接关注服务',
      });
      return false;
    }
    return true;
  }
  private showPending(pending: PendingFollow | null): void {
    this.update({
      frozen: !!pending,
      recoveryProfileId: pending?.profileId ?? '',
      recoveryFollowing: pending?.following ?? null,
      ...(pending
        ? {
            following: null,
            receiptStatus: '',
            status: '原关注操作仍待确认，请在原主页明确重试',
          }
        : {}),
    });
  }
  async load(): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    const profileId = this.target;
    const owner = this.runtime.sessions.snapshot();
    try {
      const pending = this.runtime.pendingFollowing!.load(this.accountId()!);
      this.runtime.sessions.assertCurrent(owner);
      this.showPending(pending);
      // A state GET is not an acknowledgement of an unresolved command.
      if (pending) return;
    } catch (error) {
      this.update({
        frozen: true,
        following: null,
        error: communityError(error),
      });
      return;
    }
    if (!this.availableProfile) {
      this.update({ following: null, status: '当前主页不可关注' });
      return;
    }
    this.update({ following: null, receiptStatus: '' });
    await this.run(
      (cancel) => {
        this.runtime.sessions.assertCurrent(owner);
        if (this.target !== profileId)
          throw new ClientError('cancelled', 'Follow target changed');
        return this.runtime.following!.status(profileId, cancel);
      },
      (state) => {
        if (state.profileId !== profileId)
          throw new ClientError('protocol', 'Follow target mismatch');
        this.update({
          following: state.following,
          status: state.following ? '已关注' : '关注后在首页查看公开动态',
        });
      },
    );
  }
  async toggle(): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      this.view.following === null ||
      !this.availableProfile ||
      !this.ready()
    )
      return;
    const accountId = this.accountId()!;
    const owner = this.runtime.sessions.snapshot();
    const profileId = this.target;
    const following = !this.view.following;
    try {
      const old = this.runtime.pendingFollowing!.load(accountId);
      this.runtime.sessions.assertCurrent(owner);
      if (old) {
        this.showPending(old);
        return;
      }
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return;
    }
    await this.run(
      async (cancel) => {
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled || this.target !== profileId)
          throw new ClientError('cancelled', 'Follow target changed');
        const pending = this.runtime.pendingFollowing!.freeze({
          version: 1,
          accountId,
          profileId,
          following,
          requestId,
        });
        this.showPending(pending);
        return this.dispatch(pending, cancel);
      },
      (state) => {
        if (state) this.showCurrent(state.profileId, state.following);
      },
      () =>
        this.update({
          following: null,
          status: this.view.frozen
            ? '关注操作结果尚未确认，请重试原操作'
            : '当前关注状态尚未确认，请重新核验',
        }),
    );
  }
  /** Explicit retry only, and only while viewing the original named profile. */
  async retry(): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    const owner = this.runtime.sessions.snapshot();
    try {
      const pending = this.runtime.pendingFollowing!.load(this.accountId()!);
      this.runtime.sessions.assertCurrent(owner);
      this.showPending(pending);
      if (!pending || pending.profileId !== this.target) return;
      await this.run(
        (cancel) => {
          this.runtime.sessions.assertCurrent(owner);
          return this.dispatch(pending, cancel);
        },
        (state) => {
          if (state) this.showCurrent(state.profileId, state.following);
        },
        () =>
          this.update({
            following: null,
            status: this.view.frozen
              ? '原关注操作仍待确认'
              : '原操作已确认，当前关注状态待核验',
          }),
      );
    } catch (error) {
      this.update({
        frozen: true,
        following: null,
        error: communityError(error),
      });
    }
  }
  private async dispatch(pending: PendingFollow, cancel: Cancellation) {
    const owner = this.runtime.sessions.snapshot();
    const assertOwned = () => {
      this.runtime.sessions.assertCurrent(owner);
      this.runtime.sessions.assertCurrent(this.owner);
      if (
        cancel.isCancelled ||
        pending.profileId !== this.target ||
        pending.accountId !== this.accountId()
      )
        throw new ClientError('cancelled', 'Follow ownership changed');
    };
    assertOwned();
    if (
      JSON.stringify(this.runtime.pendingFollowing!.load(pending.accountId)) !==
      JSON.stringify(pending)
    )
      throw new ClientError('storage', 'Original follow intent changed');
    assertOwned();
    const receipt = await this.runtime.following!.set(
      pending.profileId,
      pending.following,
      pending.requestId,
      cancel,
    );
    assertOwned();
    const settled = this.runtime.pendingFollowing!.settle(pending, receipt);
    assertOwned();
    this.showPending(null);
    assertOwned();
    if (settled.outcome === 'rejected') {
      this.update({
        following: null,
        receiptStatus:
          settled.code === 'FOLLOW_SELF_NOT_ALLOWED'
            ? '不能关注自己，原操作未执行'
            : settled.code === 'POST_NOT_FOUND'
              ? '此主页当前不可关注，原操作未执行'
              : reasonMessage(settled.code),
        status: '原关注操作未执行，已解除待确认状态',
        error: '',
      });
      return null;
    }
    // Receipts are historical. Never render their bit as the current state.
    assertOwned();
    return this.runtime.following!.status(pending.profileId, cancel);
  }
  private showCurrent(profileId: string, following: boolean): void {
    if (profileId !== this.target)
      throw new ClientError('protocol', 'Follow target mismatch');
    this.update({
      following,
      frozen: false,
      status: following ? '已关注，在首页关注页查看动态' : '当前未关注',
      error: '',
    });
  }
  override cancel(): void {
    this.stop();
    this.update({
      busy: false,
      following: null,
      status: this.view.frozen
        ? '已停止等待，原关注操作仍待确认'
        : '已停止加载',
    });
  }
}
