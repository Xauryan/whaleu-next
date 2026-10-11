import type { WhaleuApp } from '../../app';
import { ClientError, clientError } from '../../api/errors';
import { Cancellation } from '../../platform/contracts';
import { HttpOrganizationGateway } from '../../organizations/gateway';
import {
  OrganizationListController,
  initialOrganizationListView,
} from '../../organizations/controller';
import {
  organizationRoleLabels,
  organizationStateLabels,
  organizationUuid,
} from '../../organizations/contract';
import { HttpProfileGateway } from '../../profile/gateway';
import type { Campus } from '../../profile/contract';
import { HttpSchoolConfigurationGateway } from '../../school-configuration/gateway';
Page({
  data: {
    ...initialOrganizationListView(),
    mode: 'mine' as 'mine' | 'review',
    management: 'none' as 'none' | 'fixed' | 'global',
    regionId: '',
    regionName: '',
    campusQuery: '',
    campuses: [] as readonly Campus[],
    selecting: false,
    organizationRoleLabels,
    organizationStateLabels,
  },
  controller: undefined as OrganizationListController | undefined,
  cancel: new Cancellation(),
  generation: 0,
  unsubscribe: undefined as (() => void) | undefined,
  unsubscribePrivate: undefined as (() => void) | undefined,
  onShow() {
    this.teardown();
    this.setData({
      ...initialOrganizationListView(),
      mode: 'mine',
      management: 'none',
      regionId: '',
      regionName: '',
      campuses: [],
      selecting: false,
    });
    const app = getApp<WhaleuApp>(),
      identity = app.identity;
    if (!identity?.api) {
      this.setData({ error: '环境尚未配置' });
      return;
    }
    const gateway = new HttpOrganizationGateway(identity.api);
    this.controller = new OrganizationListController(
      identity.sessions,
      gateway,
      (view) => this.setData({ ...view }),
    );
    let owner = identity.sessions.snapshot();
    this.unsubscribe = identity.sessions.subscribe(() => {
      const now = identity.sessions.snapshot();
      if (
        owner.epoch !== now.epoch ||
        owner.credentials?.accountId !== now.credentials?.accountId
      ) {
        owner = now;
        this.teardown();
        this.setData({
          ...initialOrganizationListView(),
          management: 'none',
          regionId: '',
          regionName: '',
          campuses: [],
        });
      }
    });
    this.unsubscribePrivate = app.community?.privateViews?.subscribe(() =>
      this.teardown(),
    );
    void this.controller.load('mine', null);
    const generation = this.generation,
      ticket = identity.sessions.snapshot();
    void gateway
      .capabilities(this.cancel)
      .then((c) => {
        identity.sessions.assertCurrent(ticket);
        if (generation !== this.generation) return;
        this.setData({
          management: c.management,
          regionId: c.region?.id ?? '',
          regionName: c.region?.name ?? '',
        });
      })
      .catch(() => undefined);
  },
  teardown() {
    this.generation++;
    this.cancel.cancel();
    this.cancel = new Cancellation();
    this.controller?.dispose();
    this.controller = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribePrivate?.();
    this.unsubscribePrivate = undefined;
    this.setData({
      ...initialOrganizationListView(),
      campuses: [],
      selecting: false,
    });
  },
  onMine() {
    this.setData({ mode: 'mine' });
    void this.controller?.load('mine', null);
  },
  onReviews() {
    this.setData({ mode: 'review' });
    this.controller?.clear();
    if (this.data.management === 'none') {
      this.setData({ error: '当前账号没有学校审核权限' });
      return;
    }
    if (this.data.management === 'global' && !this.data.regionId) {
      this.setData({ status: '请选择要审核的学校' });
      return;
    }
    void this.controller?.load('review', this.data.regionId || null);
  },
  onRefresh() {
    if (this.data.mode === 'mine') this.onMine();
    else this.onReviews();
  },
  onMore() {
    void this.controller?.next();
  },
  onCampusInput(event: { detail: { value: string } }) {
    if (this.data.selecting) return;
    this.setData({ campusQuery: event.detail.value, campuses: [] });
  },
  async onFindCampus() {
    const identity = getApp<WhaleuApp>().identity;
    if (
      !identity?.api ||
      this.data.management !== 'global' ||
      this.data.selecting
    )
      return;
    const generation = this.generation,
      ticket = identity.sessions.snapshot();
    this.setData({ selecting: true, error: '' });
    try {
      const page = await new HttpProfileGateway(identity.api).campuses(
        {
          q: this.data.campusQuery.trim(),
          district: '',
          page: 1,
          pageSize: 20,
        },
        this.cancel,
      );
      identity.sessions.assertCurrent(ticket);
      if (generation === this.generation)
        this.setData({ campuses: page.items });
    } catch (error) {
      if (generation === this.generation)
        this.setData({ error: clientError(error).message });
    } finally {
      if (generation === this.generation) this.setData({ selecting: false });
    }
  },
  async onChooseCampus(event: { currentTarget: { dataset: { id: string } } }) {
    const identity = getApp<WhaleuApp>().identity,
      id = event.currentTarget.dataset.id;
    if (
      !identity?.api ||
      this.data.management !== 'global' ||
      !this.data.campuses.some((c) => c.id === id)
    )
      return;
    const generation = this.generation,
      ticket = identity.sessions.snapshot();
    this.setData({ selecting: true, error: '' });
    try {
      const scope = await new HttpSchoolConfigurationGateway(
        identity.api,
      ).public(organizationUuid(id), this.cancel);
      identity.sessions.assertCurrent(ticket);
      if (generation !== this.generation) return;
      if (!scope.context.region)
        throw new ClientError('configuration', '学校尚未分配管理地区');
      this.setData({
        regionId: scope.context.region.id,
        regionName: scope.context.region.name,
        campuses: [],
      });
      void this.controller?.load('review', scope.context.region.id);
    } catch (error) {
      if (generation === this.generation)
        this.setData({ error: clientError(error).message });
    } finally {
      if (generation === this.generation) this.setData({ selecting: false });
    }
  },
  onHide() {
    this.teardown();
  },
  onUnload() {
    this.teardown();
  },
});
