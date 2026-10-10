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
import {
  PublicProfileController,
  initialPublicProfileView,
} from './controller';
Page({
  data: {
    namedAvatar: initialNamedAvatarView(),
    avatarRead: initialAvatarReadView(),
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
    ...initialPublicProfileView(),
    block: initialBlockMutationView(),
    tradingCategories,
    tradingLabels,
  },
  namedAvatarController: undefined as NamedAvatarController | undefined,
  avatarReader: undefined as AvatarReadController | undefined,
  avatarTarget: '',
  controller: undefined as PublicProfileController | undefined,
  blockMutations: undefined as BlockMutationController | undefined,
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
    this.messagingEntry?.dispose();
    this.messagingEntry = new MessagingEntryNavigator(
      wx,
      getApp<WhaleuApp>().community,
      () => this.setData({ error: '暂不能打开私信，请重试' }),
    );
    this.controller?.dispose();
    this.blockMutations?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.blockPending = false;
    this.blockMutations = new BlockMutationController(runtime, (view) => {
      const wasPending = this.blockPending;
      this.blockPending = view.busy || view.frozen;
      this.setData({ block: view });
      if (this.blockPending && !wasPending) this.controller?.cancel();
      else if (wasPending && !this.blockPending && view.receiptStatus)
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
          this.namedAvatarController?.clear();
        } else if (this.avatarTarget !== view.profile.profileId) {
          this.avatarTarget = view.profile.profileId;
          void this.avatarReader?.load(view.profile.profileId);
        }
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
    this.messagingEntry?.dispose();
    this.messagingEntry = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
