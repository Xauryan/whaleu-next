import type { WhaleuApp } from '../../app';
import { clientConfiguration } from '../../config';
import { WechatStorage } from '../../platform/wechat';
import { HttpDirectoryGateway } from '../../directory/gateway';
import { HttpOrganizationGateway } from '../../organizations/gateway';
import { OrganizationCommandJournal } from '../../organizations/pending';
import {
  OrganizationEditorController,
  initialOrganizationEditorView,
} from '../../organizations/controller';
import {
  organizationUuid,
  organizationSlotLabels,
} from '../../organizations/contract';
import type {
  OrganizationKind,
  OrganizationPlatform,
} from '../../organizations/contract';
import { organizationMediaSlot } from '../../organizations/media-validation';
import type {
  OrganizationMediaUploader,
  OrganizationMediaReader,
  OrganizationMediaUploadView,
  OrganizationMediaReadView,
  OrganizationMediaUploadTarget,
} from '../../organizations/media-runtime';
Page({
  data: {
    ...initialOrganizationEditorView(),
    pendingImages: [] as readonly (OrganizationMediaUploadTarget & {
      key: string;
      label: string;
    })[],
    upload: {
      status: 'idle',
      message: '',
      progress: 0,
    } as OrganizationMediaUploadView,
    image: {
      status: 'idle',
      src: '',
      message: '',
    } as OrganizationMediaReadView,
  },
  controller: undefined as OrganizationEditorController | undefined,
  uploader: undefined as OrganizationMediaUploader | undefined,
  reader: undefined as OrganizationMediaReader | undefined,
  organizationId: null as string | null,
  pageAccountId: null as string | null,
  region: null as string | null,
  publicMode: false,
  invalidRoute: false,
  unsubscribePrivate: undefined as (() => void) | undefined,
  unsubscribeScope: undefined as (() => void) | undefined,
  onLoad(query: Record<string, string> = {}) {
    try {
      if (
        Object.keys(query).some((k) => !['id', 'regionId', 'mode'].includes(k))
      )
        throw new Error('route');
      this.organizationId = query.id ? organizationUuid(query.id) : null;
      this.region = query.regionId ? organizationUuid(query.regionId) : null;
      this.publicMode = query.mode === 'public';
      if (
        (query.mode !== undefined &&
          query.mode !== 'public' &&
          query.mode !== 'management') ||
        (this.publicMode && (!this.organizationId || !this.region))
      )
        throw new Error('route');
    } catch {
      this.invalidRoute = true;
    }
  },
  onShow() {
    this.teardown();
    this.setData({ ...initialOrganizationEditorView() });
    if (this.invalidRoute) {
      this.setData({ error: '组织入口无效' });
      return;
    }
    const app = getApp<WhaleuApp>(),
      identity = app.identity;
    if (!identity?.api || !app.community) {
      this.setData({ error: '环境尚未配置' });
      return;
    }
    this.pageAccountId =
      identity.sessions.snapshot().credentials?.accountId ?? null;
    this.uploader = app.organizationMedia?.createUploader((upload) =>
      this.setData({ upload }),
    );
    this.reader = app.organizationMedia?.createReader((image) =>
      this.setData({ image }),
    );
    this.controller = new OrganizationEditorController(
      identity.sessions,
      new HttpOrganizationGateway(identity.api),
      new HttpDirectoryGateway(identity.api),
      new OrganizationCommandJournal(
        new WechatStorage(wx),
        clientConfiguration.apiOrigin,
      ),
      app.community.newRequestId,
      (view) => {
        if (view.id) this.organizationId = view.id;
        if (view.regionId) this.region = view.regionId;
        this.reader?.clear();
        this.setData({ ...view });
        this.refreshPendingImages();
      },
      (id) => app.organizationMedia?.reconcile(id) ?? Promise.resolve(),
    );
    this.unsubscribePrivate = app.community.privateViews?.subscribe(() =>
      this.teardown(),
    );
    this.unsubscribeScope = app.community.directoryScopeChanges?.subscribe(() =>
      this.teardown(),
    );
    this.refreshPendingImages();
    void this.controller.load(
      this.organizationId,
      this.publicMode,
      this.region,
    );
  },
  teardown() {
    this.pageAccountId = null;
    this.unsubscribePrivate?.();
    this.unsubscribeScope?.();
    this.unsubscribePrivate = undefined;
    this.unsubscribeScope = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.uploader?.dispose();
    this.uploader = undefined;
    this.reader?.dispose();
    this.reader = undefined;
    this.setData({
      ...initialOrganizationEditorView(),
      upload: { status: 'idle', message: '', progress: 0 },
      image: { status: 'idle', src: '', message: '' },
      pendingImages: [],
    });
  },
  refreshPendingImages() {
    if (
      this.publicMode ||
      !this.organizationId ||
      !this.pageAccountId ||
      getApp<WhaleuApp>().identity?.sessions.snapshot().credentials
        ?.accountId !== this.pageAccountId
    ) {
      this.setData({ pendingImages: [] });
      return;
    }
    try {
      this.setData({
        pendingImages: (
          getApp<WhaleuApp>().organizationMedia?.pendingTargets(
            this.organizationId,
          ) ?? []
        ).map((target) => ({
          ...target,
          key: `${target.slot}:${target.applicationRevision}`,
          label: organizationSlotLabels[target.slot],
        })),
      });
    } catch {
      this.setData({
        error: '原图片上传记录不可用，请保留原记录',
        pendingImages: [],
      });
    }
  },
  async onPendingImage(event: {
    currentTarget: {
      dataset: { slot: string; revision: number | string; action: string };
    };
  }) {
    if (
      this.data.busy ||
      this.data.pending ||
      this.data.upload.status === 'working'
    )
      return;
    const { slot, revision, action } = event.currentTarget.dataset;
    const target = this.data.pendingImages.find(
      (t) =>
        t.organizationId === this.organizationId &&
        t.slot === slot &&
        t.applicationRevision === Number(revision),
    );
    const controller = this.controller,
      uploader = this.uploader;
    if (
      !target ||
      !controller ||
      !uploader ||
      !['recover', 'cancel'].includes(action)
    )
      return;
    try {
      if (action === 'cancel') await uploader.cancelPending(target);
      else {
        const asset = await uploader.recover(target);
        if (
          asset &&
          this.controller === controller &&
          this.uploader === uploader
        )
          controller.setMediaAsset(target, asset);
      }
    } catch {
      if (this.controller === controller && this.uploader === uploader)
        this.setData({ error: '原图片操作尚未确认，请恢复原上传' });
    }
    if (this.controller === controller && this.uploader === uploader)
      this.refreshPendingImages();
  },
  onRefresh() {
    this.onShow();
  },
  onField(event: {
    currentTarget: { dataset: { field: string } };
    detail: { value: string };
  }) {
    this.controller?.setField(
      event.currentTarget.dataset.field,
      event.detail.value,
    );
  },
  onKind(event: { currentTarget: { dataset: { kind: OrganizationKind } } }) {
    void this.controller?.setKind(event.currentTarget.dataset.kind);
  },
  onPlatform(event: {
    currentTarget: { dataset: { platform: OrganizationPlatform } };
  }) {
    this.controller?.setPlatform(event.currentTarget.dataset.platform);
  },
  onCategory(event: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.chooseCategory(event.currentTarget.dataset.id);
  },
  onMoreCategories() {
    void this.controller?.moreCategories();
  },
  onSave() {
    void this.controller?.save();
  },
  onSubmit() {
    void this.controller?.save(true);
  },
  onReason(event: { detail: { value: string } }) {
    this.controller?.setReason(event.detail.value);
  },
  onApprove() {
    void this.controller?.review('approve');
  },
  onReject() {
    void this.controller?.review('reject');
  },
  onLookupInput(event: { detail: { value: string } }) {
    this.controller?.setLookup(event.detail.value);
  },
  onLookup() {
    void this.controller?.lookup();
  },
  onAddAdmin() {
    void this.controller?.member('add_admin');
  },
  onTransfer() {
    void this.controller?.member('transfer_owner');
  },
  onRemoveAdmin(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.member(
      'remove_admin',
      event.currentTarget.dataset.id,
    );
  },
  async onPickImage(event: { currentTarget: { dataset: { slot: string } } }) {
    const controller = this.controller,
      uploader = this.uploader,
      target = controller?.uploadTarget(
        organizationMediaSlot(event.currentTarget.dataset.slot),
      );
    if (!target || !uploader) return;
    const asset = await uploader.pick(target);
    if (asset && this.controller === controller && this.uploader === uploader)
      controller?.setMediaAsset(target, asset);
    if (this.controller === controller && this.uploader === uploader)
      this.refreshPendingImages();
  },
  async onRecoverImage(event: {
    currentTarget: { dataset: { slot: string } };
  }) {
    const controller = this.controller,
      uploader = this.uploader,
      target = controller?.uploadTarget(
        organizationMediaSlot(event.currentTarget.dataset.slot),
      );
    if (!target || !uploader) return;
    const asset = await uploader.recover(target);
    if (asset && this.controller === controller && this.uploader === uploader)
      controller?.setMediaAsset(target, asset);
    if (this.controller === controller && this.uploader === uploader)
      this.refreshPendingImages();
  },
  async onCancelImage(event: { currentTarget: { dataset: { slot: string } } }) {
    const controller = this.controller,
      uploader = this.uploader,
      slot = organizationMediaSlot(event.currentTarget.dataset.slot),
      target = controller?.uploadTarget(slot);
    if (!target || !uploader) return;
    try {
      await uploader.cancelPending(target);
      if (this.controller === controller && this.uploader === uploader)
        controller?.setMediaAction(slot, 'keep');
    } catch {
      if (this.controller === controller && this.uploader === uploader)
        this.setData({ error: '图片撤回尚未确认，请恢复原上传' });
    }
    if (this.controller === controller && this.uploader === uploader)
      this.refreshPendingImages();
  },
  onRemoveImage(event: { currentTarget: { dataset: { slot: string } } }) {
    this.controller?.setMediaAction(
      organizationMediaSlot(event.currentTarget.dataset.slot),
      'remove',
    );
  },
  onKeepImage(event: { currentTarget: { dataset: { slot: string } } }) {
    this.controller?.setMediaAction(
      organizationMediaSlot(event.currentTarget.dataset.slot),
      'keep',
    );
  },
  onPreviewImage(event: { currentTarget: { dataset: { slot: string } } }) {
    const target = this.controller?.previewTarget(
      organizationMediaSlot(event.currentTarget.dataset.slot),
    );
    if (target && this.reader) void this.reader.load(target);
  },
  onCloseImage() {
    this.reader?.clear();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onCancelPending() {
    void this.controller?.cancelPending();
  },
  onHide() {
    this.teardown();
  },
  onUnload() {
    this.teardown();
  },
});
