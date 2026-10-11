import { ClientError, clientError } from '../api/errors';
import type { SessionStore } from '../auth/session';
import { Cancellation } from '../platform/contracts';
import type { ProfileGateway } from '../profile/gateway';
import type { Campus } from '../profile/contract';
import type { SchoolConfigurationGateway } from './gateway';
import { SchoolCommandJournal } from './pending';
import type { PendingSchoolCommand } from './pending';
import {
  schoolData,
  schoolLabels,
  schoolUuid,
  emptySchoolData,
  invalidSchool,
} from './contract';
import type {
  SchoolEntry,
  SchoolEntryKey,
  SchoolEntryData,
  SchoolManagementView,
  SchoolQrChange,
  SchoolRecovery,
} from './contract';
export interface SchoolAdminView {
  busy: boolean;
  loaded: boolean;
  management: 'none' | 'fixed' | 'global';
  regionId: string;
  regionName: string;
  entries: readonly (SchoolEntry & { label: string })[];
  selectedKey: SchoolEntryKey | null;
  selectedLabel: string;
  form: SchoolEntryData | null;
  revision: number;
  qrAction: SchoolQrChange['action'];
  qrStatus: string;
  error: string;
  status: string;
  pending: boolean;
  campusQuery: string;
  campuses: readonly Campus[];
}
export const initialSchoolAdminView = (): SchoolAdminView => ({
  busy: false,
  loaded: false,
  management: 'none',
  regionId: '',
  regionName: '',
  entries: [],
  selectedKey: null,
  selectedLabel: '',
  form: null,
  revision: 0,
  qrAction: 'keep',
  qrStatus: '',
  error: '',
  status: '',
  pending: false,
  campusQuery: '',
  campuses: [],
});
export class SchoolAdminController {
  private generation = 0;
  private cancellation = new Cancellation();
  private disposed = false;
  private readonly unsubscribe: () => void;
  private view = initialSchoolAdminView();
  private result: SchoolManagementView | null = null;
  private qr: SchoolQrChange = { action: 'keep' };
  private pending: PendingSchoolCommand | null = null;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: SchoolConfigurationGateway,
    private readonly profiles: ProfileGateway,
    private readonly journal: SchoolCommandJournal,
    private readonly newRequestId: () => Promise<string>,
    private readonly render: (view: SchoolAdminView) => void,
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
        this.update({ error: '账号已变化，请重新打开学校配置' });
      }
    });
  }
  private update(patch: Partial<SchoolAdminView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.render(this.view);
  }
  private clear() {
    this.generation++;
    this.cancellation.cancel();
    this.cancellation = new Cancellation();
    this.result = null;
    this.pending = null;
    this.qr = { action: 'keep' };
    this.view = initialSchoolAdminView();
    if (!this.disposed) this.render(this.view);
  }
  private async run<T>(
    work: (cancel: Cancellation) => Promise<T>,
    show: (result: T) => void,
  ) {
    if (this.disposed || this.view.busy) return;
    const generation = this.generation,
      ticket = this.sessions.snapshot();
    this.update({ busy: true, error: '' });
    try {
      if (!ticket.credentials)
        throw new ClientError('auth-required', 'Login is required');
      const result = await work(this.cancellation);
      this.sessions.assertCurrent(ticket);
      if (generation === this.generation && !this.disposed) show(result);
    } catch (error) {
      if (generation === this.generation && !this.disposed) this.fail(error);
    } finally {
      if (generation === this.generation && !this.disposed)
        this.update({ busy: false });
    }
  }
  async load() {
    this.clear();
    await this.run(
      async (cancel) => {
        const actor = this.sessions.snapshot().credentials!.accountId;
        this.pending = this.journal.read(actor);
        const capabilities = await this.gateway.capabilities(cancel);
        const configuration =
          capabilities.management === 'fixed'
            ? await this.gateway.management(null, cancel)
            : null;
        return { capabilities, configuration };
      },
      ({ capabilities, configuration }) => {
        this.update({
          management: capabilities.management,
          pending: this.pending !== null,
          status:
            capabilities.management === 'global'
              ? '请选择要管理的学校'
              : capabilities.management === 'none'
                ? '当前账号没有学校服务管理权限'
                : '',
        });
        if (configuration) this.show(configuration);
        if (this.pending)
          this.update({
            pending: true,
            status: '有一笔待确认保存，请先恢复结果或取消原请求',
          });
      },
    );
  }
  private show(result: SchoolManagementView) {
    this.result = result;
    this.qr = { action: 'keep' };
    this.update({
      loaded: true,
      regionId: result.context.regionId,
      regionName: result.context.regionName,
      management: result.context.management,
      entries: result.entries.map((entry) => ({
        ...entry,
        label: schoolLabels[entry.entryKey],
      })),
      selectedKey: null,
      selectedLabel: '',
      form: null,
      revision: 0,
      qrAction: 'keep',
      qrStatus: '',
      campuses: [],
      status: '每项独立保存；禁用后公开入口隐藏该项',
    });
  }
  setCampusQuery(value: string) {
    if (this.view.busy || this.pending) return;
    this.update({ campusQuery: value, campuses: [] });
  }
  async searchCampuses() {
    if (this.view.management !== 'global' || this.pending) return;
    await this.run(
      (cancel) =>
        this.profiles.campuses(
          {
            q: this.view.campusQuery.trim(),
            district: '',
            page: 1,
            pageSize: 20,
          },
          cancel,
        ),
      (page) =>
        this.update({
          campuses: page.items,
          status:
            page.total > 20
              ? '仅显示前20项，请缩小搜索范围'
              : '请选择目标学校校区',
        }),
    );
  }
  async chooseCampus(campusId: string) {
    if (
      this.view.management !== 'global' ||
      this.pending ||
      !this.view.campuses.some(
        (campus) => campus.id === campusId && campus.isActive,
      )
    )
      return;
    await this.run(
      async (cancel) => {
        const scope = await this.gateway.public(campusId, cancel);
        if (!scope.context.region)
          throw new ClientError('business', 'No active management region');
        return this.gateway.management(scope.context.region.id, cancel);
      },
      (result) => this.show(result),
    );
  }
  chooseEntry(key: SchoolEntryKey) {
    if (this.view.busy || this.pending || !this.result) return;
    const entry = this.result.entries.find((entry) => entry.entryKey === key);
    if (!entry) return;
    this.qr = { action: 'keep' };
    this.update({
      selectedKey: key,
      selectedLabel: schoolLabels[key],
      form: entry.data ? { ...entry.data } : emptySchoolData(key),
      revision: entry.revision,
      qrAction: 'keep',
      qrStatus:
        entry.qrcode.status === 'configured'
          ? '已配置二维码'
          : '尚未配置二维码',
      error: '',
      status: '',
    });
  }
  setField(field: string, value: string | boolean) {
    if (this.view.busy || this.pending || !this.view.form) return;
    const form = this.view.form;
    if (field === 'enabled' && typeof value === 'boolean')
      this.update({ form: { ...form, enabled: value } });
    else if (typeof value === 'string') {
      if (field === 'wechatId' && form.kind === 'admin')
        this.update({ form: { ...form, wechatId: value } });
      else if (
        (field === 'name' || field === 'description') &&
        form.kind !== 'admin'
      )
        this.update({ form: { ...form, [field]: value } });
      else if (
        form.kind === 'group' &&
        (field === 'joinUrl' || field === 'qqGroupNumber')
      )
        this.update({ form: { ...form, [field]: value } });
      else if (form.kind === 'group' && field === 'maxGroupNumber')
        this.update({
          form: {
            ...form,
            maxGroupNumber: value === '' ? null : Number(value),
          },
        });
    }
  }
  removeQr() {
    if (this.view.busy || this.pending || !this.view.form) return;
    this.qr = { action: 'remove' };
    this.update({ qrAction: 'remove', qrStatus: '保存后清除二维码' });
  }
  keepQr() {
    if (this.view.busy || this.pending || !this.view.form) return;
    this.qr = { action: 'keep' };
    this.update({ qrAction: 'keep', qrStatus: '保留原二维码' });
  }
  qrTarget() {
    return !this.disposed &&
      !this.view.busy &&
      !this.pending &&
      this.view.regionId &&
      this.view.selectedKey
      ? {
          regionId: this.view.regionId,
          entryKey: this.view.selectedKey,
          expectedRevision: this.view.revision,
        }
      : null;
  }
  setQrAsset(
    target: {
      regionId: string;
      entryKey: SchoolEntryKey;
      expectedRevision: number;
    },
    assetId: string,
  ) {
    const current = this.qrTarget();
    if (
      !current ||
      current.regionId !== target.regionId ||
      current.entryKey !== target.entryKey ||
      current.expectedRevision !== target.expectedRevision
    )
      return;
    this.qr = { action: 'replace', assetId: schoolUuid(assetId) };
    this.update({
      qrAction: 'replace',
      qrStatus: '二维码已审核就绪，保存后发布',
    });
  }
  async save() {
    if (
      this.pending ||
      !this.view.form ||
      !this.view.selectedKey ||
      !this.view.regionId
    )
      return;
    let entry: SchoolEntryData;
    try {
      entry = schoolData(this.view.form, this.view.selectedKey);
    } catch {
      this.update({
        error:
          '请检查字段长度、群号、群序号和入群链接（仅支持 HTTPS 微信/QQ 官方域名）',
      });
      return;
    }
    const regionId = this.view.regionId,
      key = this.view.selectedKey,
      revision = this.view.revision,
      qrcode = { ...this.qr };
    await this.run(
      async (cancel) => {
        const ticket = this.sessions.snapshot(),
          actor = ticket.credentials!.accountId,
          requestId = await this.newRequestId();
        this.sessions.assertCurrent(ticket);
        if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
        this.pending = this.journal.write(actor, regionId, key, {
          clientRequestId: requestId,
          expectedRevision: revision,
          entry,
          qrcode,
        });
        this.update({
          pending: true,
          status: '正在保存；如响应中断，可恢复原请求',
        });
        const receipt = await this.gateway.save(
          regionId,
          key,
          this.pending.command,
          cancel,
        );
        this.sessions.assertCurrent(ticket);
        this.journal.settle(this.pending, receipt);
        this.pending = null;
        return this.gateway.management(regionId, cancel).catch(() => null);
      },
      (result) => {
        if (result) this.show(result);
        else {
          this.result = null;
          this.update({
            loaded: false,
            entries: [],
            form: null,
            selectedKey: null,
          });
        }
        this.update({
          pending: false,
          status: '已保存，公开学校服务读取的是该已发布版本',
        });
      },
    );
  }
  async recover(retry = false) {
    if (!this.pending) return;
    const pending = this.pending;
    await this.run(
      async (cancel) => {
        const recovery = await this.gateway.recover(
          pending.command.clientRequestId,
          cancel,
        );
        if (recovery.state === 'not_recorded' && retry)
          return {
            state: 'recorded' as const,
            requestId: pending.command.clientRequestId,
            receipt: await this.gateway.save(
              pending.regionId,
              pending.entryKey,
              pending.command,
              cancel,
            ),
          };
        return recovery;
      },
      (result) => this.settleRecovery(pending, result),
    );
  }
  async cancelPending() {
    if (!this.pending) return;
    const pending = this.pending;
    await this.run(
      (cancel) =>
        this.gateway.cancel(
          pending.command.clientRequestId,
          pending.requestHash,
          cancel,
        ),
      (result) => this.settleRecovery(pending, result),
    );
  }
  private settleRecovery(
    pending: PendingSchoolCommand,
    result: SchoolRecovery,
  ) {
    if (result.state === 'not_recorded') {
      this.update({
        status: '暂未记录结果。可用同一请求重试，或取消原请求',
        pending: true,
      });
      return;
    }
    if (result.state === 'recorded')
      this.journal.settle(pending, result.receipt);
    else {
      if (result.requestHash !== pending.requestHash) invalidSchool();
      this.journal.discard(pending);
    }
    this.pending = null;
    this.result = null;
    this.qr = { action: 'keep' };
    this.update({
      pending: false,
      loaded: false,
      entries: [],
      selectedKey: null,
      form: null,
      qrAction: 'keep',
      qrStatus: '',
      status:
        result.state === 'recorded'
          ? '原请求已保存。请重新读取当前配置'
          : '原请求已取消，可重新读取配置后编辑',
    });
  }
  async refresh() {
    if (this.pending) return;
    const region = this.view.regionId;
    if (!region) {
      await this.load();
      return;
    }
    await this.run(
      (cancel) => this.gateway.management(region, cancel),
      (result) => this.show(result),
    );
  }
  private fail(error: unknown) {
    const failure = clientError(error),
      code = failure.details.serverCode;
    const permission =
      failure.kind === 'forbidden' ||
      failure.kind === 'auth-required' ||
      failure.kind === 'auth-expired' ||
      code === 'AUTHORIZATION_REQUIRED';
    if (permission) {
      this.result = null;
      this.update({
        entries: [],
        form: null,
        selectedKey: null,
        loaded: false,
      });
    }
    this.update({
      pending: this.pending !== null,
      error: permission
        ? '当前管理权限或登录状态已失效，请重新登录或重新读取'
        : code === 'SCHOOL_CONFIGURATION_REVISION_CONFLICT'
          ? '配置已被更新，请先取消本次请求，再重新读取后编辑'
          : failure.kind === 'storage'
            ? '本地请求记录不可用，未创建新的请求，请先恢复已有记录'
            : this.pending
              ? '保存结果尚未确认，请恢复原请求，不要重复新建保存'
              : '操作暂不可用，请刷新后重试',
      status: '',
    });
  }
  previewContext() {
    const key = this.view.selectedKey,
      current = this.result?.entries.find((entry) => entry.entryKey === key);
    return !this.disposed &&
      !this.view.busy &&
      key &&
      current?.qrcode.status === 'configured' &&
      current.data?.enabled
      ? {
          regionId: this.view.regionId,
          entryKey: key,
          entryRevision: current.revision,
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
