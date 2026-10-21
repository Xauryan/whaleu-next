import type { WhaleuApp } from '../../app';
import { clientConfiguration } from '../../config';
import { WechatStorage } from '../../platform/wechat';
import { AnnouncementManagementGateway } from '../../announcements/authoring/gateway';
import { AnnouncementPublicationJournal } from '../../announcements/authoring/pending';
import {
  AnnouncementAuthoringController,
  initialAuthoringView,
} from '../../announcements/authoring/controller';
import { id } from '../../announcements/authoring/contract';
import type { Slot, Command } from '../../announcements/authoring/contract';
import type {
  AnnouncementMediaUploader,
  AnnouncementMediaReader,
  AnnouncementMediaUploadTarget,
} from '../../media/announcement-runtime';
Page({
  data: {
    uiPanel: '',
    ...initialAuthoringView(),
    upload: { status: 'idle', message: '', progress: 0 },
    image: { status: 'idle', src: '', message: '' },
    pendingImages: [] as AnnouncementMediaUploadTarget[],
  },
  controller: undefined as AnnouncementAuthoringController | undefined,
  uploader: undefined as AnnouncementMediaUploader | undefined,
  reader: undefined as AnnouncementMediaReader | undefined,
  target: null as string | null,
  invalid: false,
  subscriptions: [] as (() => void)[],
  onLoad(query: Record<string, string> = {}) {
    try {
      if (Object.keys(query).some((k) => k !== 'id')) throw Error();
      this.target = query.id ? id(query.id) : null;
    } catch {
      this.invalid = true;
    }
  },
  onToggleUiPanel(event: { currentTarget: { dataset: { panel?: string } } }) {
    const panel = event.currentTarget.dataset.panel ?? '';
    this.setData({ uiPanel: this.data.uiPanel === panel ? '' : panel });
  },
  onShow() {
    this.setData({ uiPanel: '' });
    this.teardown();
    if (this.invalid) {
      this.setData({ error: '公告编辑入口无效' });
      return;
    }
    const app = getApp<WhaleuApp>();
    if (!app.identity?.api || !app.community) {
      this.setData({ error: '环境未配置' });
      return;
    }
    this.uploader = app.announcementMedia?.createUploader((upload) =>
      this.setData({ upload }),
    );
    this.reader = app.announcementMedia?.createReader((image) =>
      this.setData({ image }),
    );
    this.controller = new AnnouncementAuthoringController(
      app.identity.sessions,
      new AnnouncementManagementGateway(app.identity.api),
      new AnnouncementPublicationJournal(
        new WechatStorage(wx),
        clientConfiguration.apiOrigin,
      ),
      app.community.newRequestId,
      (v) => {
        if (v.id) this.target = v.id;
        else if (v.status === '上传草稿已取消') this.target = null;
        this.setData({
          ...v,
          ...(!v.loaded || v.management === 'none' ? { uiPanel: '' } : {}),
        });
        this.pendingImages();
      },
      (target) => app.announcementMedia?.reconcile(target) ?? Promise.resolve(),
    );
    this.subscriptions = [
      app.community.privateViews?.subscribe(() => this.teardown()),
      app.community.safetyChanges?.subscribe(() => this.teardown()),
    ].filter((s): s is () => void => !!s);
    void this.controller.load(this.target);
  },
  pendingImages() {
    try {
      this.setData({
        pendingImages:
          getApp<WhaleuApp>().announcementMedia?.pendingTargets() ?? [],
      });
    } catch {
      this.setData({ error: '原图片上传记录不可用，请保留记录' });
    }
  },
  onField(e: {
    currentTarget: { dataset: { field: string } };
    detail: { value: string | boolean };
  }) {
    this.controller?.setField(e.currentTarget.dataset.field, e.detail.value);
  },
  onSearch(e: { detail: { value: string } }) {
    this.controller?.search(e.detail.value);
  },
  onFindRegions() {
    void this.controller?.findRegions();
  },
  onRegion(e: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.chooseRegion(e.currentTarget.dataset.id);
  },
  onAll() {
    this.controller?.chooseAll();
  },
  onCommand(e: {
    currentTarget: {
      dataset: { action: Command['action']; enabled?: boolean | string };
    };
  }) {
    const controller = this.controller,
      action = e.currentTarget.dataset.action,
      enabled =
        e.currentTarget.dataset.enabled === true ||
        e.currentTarget.dataset.enabled === 'true';
    if (!controller || this.data.busy || this.data.pending) return;
    wx.showModal?.({
      title:
        action === 'cancel_draft'
          ? '取消上传草稿'
          : action === 'set_enabled'
            ? enabled
              ? '启用公告'
              : '停用公告'
            : '确认公告操作',
      content:
        action === 'create'
          ? '建立私有上传准备记录，尚不对外展示。'
          : action === 'publish' || action === 'update'
            ? `确认${action === 'publish' ? '发布' : '更新'}当前正文、图片及${this.data.management === 'fixed' ? this.data.regionName : this.data.audienceKind === 'all' ? '全体浏览者' : '所选地区全部校区'}范围？公告日期只作展示。`
            : '确认此操作？',
      success: (r) => {
        if (r.confirm && this.controller === controller)
          void controller.act(action, enabled);
      },
    });
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.retry();
  },
  onCancelOriginal() {
    const c = this.controller;
    wx.showModal?.({
      title: '取消原公告请求',
      content: '已生效的操作会保留并返回原回执。确认取消尚未生效的原请求？',
      success: (r) => {
        if (r.confirm && c === this.controller) void c?.cancelOriginal();
      },
    });
  },
  async onUpload(e: { currentTarget: { dataset: { slot: Slot } } }) {
    const c = this.controller,
      u = this.uploader;
    if (!c || !u || this.data.upload.status === 'working') return;
    const target = c.uploadTarget(e.currentTarget.dataset.slot);
    if (!target) return;
    try {
      const asset = await u.pick(target);
      if (asset && this.controller === c && this.uploader === u)
        c.setMediaAsset(target, asset);
    } catch {
      if (this.controller === c)
        this.setData({ error: '图片上传尚未确认，请恢复原图片请求' });
    }
    this.pendingImages();
  },
  onRemove(e: { currentTarget: { dataset: { slot: Slot } } }) {
    this.controller?.removeMedia(e.currentTarget.dataset.slot);
    this.reader?.clear();
  },
  onPreview(e: { currentTarget: { dataset: { slot: Slot } } }) {
    const target = this.controller?.uploadTarget(e.currentTarget.dataset.slot);
    if (target)
      void this.reader?.load({
        ...target,
        audience: 'management',
        campusId: null,
      });
  },
  async onPendingImage(e: {
    currentTarget: {
      dataset: {
        slot: Slot;
        revision: string | number;
        action: string;
        target: string;
      };
    };
  }) {
    const {
        slot,
        revision,
        action,
        target: announcementId,
      } = e.currentTarget.dataset,
      target = this.data.pendingImages.find(
        (t) =>
          t.announcementId === announcementId &&
          t.slot === slot &&
          t.revision === Number(revision),
      ),
      c = this.controller,
      u = this.uploader;
    if (!target || !c || !u || this.data.busy) return;
    try {
      if (action === 'cancel') await u.cancelPending(target);
      else {
        const asset = await u.recover(target);
        if (asset && this.controller === c) c.setMediaAsset(target, asset);
      }
    } catch {
      this.setData({ error: '原图片操作仍需恢复' });
    }
    this.pendingImages();
  },
  onRefresh() {
    this.onShow();
  },
  teardown() {
    this.setData({ uiPanel: '' });
    this.controller?.dispose();
    this.controller = undefined;
    this.uploader?.dispose();
    this.uploader = undefined;
    this.reader?.dispose();
    this.reader = undefined;
    for (const s of this.subscriptions) s();
    this.subscriptions = [];
    this.setData({
      ...initialAuthoringView(),
      upload: { status: 'idle', message: '', progress: 0 },
      image: { status: 'idle', src: '', message: '' },
      pendingImages: [],
    });
  },
  onHide() {
    this.setData({ uiPanel: '' });
    this.teardown();
  },
  onUnload() {
    this.setData({ uiPanel: '' });
    this.teardown();
  },
});
