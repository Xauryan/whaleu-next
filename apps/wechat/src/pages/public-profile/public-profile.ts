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
    ...initialPublicProfileView(),
    block: initialBlockMutationView(),
    tradingCategories,
    tradingLabels,
  },
  controller: undefined as PublicProfileController | undefined,
  blockMutations: undefined as BlockMutationController | undefined,
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
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
