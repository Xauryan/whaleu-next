import type { WhaleuApp } from '../../app';
import { clientConfiguration } from '../../config';
import { WechatStorage } from '../../platform/wechat';
import { HttpProfileGateway } from '../../profile/gateway';
import { HttpSchoolConfigurationGateway } from '../../school-configuration/gateway';
import { postingPolicyUuid } from '../../school-posting-policy/contract';
import {
  SchoolPostingPolicyController,
  initialSchoolPostingPolicyView,
} from '../../school-posting-policy/controller';
import { HttpSchoolPostingPolicyGateway } from '../../school-posting-policy/gateway';
import { PostingPolicyJournal } from '../../school-posting-policy/pending';
Page({
  data: { ...initialSchoolPostingPolicyView() },
  controller: undefined as SchoolPostingPolicyController | undefined,
  routeRegionId: null as string | null,
  invalidRoute: false,
  onLoad(options: { regionId?: string }) {
    if (options.regionId === undefined) return;
    try {
      this.routeRegionId = postingPolicyUuid(options.regionId);
    } catch {
      this.invalidRoute = true;
    }
  },
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    this.setData({ ...initialSchoolPostingPolicyView() });
    if (this.invalidRoute) {
      this.setData({ error: '学校管理入口无效，请从学校服务管理重新进入' });
      return;
    }
    const app = getApp<WhaleuApp>(),
      identity = app.identity;
    if (!identity?.api || !app.community) {
      this.setData({ error: '环境尚未初始化，请重新打开页面' });
      return;
    }
    this.controller = new SchoolPostingPolicyController(
      identity.sessions,
      new HttpSchoolPostingPolicyGateway(identity.api),
      new HttpSchoolConfigurationGateway(identity.api),
      new HttpProfileGateway(identity.api),
      new PostingPolicyJournal(
        new WechatStorage(wx),
        clientConfiguration.apiOrigin,
      ),
      app.community.newRequestId,
      (view) => this.setData({ ...view }),
    );
    void this.controller.load(this.routeRegionId);
  },
  onRefresh() {
    void this.controller?.refresh();
  },
  onCampusQuery(event: { detail: { value: string } }) {
    this.controller?.setCampusQuery(event.detail.value);
  },
  onSearchCampus() {
    void this.controller?.searchCampuses();
  },
  onChooseCampus(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.chooseCampus(event.currentTarget.dataset.id);
  },
  onSwitch(event: {
    currentTarget: { dataset: { field: string } };
    detail: { value: boolean };
  }) {
    this.controller?.setSwitch(
      event.currentTarget.dataset.field,
      event.detail.value,
    );
  },
  onCategories(event: { detail: { value: string[] } }) {
    this.controller?.setCategories(event.detail.value);
  },
  onExpiryKind(event: { detail: { value: string } }) {
    this.controller?.setExpiryKind(event.detail.value);
  },
  onValidUntil(event: { detail: { value: string } }) {
    this.controller?.setValidUntil(event.detail.value);
  },
  onSave() {
    void this.controller?.save();
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
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
  },
});
