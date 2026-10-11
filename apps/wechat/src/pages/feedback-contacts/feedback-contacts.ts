import type { WhaleuApp } from '../../app';
import { ClientError } from '../../api/errors';
import { isUuid } from '../../profile/contract';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { CommunityRuntime } from '../../community/runtime';
import {
  TradingContactsController,
  initialTradingContactsView,
} from '../../community/trading-controller';
// Entry read and all contact reveal/copy requests share the existing session,
// root-hide and safety invalidation lifecycle. No value is persisted.
interface ContactEntryView extends CommunityView {
  readonly loaded: boolean;
}
const initialContactEntryView = (): ContactEntryView => ({
  ...initialCommunityView(),
  loaded: false,
});
class ContactEntry extends CommunityController<ContactEntryView> {
  constructor(
    runtime: CommunityRuntime,
    private readonly postId: string,
    private readonly contacts: TradingContactsController,
    render: (view: ContactEntryView) => void,
  ) {
    super(runtime, initialContactEntryView, render);
  }
  async load() {
    this.contacts.load(null);
    if (!this.available()) return;
    if (!this.runtime.gateway?.feedbackContacts) {
      this.update({ error: '反馈联系方式当前不可用' });
      return;
    }
    await this.run(
      (cancel) => this.runtime.gateway!.post(this.postId, cancel),
      (post) => {
        this.contacts.load(post);
        this.update({ loaded: true, status: '请主动查看发布者填写的联系方式' });
      },
    );
  }
  protected override onSafetyInvalidated(): void {
    this.contacts.load(null);
    void this.load();
  }
}
Page({
  data: {
    ...initialContactEntryView(),
    contacts: initialTradingContactsView(),
  },
  controller: undefined as ContactEntry | undefined,
  contactController: undefined as TradingContactsController | undefined,
  postId: '',
  onLoad(query: { postId?: string } = {}) {
    this.postId = isUuid(query.postId) ? query.postId : '';
  },
  onShow() {
    this.controller?.dispose();
    this.contactController?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime || !this.postId) {
      this.setData({ error: '反馈联系方式当前不可用' });
      return;
    }
    this.contactController = new TradingContactsController(
      runtime,
      (view) => this.setData({ contacts: view }),
      (text) =>
        new Promise<void>((resolve, reject) => {
          if (!wx.setClipboardData) {
            reject(new ClientError('configuration', 'Clipboard unavailable'));
            return;
          }
          wx.setClipboardData({
            data: text,
            success: resolve,
            fail: () =>
              reject(new ClientError('network', 'Clipboard copy failed')),
          });
        }),
      'feedback',
    );
    this.controller = new ContactEntry(
      runtime,
      this.postId,
      this.contactController,
      (view) => this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onReveal() {
    void this.contactController?.reveal();
  },
  onCopy(event: { currentTarget: { dataset: { field: string } } }) {
    void this.contactController?.copy(event.currentTarget.dataset.field);
  },
  onReload() {
    void this.controller?.load();
  },
  onHide() {
    this.controller?.dispose();
    this.contactController?.dispose();
    this.controller = undefined;
    this.contactController = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.contactController?.dispose();
    this.controller = undefined;
    this.contactController = undefined;
  },
});
