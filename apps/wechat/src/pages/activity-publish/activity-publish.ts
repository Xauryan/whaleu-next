import type { WhaleuApp } from '../../app';
import { clientConfiguration } from '../../config';
import { WechatStorage } from '../../platform/wechat';
import { HttpActivityPublicationGateway } from '../../activities/publication/gateway';
import { ActivityPublicationJournal } from '../../activities/publication/pending';
import {
  ActivityPublicationController,
  initialActivityPublicationView,
} from '../../activities/publication/controller';
import { activityId } from '../../activities/publication/contract';
import { activityMediaSlot } from '../../activities/media-validation';
import type {
  ActivityMediaUploader,
  ActivityMediaReader,
  ActivityMediaUploadView,
  ActivityMediaReadView,
  ActivityMediaUploadTarget,
} from '../../activities/media-runtime';
Page({
  data: {
    ...initialActivityPublicationView(),
    upload: {
      status: 'idle',
      message: '',
      progress: 0,
    } as ActivityMediaUploadView,
    image: { status: 'idle', src: '', message: '' } as ActivityMediaReadView,
    pendingImages: [] as ActivityMediaUploadTarget[],
  },
  controller: undefined as ActivityPublicationController | undefined,
  uploader: undefined as ActivityMediaUploader | undefined,
  reader: undefined as ActivityMediaReader | undefined,
  id: null as string | null,
  invalid: false,
  stop: undefined as (() => void) | undefined,
  stopScope: undefined as (() => void) | undefined,
  onLoad(query: Record<string, string> = {}) {
    try {
      if (Object.keys(query).some((k) => k !== 'id')) throw Error();
      this.id = query.id ? activityId(query.id) : null;
    } catch {
      this.invalid = true;
    }
  },
  onShow() {
    this.teardown();
    if (this.invalid) {
      this.setData({ error: '活动发布入口无效' });
      return;
    }
    const app = getApp<WhaleuApp>(),
      identity = app.identity;
    if (!identity?.api || !app.community) {
      this.setData({ error: '环境未配置' });
      return;
    }
    this.uploader = app.activityMedia?.createUploader((upload) =>
      this.setData({ upload }),
    );
    this.reader = app.activityMedia?.createReader((image) =>
      this.setData({ image }),
    );
    this.controller = new ActivityPublicationController(
      identity.sessions,
      new HttpActivityPublicationGateway(identity.api),
      new ActivityPublicationJournal(
        new WechatStorage(wx),
        clientConfiguration.apiOrigin,
      ),
      app.community.newRequestId,
      (view) => {
        this.id = view.id || null;
        this.setData({ ...view });
        this.refreshPendingImages();
      },
      (id) => app.activityMedia?.reconcile(id) ?? Promise.resolve(),
    );
    this.stop = app.community.privateViews?.subscribe(() => this.teardown());
    this.stopScope = app.community.directoryScopeChanges?.subscribe(() =>
      this.teardown(),
    );
    void this.controller.load(this.id);
  },
  refreshPendingImages() {
    try {
      this.setData({
        pendingImages: this.id
          ? (getApp<WhaleuApp>().activityMedia?.pendingTargets(this.id) ?? [])
          : [],
      });
    } catch {
      this.setData({ error: '原图片上传记录不可用，请保留原记录' });
    }
  },
  onOrganizer(e: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.chooseOrganizer(e.currentTarget.dataset.id);
  },
  onMoreOrganizers() {
    void this.controller?.moreOrganizers();
  },
  onField(e: {
    currentTarget: { dataset: { field: string } };
    detail: { value: string };
  }) {
    this.controller?.setField(e.currentTarget.dataset.field, e.detail.value);
  },
  onType(e: { currentTarget: { dataset: { type: string } } }) {
    this.controller?.toggleType(e.currentTarget.dataset.type);
  },
  onQr(e: { detail: { value: boolean } }) {
    this.controller?.setQr(e.detail.value);
  },
  onCreate() {
    void this.controller?.create();
  },
  onSave() {
    void this.controller?.save();
  },
  onDiscardDraft() {
    void this.controller?.discardDraft();
  },
  onPublish() {
    void this.controller?.publish();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.retry();
  },
  onCancelOriginal() {
    void this.controller?.cancelOriginal();
  },
  async onUpload(e: { currentTarget: { dataset: { slot: string } } }) {
    if (this.data.upload.status === 'working') return;
    const controller = this.controller,
      uploader = this.uploader;
    if (!controller || !uploader) return;
    const target = controller.uploadTarget(
      activityMediaSlot(e.currentTarget.dataset.slot),
    );
    if (!target) return;
    try {
      const asset = await uploader.pick(target);
      if (asset && this.controller === controller && this.uploader === uploader)
        controller.setMediaAsset(target, asset);
    } catch {
      if (this.controller === controller)
        this.setData({ error: '图片上传尚未确认，请恢复原图片请求' });
    }
    if (this.controller === controller) this.refreshPendingImages();
  },
  onRemove(e: { currentTarget: { dataset: { slot: string } } }) {
    this.controller?.removeMedia(
      activityMediaSlot(e.currentTarget.dataset.slot),
    );
    this.reader?.clear();
  },
  onPreview(e: { currentTarget: { dataset: { slot: string } } }) {
    const target = this.controller?.uploadTarget(
      activityMediaSlot(e.currentTarget.dataset.slot),
    );
    if (target) void this.reader?.load({ ...target, audience: 'management' });
  },
  async onPendingImage(e: {
    currentTarget: {
      dataset: { slot: string; revision: number | string; action: string };
    };
  }) {
    const { slot, revision, action } = e.currentTarget.dataset,
      target = this.data.pendingImages.find(
        (t) => t.slot === slot && t.revision === Number(revision),
      ),
      uploader = this.uploader,
      controller = this.controller;
    if (
      !target ||
      !uploader ||
      !controller ||
      this.data.busy ||
      this.data.pending ||
      this.data.upload.status === 'working'
    )
      return;
    try {
      if (action === 'cancel') await uploader.cancelPending(target);
      else {
        const asset = await uploader.recover(target);
        if (asset && controller === this.controller)
          controller.setMediaAsset(target, asset);
      }
    } catch {
      if (controller === this.controller)
        this.setData({ error: '原图片请求仍需恢复' });
    }
    if (controller === this.controller) this.refreshPendingImages();
  },
  onCatalog() {
    wx.navigateTo?.({
      success: () => undefined,
      fail: () => this.setData({ error: '无法打开活动页面，请重试' }),
      url: '/pages/activity-native/activity-native',
    });
  },
  onMine() {
    wx.navigateTo?.({
      success: () => undefined,
      fail: () => this.setData({ error: '无法打开活动页面，请重试' }),
      url: '/pages/activity-native/activity-native?mode=mine',
    });
  },
  onPublished() {
    if (this.data.draft?.state === 'published')
      wx.navigateTo?.({
        success: () => undefined,
        fail: () => this.setData({ error: '无法打开活动页面，请重试' }),
        url: `/pages/activity-native-detail/activity-native-detail?id=${this.data.id}`,
      });
  },
  teardown() {
    this.stop?.();
    this.stopScope?.();
    this.stop = undefined;
    this.stopScope = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.uploader?.dispose();
    this.uploader = undefined;
    this.reader?.dispose();
    this.reader = undefined;
    this.setData({
      ...initialActivityPublicationView(),
      upload: { status: 'idle', message: '', progress: 0 },
      image: { status: 'idle', src: '', message: '' },
      pendingImages: [],
    });
  },
  onHide() {
    this.teardown();
  },
  onUnload() {
    this.teardown();
  },
});
