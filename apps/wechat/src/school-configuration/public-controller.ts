import { clientError, ClientError } from '../api/errors';
import type { SessionStore } from '../auth/session';
import { Cancellation } from '../platform/contracts';
import type { ProfileGateway } from '../profile/gateway';
import type { SchoolConfigurationGateway } from './gateway';
import { schoolUuid, schoolLabels } from './contract';
import type { SchoolEntry, SchoolEntryKey, SchoolPublicView } from './contract';
export interface SchoolServicesView {
  busy: boolean;
  loaded: boolean;
  campusId: string;
  campusName: string;
  regionName: string;
  entries: readonly (SchoolEntry & { label: string })[];
  error: string;
  status: string;
  needsCampus: boolean;
}
export const initialSchoolServicesView = (): SchoolServicesView => ({
  busy: false,
  loaded: false,
  campusId: '',
  campusName: '',
  regionName: '',
  entries: [],
  error: '',
  status: '',
  needsCampus: false,
});
export interface SchoolClipboard {
  set(value: string): Promise<void>;
}
export class SchoolServicesController {
  private generation = 0;
  private cancel = new Cancellation();
  private disposed = false;
  private campusId: string | null = null;
  private result: SchoolPublicView | null = null;
  private readonly unsubscribe: () => void;
  private view = initialSchoolServicesView();
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: SchoolConfigurationGateway,
    private readonly profile: ProfileGateway | undefined,
    private readonly clipboard: SchoolClipboard,
    private readonly render: (view: SchoolServicesView) => void,
  ) {
    let ticket = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== ticket.epoch ||
        now.credentials?.accountId !== ticket.credentials?.accountId
      ) {
        ticket = now;
        this.clear();
        this.update({ error: '账号已变化，请重新读取当前学校服务' });
      }
    });
  }
  private update(patch: Partial<SchoolServicesView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.render(this.view);
  }
  private clear() {
    this.generation++;
    this.cancel.cancel();
    this.cancel = new Cancellation();
    this.result = null;
    this.campusId = null;
    this.view = initialSchoolServicesView();
    if (!this.disposed) this.render(this.view);
  }
  async load(campusId: string | null = null) {
    this.clear();
    const generation = this.generation,
      ticket = this.sessions.snapshot(),
      cancel = this.cancel;
    this.update({ busy: true, status: '正在读取学校服务' });
    try {
      const chosen =
        campusId !== null
          ? schoolUuid(campusId)
          : ticket.credentials && this.profile
            ? ((await this.profile.profile(cancel)).selectedCampus?.id ?? null)
            : null;
      this.sessions.assertCurrent(ticket);
      if (generation !== this.generation || this.disposed) return;
      if (chosen === null) {
        this.update({
          busy: false,
          needsCampus: true,
          status: '先选择一个浏览校区',
        });
        return;
      }
      this.campusId = chosen;
      const result = await this.gateway.public(chosen, cancel);
      this.sessions.assertCurrent(ticket);
      if (generation !== this.generation || this.disposed) return;
      this.show(result);
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      this.fail(error);
    }
  }
  private show(result: SchoolPublicView) {
    this.result = result;
    this.update({
      busy: false,
      loaded: true,
      campusId: result.context.campusId,
      campusName: result.context.campusName,
      regionName: result.context.region?.name ?? '',
      entries: result.entries.map((entry) => ({
        ...entry,
        label: schoolLabels[entry.entryKey],
      })),
      status: result.context.region
        ? '当前学校服务资料'
        : '当前校区尚未关联运营地区',
      error: '',
    });
  }
  async refresh() {
    await this.load(this.campusId);
  }
  async copy(
    key: SchoolEntryKey,
    field: 'wechatId' | 'qqGroupNumber' | 'joinUrl' | 'name',
  ) {
    if (this.disposed || this.view.busy || !this.result || !this.campusId)
      return;
    const previous = this.result.entries.find(
      (entry) => entry.entryKey === key,
    );
    if (!previous?.data || !previous.data.enabled) return;
    const generation = this.generation,
      campusId = this.campusId,
      ticket = this.sessions.snapshot();
    this.update({ busy: true, error: '' });
    try {
      const fresh = await this.gateway.public(campusId, this.cancel);
      this.sessions.assertCurrent(ticket);
      if (generation !== this.generation || this.disposed) return;
      const current = fresh.entries.find((entry) => entry.entryKey === key);
      this.show(fresh);
      if (
        !current?.data ||
        !current.data.enabled ||
        current.revision !== previous.revision
      )
        throw new ClientError('business', 'School data changed');
      const data = current.data;
      const value =
        field === 'wechatId' && data.kind === 'admin'
          ? data.wechatId
          : field === 'name' && data.kind !== 'admin'
            ? data.name
            : field === 'qqGroupNumber' && data.kind === 'group'
              ? data.qqGroupNumber
              : field === 'joinUrl' && data.kind === 'group'
                ? data.joinUrl
                : '';
      if (!value) return;
      await this.clipboard.set(value);
      if (generation === this.generation && !this.disposed)
        this.update({ status: '已复制', busy: false });
    } catch (error) {
      if (generation === this.generation && !this.disposed) this.fail(error);
    }
  }
  previewContext(key: SchoolEntryKey) {
    const current = this.result?.entries.find(
      (entry) => entry.entryKey === key,
    );
    return !this.disposed &&
      !this.view.busy &&
      this.campusId &&
      current?.data?.enabled &&
      current.qrcode.status === 'configured'
      ? {
          campusId: this.campusId,
          entryKey: key,
          entryRevision: current.revision,
        }
      : null;
  }
  private fail(error: unknown) {
    const failure = clientError(error);
    if (failure.kind !== 'business') {
      this.result = null;
      this.update({ loaded: false, entries: [] });
    }
    this.update({
      busy: false,
      error:
        failure.kind === 'business'
          ? '资料已变化，请查看当前内容后重试'
          : failure.kind === 'auth-expired' || failure.kind === 'auth-required'
            ? '登录状态已变化，请重新登录'
            : failure.kind === 'forbidden'
              ? '当前学校服务不可读取'
              : '学校服务暂不可用，请稍后刷新',
      status: '',
    });
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.unsubscribe();
  }
}
