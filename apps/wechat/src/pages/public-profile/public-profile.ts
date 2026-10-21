import {
  initialCoverReadView,
  type CoverReadController,
} from '../../profile/cover-read-controller';
import {
  NamedAvatarController,
  initialNamedAvatarView,
} from '../../profile/named-avatar';
import {
  initialAvatarReadView,
  type AvatarReadController,
} from '../../profile/avatar-read-controller';
import { MessagingEntryNavigator } from '../../messaging/entry';
import { PUBLIC_EXPERIENCE_COLOR_STYLES } from '../../experience/public-display';
import type { WhaleuApp } from '../../app';
import {
  BlockMutationController,
  initialBlockMutationView,
} from '../../community/block-controller';
import {
  tradingCategories,
  tradingLabels,
} from '../../community/trading-contract';
import { isUuid } from '../../profile/contract';
import { profileGenderLabels } from '../../profile/details-contract';
import { HttpProfileDetailsGateway } from '../../profile/details-gateway';
import {
  FollowController,
  initialFollowView,
} from '../../following/controller';
import {
  PublicProfileController,
  initialPublicProfileView,
} from './controller';
import {
  PublicDetailsController,
  initialPublicDetailsView,
} from './public-details-controller';
Page({
  data: {
    namedAvatar: initialNamedAvatarView(),
    avatarRead: initialAvatarReadView(),
    coverRead: initialCoverReadView(),
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
    ...initialPublicProfileView(),
    block: initialBlockMutationView(),
    follow: initialFollowView(),
    publicDetails: initialPublicDetailsView(),
    profileGenderLabels,
    showProfileDetails: false,
    tradingCategories,
    tradingLabels,
  },
  namedAvatarController: undefined as NamedAvatarController | undefined,
  avatarReader: undefined as AvatarReadController | undefined,
  coverReader: undefined as CoverReadController | undefined,
  avatarTarget: '',
  controller: undefined as PublicProfileController | undefined,
  blockMutations: undefined as BlockMutationController | undefined,
  followController: undefined as FollowController | undefined,
  publicDetailsController: undefined as PublicDetailsController | undefined,
  messagingEntry: undefined as MessagingEntryNavigator | undefined,
  profileId: null as string | null,
  blockPending: false,
  onLoad(query: { profileId?: string } = {}) {
    this.profileId =
      query.profileId === undefined
        ? null
        : isUuid(query.profileId)
          ? query.profileId
          : '';
  },
  onShow() {
    this.namedAvatarController?.dispose();
    this.namedAvatarController = new NamedAvatarController(
      getApp<WhaleuApp>().profileAvatar,
      (view) => this.setData({ namedAvatar: view }),
    );
    this.avatarReader?.dispose();
    this.avatarTarget = '';
    this.avatarReader = getApp<WhaleuApp>().profileAvatar?.createReader(
      (view) => this.setData({ avatarRead: view }),
    );
    this.coverReader?.dispose();
    this.coverReader = getApp<WhaleuApp>().profileCover?.createReader(
      (coverRead) => this.setData({ coverRead }),
    );
    this.messagingEntry?.dispose();
    this.messagingEntry = new MessagingEntryNavigator(
      wx,
      getApp<WhaleuApp>().community,
      () => this.setData({ error: '暂不能打开私信，请重试' }),
    );
    this.controller?.dispose();
    this.blockMutations?.dispose();
    this.followController?.dispose();
    this.publicDetailsController?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.followController = new FollowController(runtime, (follow) =>
      this.setData({ follow }),
    );
    const api = getApp<WhaleuApp>().identity?.api;
    this.publicDetailsController = new PublicDetailsController(
      runtime,
      api ? new HttpProfileDetailsGateway(api) : undefined,
      (publicDetails) => this.setData({ publicDetails }),
    );
    this.blockPending = false;
    this.blockMutations = new BlockMutationController(runtime, (view) => {
      const wasPending = this.blockPending;
      this.blockPending = view.busy || view.frozen;
      this.setData({ block: view });
      if (this.blockPending && !wasPending) {
        this.followController?.clear();
        this.publicDetailsController?.clear();
        this.controller?.cancel();
      } else if (wasPending && !this.blockPending && view.receiptStatus)
        void this.controller?.load();
    });
    if (runtime.sessions.snapshot().credentials) this.blockMutations.load();
    this.controller = new PublicProfileController(
      runtime,
      this.profileId,
      (view) => {
        this.setData({ ...view });
        if (
          view.busy ||
          !view.loaded ||
          view.profile?.status !== 'available' ||
          this.blockPending
        ) {
          this.avatarTarget = '';
          this.avatarReader?.clear();
          this.coverReader?.clear();
          this.namedAvatarController?.clear();
          this.followController?.clear();
          this.publicDetailsController?.clear();
        } else if (this.avatarTarget !== view.profile.profileId) {
          this.avatarTarget = view.profile.profileId;
          void this.avatarReader?.load(view.profile.profileId);
          void this.coverReader?.load(view.profile.profileId, true);
        }
        if (!view.busy && view.loaded && !this.blockPending)
          void this.followController?.setProfile(view.profile);
        if (!view.busy && view.loaded && !this.blockPending)
          void this.publicDetailsController?.setProfile(view.profile);
        if (this.blockPending && (view.busy || view.loaded))
          this.controller?.cancel();
        if (
          (view.busy || !view.loaded || view.profile?.status !== 'available') &&
          this.data.block.confirmSource
        )
          this.blockMutations?.dismissBlock();
      },
    );
    if (!this.blockPending) void this.controller.load();
  },
  onCoverError() {
    this.coverReader?.imageFailed();
  },
  onOpenAvatar() {
    void this.avatarReader?.open();
  },
  onCloseAvatar() {
    void this.avatarReader?.close();
  },
  onAvatarError() {
    this.avatarReader?.imageFailed();
  },
  onPostAvatar(event: { currentTarget: { dataset: { id: string } } }) {
    if (
      this.data.busy ||
      !this.data.loaded ||
      this.blockPending ||
      this.data.profile?.status !== 'available'
    )
      return;
    void this.namedAvatarController?.open(
      this.data.items.find((item) => item.id === event.currentTarget.dataset.id)
        ?.author,
    );
  },
  onNamedAvatarClose() {
    this.namedAvatarController?.clear();
  },
  onNamedAvatarError() {
    this.namedAvatarController?.imageFailed();
  },
  onPrivateMessage() {
    const profile = this.data.profile;
    if (
      this.data.loaded &&
      !this.data.busy &&
      !this.blockPending &&
      profile?.status === 'available' &&
      !profile.isOwn
    )
      this.messagingEntry?.open({
        entry: { kind: 'profile', profileId: profile.profileId },
        mode: 'named',
      });
  },
  onFollow() {
    if (
      this.data.loaded &&
      !this.data.busy &&
      !this.blockPending &&
      this.data.profile?.status === 'available' &&
      !this.data.profile.isOwn
    )
      void this.followController?.toggle();
  },
  onFollowReload() {
    if (this.data.loaded && !this.data.busy && !this.blockPending)
      void this.followController?.load();
  },
  onFollowRetry() {
    if (this.data.loaded && !this.data.busy && !this.blockPending)
      void this.followController?.retry();
  },
  onFollowCancel() {
    this.followController?.cancel();
  },
  onProfileDetails() {
    this.setData({ showProfileDetails: !this.data.showProfileDetails });
  },
  onTab(event: { currentTarget: { dataset: { key: string } } }) {
    if (this.blockPending) return;
    void this.controller?.setTab(event.currentTarget.dataset.key);
  },
  onTradingSubtype(event: { currentTarget: { dataset: { key: string } } }) {
    if (this.blockPending) return;
    void this.controller?.setTradingSubtype(event.currentTarget.dataset.key);
  },
  onReload() {
    if (this.blockPending) return;
    this.blockMutations?.dismissBlock();
    void this.controller?.load();
  },
  onPrevious() {
    if (this.blockPending) return;
    void this.controller?.previous();
  },
  onMore() {
    if (this.blockPending) return;
    void this.controller?.more();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onBlockProfile() {
    if (this.data.loaded && !this.data.busy && this.data.profile)
      this.blockMutations?.requestProfileBlock(this.data.profile);
  },
  onUnblockProfile() {
    if (this.data.loaded && !this.data.busy && this.data.profile)
      void this.blockMutations?.unblockProfile(this.data.profile);
  },
  onConfirmBlock() {
    const profile = this.data.profile;
    if (
      this.data.loaded &&
      !this.data.busy &&
      profile?.status === 'available' &&
      !profile.isOwn &&
      this.data.block.confirmSource?.kind === 'profile' &&
      this.data.block.confirmSource.id === profile.profileId
    )
      void this.blockMutations?.confirmBlock();
    else this.blockMutations?.dismissBlock();
  },
  onDismissBlock() {
    this.blockMutations?.dismissBlock();
  },
  onBlockReceipt() {
    void this.blockMutations?.recover();
  },
  onBlockRetry() {
    void this.blockMutations?.recover(true);
  },
  onBlockCancel() {
    this.blockMutations?.cancel();
  },
  onPageScroll() {
    this.namedAvatarController?.clear();
  },
  onHide() {
    this.namedAvatarController?.dispose();
    this.namedAvatarController = undefined;
    this.avatarTarget = '';
    this.avatarReader?.dispose();
    this.avatarReader = undefined;
    this.coverReader?.dispose();
    this.coverReader = undefined;
    this.messagingEntry?.dispose();
    this.messagingEntry = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
    this.followController?.dispose();
    this.followController = undefined;
    this.publicDetailsController?.dispose();
    this.publicDetailsController = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
