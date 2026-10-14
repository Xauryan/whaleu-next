import { ClientError, clientError } from '../api/errors';
import type { SessionStore } from '../auth/session';
import { Cancellation, type Clock } from '../platform/contracts';
import type { Campus } from '../profile/contract';
import type { ProfileGateway } from '../profile/gateway';
import {
  canonicalToolLink,
  toolUuid,
  type ToolHub,
  type ToolDetail,
  type ToolEntry,
  type ToolMarker,
  type ToolProvenance,
  type ToolLinkPolicy,
} from './contract';
import type { ToolGateway } from './gateway';
import {
  disabledToolLocation,
  validPosition,
  type ToolLocationPort,
  type ToolPosition,
} from './location';
import { toolEntryPath, type ToolRoute } from './navigation';
import { ToolBrowseScope } from './scope';
export const toolStateLabels = {
  ready: '当前校园工具',
  known_empty: '当前已确认暂无校园工具',
  not_applicable: '这些工具不适用于当前校区',
  unknown: '当前校区的工具资料尚未确认',
  expired: '工具资料已过期，请等待更新',
  unavailable: '工具暂不可用，请稍后刷新',
};
export function toolFailure(error: unknown): string {
  const failure = clientError(error);
  return failure.kind === 'auth-expired' || failure.kind === 'auth-required'
    ? '登录状态已变化，请重新登录'
    : failure.kind === 'forbidden'
      ? '当前账号不可读取校园工具'
      : '校园工具暂不可用，请刷新当前资料';
}
export interface ToolHubView {
  busy: boolean;
  needsCampus: boolean;
  campusId: string;
  campusName: string;
  state: string;
  status: string;
  error: string;
  entries: ToolEntry[];
  provenance: ToolProvenance | null;
  choosing: boolean;
  campuses: readonly Campus[];
  searchQuery: string;
  campusPage: number;
  hasPrevious: boolean;
  hasNext: boolean;
}
export const initialToolHubView = (): ToolHubView => ({
  busy: false,
  needsCampus: false,
  campusId: '',
  campusName: '',
  state: '',
  status: '',
  error: '',
  entries: [],
  provenance: null,
  choosing: false,
  campuses: [],
  searchQuery: '',
  campusPage: 1,
  hasPrevious: false,
  hasNext: false,
});
export class ToolHubController {
  private view = initialToolHubView();
  private result: ToolHub | null = null;
  private generation = 0;
  private cancel = new Cancellation();
  private disposed = false;
  private stopExpiry = () => undefined as void;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: ToolGateway,
    private readonly profile: ProfileGateway,
    private readonly scope: ToolBrowseScope,
    private readonly clock: Clock,
    private readonly render: (view: ToolHubView) => void,
  ) {
    let ticket = sessions.snapshot();
    const stopSession = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== ticket.epoch ||
        now.credentials?.accountId !== ticket.credentials?.accountId
      ) {
        ticket = now;
        this.clear();
        this.update({ error: '账号已变化，请刷新校园工具' });
      }
    });
    const stopScope = scope.subscribe(() => {
      if (scope.snapshot().campusId !== this.view.campusId) this.clear();
    });
    this.unsubscribe = () => {
      stopSession();
      stopScope();
    };
  }
  private update(patch: Partial<ToolHubView>) {
    if (!this.disposed) {
      this.view = { ...this.view, ...patch };
      this.render(this.view);
    }
  }
  private clear() {
    this.generation++;
    this.cancel.cancel();
    this.cancel = new Cancellation();
    this.stopExpiry();
    this.stopExpiry = () => undefined;
    this.result = null;
    this.view = initialToolHubView();
    if (!this.disposed) this.render(this.view);
  }
  async load(explicit: string | null = null, campusName = '') {
    if (this.disposed) return;
    this.clear();
    let generation = this.generation;
    const ticket = this.sessions.snapshot();
    this.update({ busy: true, status: '正在读取校园工具' });
    try {
      let chosen = explicit ?? this.scope.snapshot().campusId;
      if (!chosen && ticket.credentials) {
        const profile = await this.profile.profile(this.cancel);
        this.sessions.assertCurrent(ticket);
        if (this.disposed || generation !== this.generation) return;
        chosen = profile.selectedCampus?.id ?? null;
        campusName = profile.selectedCampus?.fullName ?? '';
      }
      if (!chosen) {
        this.update({
          busy: false,
          needsCampus: true,
          status: '先选择浏览校区',
        });
        return;
      }
      chosen = toolUuid(chosen);
      this.scope.select(chosen);
      generation = this.generation;
      this.update({
        busy: true,
        campusId: chosen,
        campusName: campusName || chosen,
        status: '正在读取校园工具',
      });
      const result = await this.gateway.hub(chosen, this.cancel);
      this.sessions.assertCurrent(ticket);
      if (this.disposed || generation !== this.generation) return;
      this.result = result;
      this.update({
        busy: false,
        state: result.state,
        status: toolStateLabels[result.state],
        entries: result.state === 'ready' ? result.entries : [],
        provenance: 'provenance' in result ? result.provenance : null,
      });
      if ('provenance' in result)
        this.stopExpiry = this.clock.schedule(
          () => {
            this.clear();
            this.update({
              state: 'expired',
              status: '显示已关闭，请刷新当前校园资料',
            });
          },
          lifetime(result.provenance, this.clock),
        );
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.result = null;
        this.update({
          busy: false,
          entries: [],
          provenance: null,
          state: 'unavailable',
          error: toolFailure(error),
          status: '',
        });
      }
    }
  }
  refresh() {
    return this.load(this.scope.snapshot().campusId, this.view.campusName);
  }
  async search(query: string, page = 1) {
    if (this.disposed) return;
    this.clear();
    const generation = this.generation,
      ticket = this.sessions.snapshot();
    this.update({
      choosing: true,
      busy: true,
      searchQuery: query,
      campusPage: page,
    });
    try {
      const result = await this.profile.campuses(
        { q: query, district: '', page, pageSize: 20 },
        this.cancel,
      );
      this.sessions.assertCurrent(ticket);
      if (this.disposed || generation !== this.generation) return;
      this.update({
        busy: false,
        campuses: result.items,
        hasPrevious: result.page > 1,
        hasNext: result.page * result.pageSize < result.total,
      });
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        this.update({ busy: false, error: toolFailure(error) });
    }
  }
  choose(campusId: string) {
    const selected = this.view.campuses.find(
      (c) => c.id === campusId && c.isActive,
    );
    if (selected && !this.view.busy)
      return this.load(selected.id, selected.fullName);
    return Promise.resolve();
  }
  route(entryId: string): string | null {
    if (this.disposed || this.view.busy || this.result?.state !== 'ready')
      return null;
    const entry = this.result.entries.find((e) => e.id === entryId);
    return entry
      ? toolEntryPath(
          {
            campusId: this.result.campusId,
            catalogId: this.result.catalogId,
            entryId,
          },
          entry,
        )
      : null;
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.unsubscribe();
  }
}
function lifetime(provenance: ToolProvenance, clock: Clock): number {
  return provenance.validity.kind === 'finite'
    ? Math.max(
        0,
        Math.min(
          30000,
          Date.parse(provenance.validity.expiresAt) - clock.now(),
        ),
      )
    : 30000;
}
export interface ToolEmbedPort {
  /** Only a trusted deployment adapter may implement real platform attestation.
   * Synthetic test adapters establish no actual WeChat redirect enforcement. */
  authorize(
    url: string,
    policy: ToolLinkPolicy,
    cancel: Cancellation,
  ): Promise<boolean>;
}
export const disabledToolEmbed: ToolEmbedPort = {
  authorize: async () => false,
};
export interface ToolEntryView {
  busy: boolean;
  state: string;
  status: string;
  error: string;
  entry: ToolEntry | null;
  provenance: ToolProvenance | null;
  center: ToolPosition | null;
  zoom: number;
  markers: { id: number; latitude: number; longitude: number; title: string }[];
  marker: ToolMarker | null;
  located: boolean;
  locating: boolean;
  locateEnabled: boolean;
  expandedGroups: Record<string, boolean>;
  webviewSrc: string;
  webviewViewId: string;
  webviewLoaded: boolean;
  externalHost: string;
}
export const initialToolEntryView = (): ToolEntryView => ({
  busy: false,
  state: '',
  status: '',
  error: '',
  entry: null,
  provenance: null,
  center: null,
  zoom: 16,
  markers: [],
  marker: null,
  located: false,
  locating: false,
  locateEnabled: false,
  expandedGroups: {},
  webviewSrc: '',
  webviewViewId: '',
  webviewLoaded: false,
  externalHost: '',
});
let toolViewSequence = 0;
export class ToolEntryController {
  private readonly lifecycleId = ++toolViewSequence;
  private view = initialToolEntryView();
  private result: ToolDetail | null = null;
  private generation = 0;
  private cancel = new Cancellation();
  private disposed = false;
  private stopExpiry = () => undefined as void;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly route: ToolRoute,
    private readonly kind: ToolEntry['kind'],
    private readonly sessions: SessionStore,
    private readonly gateway: ToolGateway,
    private readonly scope: ToolBrowseScope,
    private readonly clock: Clock,
    private readonly clipboard: { set(value: string): Promise<void> },
    private readonly render: (view: ToolEntryView) => void,
    private readonly invalidateImages: () => void,
    private readonly location: ToolLocationPort = disabledToolLocation,
    private readonly embed: ToolEmbedPort = disabledToolEmbed,
  ) {
    let ticket = sessions.snapshot();
    const stopSession = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== ticket.epoch ||
        now.credentials?.accountId !== ticket.credentials?.accountId
      ) {
        ticket = now;
        this.clear();
        this.update({ error: '账号已变化，请重新打开校园工具' });
      }
    });
    const stopScope = scope.subscribe(() => {
      if (scope.snapshot().campusId !== route.campusId) {
        this.clear();
        this.update({ error: '浏览校区已变化，请返回校园工具' });
      }
    });
    this.unsubscribe = () => {
      stopSession();
      stopScope();
    };
  }
  private update(patch: Partial<ToolEntryView>) {
    if (!this.disposed) {
      this.view = { ...this.view, ...patch };
      this.render(this.view);
    }
  }
  private clear() {
    this.generation++;
    this.cancel.cancel();
    this.cancel = new Cancellation();
    this.stopExpiry();
    this.stopExpiry = () => undefined;
    this.invalidateImages();
    this.result = null;
    this.view = initialToolEntryView();
    if (!this.disposed) this.render(this.view);
  }
  private fence() {
    const generation = this.generation,
      ticket = this.sessions.snapshot(),
      scope = this.scope.snapshot().generation;
    return () => {
      this.sessions.assertCurrent(ticket);
      if (
        this.disposed ||
        generation !== this.generation ||
        this.cancel.isCancelled ||
        scope !== this.scope.snapshot().generation
      )
        throw new ClientError('cancelled', 'Campus tools view changed');
    };
  }
  async load() {
    if (this.disposed) return;
    this.clear();
    if (
      this.scope.snapshot().campusId &&
      this.scope.snapshot().campusId !== this.route.campusId
    ) {
      this.update({ error: '浏览校区已变化，请返回校园工具' });
      return;
    }
    this.scope.select(this.route.campusId);
    const generation = this.generation,
      current = this.fence();
    this.update({ busy: true, status: '正在读取当前工具' });
    try {
      const result = await this.gateway.detail(this.route, this.cancel);
      current();
      if (result.state !== 'ready') {
        this.update({
          busy: false,
          state: result.state,
          status: toolStateLabels[result.state],
        });
        return;
      }
      if (result.entry.kind !== this.kind)
        throw new ClientError('protocol', 'Tool kind mismatch');
      this.result = result;
      const entry = result.entry;
      this.update({
        busy: false,
        state: entry.state,
        entry,
        provenance: result.provenance,
        status:
          entry.state === 'enabled'
            ? '当前已确认的工具资料'
            : entry.state === 'disabled'
              ? '此工具已停用'
              : '此工具已撤回',
        ...(entry.state === 'enabled' && entry.kind === 'map'
          ? {
              center: entry.center,
              zoom: entry.zoom,
              markers: entry.markers.map((m) => ({
                id: m.id,
                title: m.title,
                ...m.position,
              })),
              locateEnabled: this.location.enabled,
            }
          : {}),
      });
      this.stopExpiry = this.clock.schedule(
        () => {
          this.clear();
          this.update({
            state: 'expired',
            status: '显示已关闭，请刷新当前工具资料',
          });
        },
        lifetime(result.provenance, this.clock),
      );
      if (entry.state === 'enabled' && entry.kind === 'web-link')
        await this.openWebview();
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.fail(error);
    }
  }
  private fail(error: unknown) {
    this.clear();
    this.update({ state: 'unavailable', error: toolFailure(error) });
  }
  private async fresh() {
    const previous = this.result,
      current = this.fence();
    if (previous?.state !== 'ready' || previous.entry.state !== 'enabled')
      throw new ClientError('cancelled', 'Tool unavailable');
    const fresh = await this.gateway.detail(this.route, this.cancel);
    current();
    if (
      fresh.state !== 'ready' ||
      fresh.digest !== previous.digest ||
      fresh.entry.revision !== previous.entry.revision ||
      fresh.entry.state !== 'enabled' ||
      fresh.entry.kind !== this.kind
    )
      throw new ClientError('business', 'Tool revision changed');
    return fresh;
  }
  marker(id: number) {
    const entry = this.result?.state === 'ready' ? this.result.entry : null;
    if (entry?.state === 'enabled' && entry.kind === 'map') {
      const marker = entry.markers.find((m) => m.id === id);
      if (marker) this.update({ marker });
    }
  }
  closeMarker() {
    this.update({ marker: null });
  }
  toggleGroup(id: string) {
    const entry = this.result?.state === 'ready' ? this.result.entry : null;
    if (
      entry?.state === 'enabled' &&
      entry.kind === 'shuttle' &&
      entry.groups.some((g) => g.id === id)
    ) {
      const expanded = !this.view.expandedGroups[id];
      // Collapsing a group conservatively closes any current preview. This also
      // fences an outstanding download before its local path can be rendered.
      if (!expanded) this.invalidateImages();
      this.update({
        expandedGroups: {
          ...this.view.expandedGroups,
          [id]: expanded,
        },
      });
    }
  }
  reset() {
    const entry = this.result?.state === 'ready' ? this.result.entry : null;
    if (entry?.state === 'enabled' && entry.kind === 'map') {
      this.generation++;
      this.cancel.cancel();
      this.cancel = new Cancellation();
      this.update({
        center: entry.center,
        zoom: entry.zoom,
        located: false,
        locating: false,
        status: '已回到当前校区默认位置',
      });
    }
  }
  async locate() {
    if (
      this.disposed ||
      this.view.busy ||
      this.view.locating ||
      !this.location.enabled ||
      this.kind !== 'map' ||
      this.result?.state !== 'ready'
    )
      return;
    const generation = this.generation,
      current = this.fence();
    this.update({ locating: true, status: '正在请求本次定位' });
    try {
      await this.fresh();
      current();
      const result = await this.location
        .locate(this.cancel)
        .catch(() => ({ state: 'unavailable' as const }));
      current();
      if (result.state === 'ready') {
        if (
          result.coordinateSystem !== 'gcj02' ||
          !validPosition(result.position)
        ) {
          this.update({
            located: false,
            locating: false,
            status: '定位暂不可用，仍可浏览地图',
          });
          return;
        }
        this.update({
          center: { ...result.position },
          located: true,
          locating: false,
          status: '位置仅在当前页面使用',
        });
      } else
        this.update({
          located: false,
          locating: false,
          status:
            result.state === 'denied'
              ? '未获得定位权限，仍可浏览地图；可自愿重试'
              : result.state === 'cancelled'
                ? '已取消定位，仍可浏览地图'
                : '定位暂不可用，仍可浏览地图',
        });
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.fail(error);
    }
  }
  async copy() {
    if (
      this.disposed ||
      this.view.busy ||
      this.result?.state !== 'ready' ||
      this.result.entry.state !== 'enabled' ||
      this.result.entry.kind !== 'research' ||
      !this.result.entry.link
    )
      return;
    const previous = this.result,
      generation = this.generation,
      current = this.fence();
    this.update({ busy: true, error: '', status: '正在核对当前外部链接' });
    try {
      const link = await this.gateway.link(this.route, 'copy', this.cancel);
      current();
      if (
        link.state !== 'ready' ||
        link.digest !== previous.digest ||
        link.entryRevision !== previous.entry.revision
      )
        throw new ClientError('business', 'Tool link changed');
      const url = canonicalToolLink(link.url, 'copy', link.policy);
      this.update({ externalHost: url.split('/')[2] ?? '' });
      current();
      await this.clipboard.set(url);
      current();
      this.update({ busy: false, status: '已复制外部链接' });
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        if (clientError(error).kind === 'network')
          this.update({ busy: false, status: '', error: '复制失败，请重试' });
        else this.fail(error);
      }
    }
  }
  private async openWebview() {
    const previous = this.result;
    if (
      previous?.state !== 'ready' ||
      previous.entry.state !== 'enabled' ||
      previous.entry.kind !== 'web-link'
    )
      return;
    if (previous.entry.link.state !== 'available') {
      this.update({
        state: 'webview_unconfigured',
        status: '此工具尚未配置可信的嵌入能力',
        webviewSrc: '',
      });
      return;
    }
    const current = this.fence();
    const link = await this.gateway.link(this.route, 'webview', this.cancel);
    current();
    if (
      link.state !== 'ready' ||
      link.digest !== previous.digest ||
      link.entryRevision !== previous.entry.revision
    )
      throw new ClientError('business', 'Tool link changed');
    const url = canonicalToolLink(link.url, 'webview', link.policy);
    const admitted = await this.embed.authorize(url, link.policy, this.cancel);
    current();
    if (!admitted) {
      this.update({
        state: 'webview_unconfigured',
        status: '此环境尚未配置可信的嵌入能力',
        webviewSrc: '',
      });
      return;
    }
    // Platform attestation may wait. Reauthorize the exact catalog action after
    // that wait instead of activating a URL obtained before source withdrawal.
    const finalLink = await this.gateway.link(
      this.route,
      'webview',
      this.cancel,
    );
    current();
    if (
      finalLink.state !== 'ready' ||
      finalLink.digest !== previous.digest ||
      finalLink.entryRevision !== previous.entry.revision ||
      finalLink.action !== 'webview' ||
      finalLink.url !== url ||
      finalLink.policy.id !== link.policy.id ||
      finalLink.policy.version !== link.policy.version ||
      JSON.stringify(finalLink.policy.rules) !==
        JSON.stringify(link.policy.rules)
    )
      throw new ClientError('business', 'Tool embed source changed');
    canonicalToolLink(finalLink.url, 'webview', finalLink.policy);
    this.update({
      webviewSrc: url,
      webviewViewId: `${this.lifecycleId}:${this.generation}`,
      externalHost: url.split('/')[2] ?? '',
      status: '正在打开已确认的外部工具',
    });
  }
  webviewLoaded(source: string, viewId: string) {
    if (
      source &&
      source === this.view.webviewSrc &&
      viewId === this.view.webviewViewId
    )
      this.update({ webviewLoaded: true, status: '' });
  }
  webviewFailed(source: string, viewId: string) {
    if (
      source &&
      source === this.view.webviewSrc &&
      viewId === this.view.webviewViewId
    ) {
      this.update({
        webviewSrc: '',
        webviewViewId: '',
        webviewLoaded: false,
        state: 'unavailable',
        status: '外部工具加载失败，请刷新或返回',
      });
    }
  }
  sourceUnavailable() {
    if (!this.disposed) {
      this.clear();
      this.update({
        state: 'unavailable',
        error: '当前工具资料已不可用，请刷新',
      });
    }
  }
  mediaContext() {
    return this.result?.state === 'ready' &&
      this.result.entry.state === 'enabled' &&
      !this.disposed
      ? {
          route: this.route,
          digest: this.result.digest,
          entry: this.result.entry,
        }
      : null;
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.unsubscribe();
  }
}
