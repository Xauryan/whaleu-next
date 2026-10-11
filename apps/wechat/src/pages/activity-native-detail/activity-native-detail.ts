import type { WhaleuApp } from '../../app';
import { Cancellation } from '../../platform/contracts';
import { HttpActivityPublicationGateway } from '../../activities/publication/gateway';
import {
  activityId,
  activitySlotLabels,
} from '../../activities/publication/contract';
import type { NativeActivity } from '../../activities/publication/contract';
import {
  activityMediaSlots,
  activityMediaSlot,
} from '../../activities/media-validation';
import type {
  ActivityMediaReader,
  ActivityMediaReadView,
} from '../../activities/media-runtime';
import type { OrganizationMediaReader } from '../../organizations/media-runtime';
Page({
  data: {
    activity: null as NativeActivity | null,
    loaded: false,
    busy: false,
    error: '',
    slots: [] as { slot: string; label: string }[],
    image: { status: 'idle', src: '', message: '' } as ActivityMediaReadView,
    qr: { status: 'idle', src: '', message: '' } as ActivityMediaReadView,
  },
  id: null as string | null,
  reader: undefined as ActivityMediaReader | undefined,
  qrReader: undefined as OrganizationMediaReader | undefined,
  cancel: undefined as Cancellation | undefined,
  generation: 0,
  stop: undefined as (() => void) | undefined,
  scopeStop: undefined as (() => void) | undefined,
  onLoad(query: Record<string, string> = {}) {
    try {
      if (Object.keys(query).some((k) => k !== 'id')) throw Error();
      this.id = activityId(query.id);
    } catch {
      this.id = null;
    }
  },
  async onShow() {
    this.clear();
    if (!this.id) {
      this.setData({ error: '活动详情入口无效' });
      return;
    }
    const app = getApp<WhaleuApp>(),
      identity = app.identity;
    if (!identity?.api) {
      this.setData({ error: '环境未配置' });
      return;
    }
    const ticket = identity.sessions.snapshot();
    this.stop = identity.sessions.subscribe(() => {
      if (identity.sessions.snapshot().epoch !== ticket.epoch) this.clear();
    });
    this.scopeStop = app.community?.directoryScopeChanges?.subscribe(() =>
      this.clear(),
    );
    this.reader = app.activityMedia?.createReader((image) =>
      this.setData({ image }),
    );
    this.qrReader = app.organizationMedia?.createReader((qr) =>
      this.setData({ qr }),
    );
    const generation = this.generation,
      cancel = new Cancellation();
    this.cancel = cancel;
    this.setData({ busy: true });
    try {
      const activity = await new HttpActivityPublicationGateway(
        identity.api,
      ).detail(this.id, cancel);
      if (generation !== this.generation || cancel.isCancelled) return;
      this.setData({
        activity,
        loaded: true,
        slots: activityMediaSlots
          .filter((slot) => !!activity.mediaBindings[slot])
          .map((slot) => ({ slot, label: activitySlotLabels[slot] })),
      });
      await this.reader?.load({
        activityId: activity.id,
        revision: activity.revision,
        slot: 'cover',
        audience: 'public',
      });
    } catch {
      if (generation === this.generation)
        this.setData({ error: '活动详情当前不可用' });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  onImage(e: { currentTarget: { dataset: { slot: string } } }) {
    const activity = this.data.activity,
      slot = activityMediaSlot(e.currentTarget.dataset.slot);
    if (activity && activity.mediaBindings[slot])
      void this.reader?.load({
        activityId: activity.id,
        revision: activity.revision,
        slot,
        audience: 'public',
      });
  },
  onQr() {
    const qr = this.data.activity?.organizerQr;
    if (qr?.status === 'available')
      void this.qrReader?.load({
        organizationId: qr.organizationId,
        applicationRevision: qr.applicationRevision,
        slot: 'mainQr',
        audience: 'public',
      });
  },
  clear() {
    this.generation++;
    this.stop?.();
    this.scopeStop?.();
    this.stop = undefined;
    this.scopeStop = undefined;
    this.cancel?.cancel();
    this.cancel = undefined;
    this.reader?.dispose();
    this.reader = undefined;
    this.qrReader?.dispose();
    this.qrReader = undefined;
    this.setData({
      activity: null,
      loaded: false,
      slots: [],
      busy: false,
      error: '',
      image: { status: 'idle', src: '', message: '' },
      qr: { status: 'idle', src: '', message: '' },
    });
  },
  onHide() {
    this.clear();
  },
  onUnload() {
    this.clear();
  },
});
