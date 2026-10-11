import { ClientError, clientError } from '../api/errors';
import type { SessionStore } from '../auth/session';
import { Cancellation } from '../platform/contracts';
import type { DirectoryGateway } from '../directory/gateway';
import type { DirectoryCategory } from '../directory/contract';
import type { OrganizationGateway } from './gateway';
import { OrganizationCommandJournal } from './pending';
import type { PendingOrganizationCommand } from './pending';
import {
  decodeOrganizationData,
  decodeOrganizationCommand,
  organizationUuid,
  organizationSlots,
  organizationSlotLabels,
  organizationStateLabels,
  organizationRoleLabels,
} from './contract';
import type {
  OrganizationData,
  OrganizationDetail,
  OrganizationPublicDetail,
  OrganizationPerson,
  OrganizationMediaChanges,
  OrganizationCommand,
  OrganizationReceipt,
  OrganizationKind,
  OrganizationPlatform,
  OrganizationPage,
  OrganizationQuery,
} from './contract';
import type { OrganizationMediaSlot } from './media-validation';
import type {
  OrganizationMediaUploadTarget,
  OrganizationMediaPreviewTarget,
} from './media-runtime';
export interface OrganizationEditorView {
  busy: boolean;
  loaded: boolean;
  id: string;
  regionId: string;
  revision: number;
  authorityVersion: number;
  publicRead: boolean;
  detail: OrganizationDetail | null;
  publicDetail: OrganizationPublicDetail | null;
  form: OrganizationData | null;
  categories: readonly DirectoryCategory[];
  moreCategories: boolean;
  pending: boolean;
  pendingId: string;
  lookupInput: string;
  person: OrganizationPerson | null;
  reason: string;
  error: string;
  status: string;
  slots: readonly {
    slot: OrganizationMediaSlot;
    label: string;
    configured: boolean;
    change: string;
  }[];
  stateLabel: string;
  roleLabel: string;
}
export const initialOrganizationEditorView = (): OrganizationEditorView => ({
  busy: false,
  loaded: false,
  id: '',
  regionId: '',
  revision: 0,
  authorityVersion: 0,
  publicRead: false,
  detail: null,
  publicDetail: null,
  form: null,
  categories: [],
  moreCategories: false,
  pending: false,
  pendingId: '',
  lookupInput: '',
  person: null,
  reason: '',
  error: '',
  status: '',
  slots: [],
  stateLabel: '',
  roleLabel: '',
});
export class OrganizationEditorController {
  private view = initialOrganizationEditorView();
  private generation = 0;
  private cancel = new Cancellation();
  private disposed = false;
  private pending: PendingOrganizationCommand | null = null;
  private changes: OrganizationMediaChanges = {};
  private categoryCursor: string | null = null;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: OrganizationGateway,
    private readonly directory: DirectoryGateway,
    private readonly journal: OrganizationCommandJournal,
    private readonly newId: () => Promise<string>,
    private readonly render: (v: OrganizationEditorView) => void,
    private readonly settledMedia?: (id: string) => Promise<void>,
  ) {
    let owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== owner.epoch ||
        now.credentials?.accountId !== owner.credentials?.accountId
      ) {
        owner = now;
        this.clear();
        this.update({ error: '账号已变化，请重新打开组织页面' });
      }
    });
  }
  private update(patch: Partial<OrganizationEditorView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.render(this.view);
  }
  private clear() {
    this.generation++;
    this.cancel.cancel();
    this.cancel = new Cancellation();
    this.pending = null;
    this.changes = {};
    this.categoryCursor = null;
    this.view = initialOrganizationEditorView();
    if (!this.disposed) this.render(this.view);
  }
  private async run(
    work: (cancel: Cancellation, guard: () => void) => Promise<void>,
  ) {
    if (this.disposed || this.view.busy) return;
    const gen = this.generation,
      ticket = this.sessions.snapshot(),
      guard = () => {
        this.sessions.assertCurrent(ticket);
        if (this.disposed || this.generation !== gen)
          throw new ClientError('cancelled', '页面已关闭');
      };
    this.update({ busy: true, error: '' });
    try {
      if (!ticket.credentials)
        throw new ClientError('auth-required', '请先登录');
      await work(this.cancel, guard);
      guard();
    } catch (error) {
      if (!this.disposed && gen === this.generation) {
        const failure = clientError(error);
        if (
          failure.details.httpStatus === 403 ||
          failure.details.httpStatus === 404 ||
          failure.kind === 'stale-session' ||
          failure.kind === 'auth-required' ||
          failure.kind === 'auth-expired'
        )
          this.update({
            detail: null,
            publicDetail: null,
            form: null,
            slots: [],
            person: null,
          });
        this.update({
          error: failure.message,
          status: this.pending ? '操作尚未确认，请恢复原请求或取消原请求' : '',
        });
      }
    } finally {
      if (!this.disposed && gen === this.generation)
        this.update({ busy: false });
    }
  }
  async load(
    id: string | null,
    publicRead = false,
    regionId: string | null = null,
  ) {
    this.clear();
    this.update({ publicRead });
    await this.run(async (cancel, guard) => {
      const actor = this.sessions.snapshot().credentials!.accountId;
      this.pending = this.journal.read(actor);
      this.update({
        pending: !!this.pending,
        pendingId: this.pending?.organizationId ?? '',
      });
      if (id) {
        organizationUuid(id);
        if (publicRead) {
          const detail = await this.gateway.publicDetail(
            organizationUuid(regionId),
            id,
            cancel,
          );
          guard();
          this.showPublic(detail);
        } else {
          const detail = await this.gateway.detail(id, cancel);
          guard();
          this.show(detail);
        }
      } else {
        const context = await this.gateway.context(cancel);
        guard();
        this.update({
          regionId: context.regionId,
          loaded: true,
          form: {
            kind: 'org',
            platform: 'wechat',
            categoryId: '',
            name: '',
            introText: '',
            qqGroupNumber: null,
          },
          status: '先保存申请草稿，再上传必填图片并提交审核',
        });
        await this.categories(cancel, guard, false);
      }
    });
  }
  private show(detail: OrganizationDetail) {
    this.changes = {};
    this.update({
      loaded: true,
      id: detail.id,
      regionId: detail.regionId,
      revision: detail.revision,
      authorityVersion: detail.authorityVersion,
      detail,
      publicDetail: null,
      form: { ...detail.data },
      stateLabel: organizationStateLabels[detail.state],
      roleLabel: organizationRoleLabels[detail.role],
      person: null,
      reason: '',
      slots: this.slotViews(detail.data, detail.mediaBindings),
      status:
        detail.state === 'pending'
          ? '学校管理员正在审核此版本'
          : detail.state === 'rejected'
            ? `审核未通过：${detail.reviewReason ?? ''}`
            : detail.state === 'approved'
              ? '修改后保持公开；所有新图片仍须通过安全审核'
              : '请补齐必填图片后提交审核',
    });
  }
  private showPublic(detail: OrganizationPublicDetail) {
    this.update({
      loaded: true,
      id: detail.id,
      regionId: detail.regionId,
      revision: detail.revision,
      authorityVersion: detail.authorityVersion,
      publicRead: true,
      publicDetail: detail,
      detail: null,
      form: null,
      stateLabel: '已批准',
      roleLabel: '',
      slots: this.slotViews(detail.data, detail.mediaBindings).filter(
        (s) => s.configured && s.slot !== 'managerContact',
      ),
    });
  }
  private slotViews(
    data: OrganizationData,
    bindings: Record<string, string | null | undefined>,
  ) {
    return organizationSlots
      .filter(
        (slot) =>
          (slot !== 'managerContact' || data.platform === 'wechat') &&
          (slot !== 'linkedOfficialQr' || data.platform !== 'official'),
      )
      .map((slot) => ({
        slot,
        label: organizationSlotLabels[slot],
        configured: !!bindings[slot],
        change: this.changes[slot]?.action ?? 'keep',
      }));
  }
  private mutable() {
    return (
      !this.disposed &&
      !this.view.busy &&
      !this.pending &&
      !this.view.publicRead &&
      (!this.view.detail || this.view.detail.permissions.edit)
    );
  }
  setField(field: string, value: string) {
    if (
      !this.mutable() ||
      !this.view.form ||
      !['name', 'introText', 'qqGroupNumber'].includes(field)
    )
      return;
    const form = { ...this.view.form, [field]: value };
    this.update({ form, error: '' });
  }
  setReason(value: string) {
    if (this.disposed || this.view.busy || this.pending) return;
    this.update({ reason: value });
  }
  setLookup(value: string) {
    if (this.disposed || this.view.busy || this.pending) return;
    this.update({ lookupInput: value, person: null });
  }
  async setKind(kind: OrganizationKind) {
    if (
      !this.mutable() ||
      this.view.id ||
      !['school', 'org', 'official'].includes(kind)
    )
      return;
    const current = this.view.form!;
    this.update({
      form: {
        ...current,
        kind,
        platform:
          kind === 'official'
            ? 'official'
            : current.platform === 'official'
              ? 'wechat'
              : current.platform,
        qqGroupNumber: null,
        categoryId: '',
      },
      categories: [],
    });
    await this.run((cancel, guard) => this.categories(cancel, guard, false));
  }
  setPlatform(platform: OrganizationPlatform) {
    if (!this.mutable() || this.view.id || !this.view.form) return;
    if (
      this.view.form.kind === 'official'
        ? platform !== 'official'
        : !['qq', 'wechat'].includes(platform)
    )
      return;
    this.update({
      form: {
        ...this.view.form,
        platform,
        qqGroupNumber: platform === 'qq' ? '' : null,
      },
    });
  }
  chooseCategory(id: string) {
    if (
      !this.mutable() ||
      !this.view.form ||
      !this.view.categories.some((c) => c.id === id)
    )
      return;
    this.update({ form: { ...this.view.form, categoryId: id } });
  }
  async moreCategories() {
    if (!this.categoryCursor || !this.mutable()) return;
    await this.run((cancel, guard) => this.categories(cancel, guard, true));
  }
  private async categories(
    cancel: Cancellation,
    guard: () => void,
    more: boolean,
  ) {
    if (!this.view.form) return;
    const page = await this.directory.categories(
      this.view.regionId,
      this.view.form.kind,
      more ? this.categoryCursor : null,
      cancel,
      20,
    );
    guard();
    this.categoryCursor = page.nextCursor;
    this.update({
      categories: more ? [...this.view.categories, ...page.items] : page.items,
      moreCategories: !!page.nextCursor,
    });
  }
  uploadTarget(
    slot: OrganizationMediaSlot,
  ): OrganizationMediaUploadTarget | null {
    if (
      !this.mutable() ||
      !this.view.id ||
      !this.view.slots.some((s) => s.slot === slot)
    )
      return null;
    return {
      organizationId: this.view.id,
      applicationRevision: this.view.revision,
      slot,
    };
  }
  setMediaAsset(target: OrganizationMediaUploadTarget, assetId: string) {
    const now = this.uploadTarget(target.slot);
    if (
      !now ||
      now.organizationId !== target.organizationId ||
      now.applicationRevision !== target.applicationRevision
    )
      return;
    this.changes = {
      ...this.changes,
      [target.slot]: { action: 'replace', assetId: organizationUuid(assetId) },
    };
    this.update({
      slots: this.slotViews(this.view.form!, this.view.detail!.mediaBindings),
      status: '图片已通过安全审核，保存或提交后生效',
    });
  }
  setMediaAction(slot: OrganizationMediaSlot, action: 'keep' | 'remove') {
    if (!this.uploadTarget(slot)) return;
    this.changes = { ...this.changes, [slot]: { action } };
    this.update({
      slots: this.slotViews(this.view.form!, this.view.detail!.mediaBindings),
    });
  }
  previewTarget(
    slot: OrganizationMediaSlot,
  ): OrganizationMediaPreviewTarget | null {
    const detail = this.view.publicDetail ?? this.view.detail;
    if (
      !detail ||
      this.view.busy ||
      !detail.mediaBindings[slot] ||
      (this.view.publicRead && slot === 'managerContact')
    )
      return null;
    return {
      organizationId: detail.id,
      applicationRevision: detail.revision,
      slot,
      audience: this.view.publicRead ? 'public' : 'management',
    };
  }
  async lookup() {
    if (!this.view.detail?.permissions.manageMembers || this.pending) return;
    await this.run(async (cancel, guard) => {
      const person = await this.gateway.lookup(
        this.view.id,
        organizationUuid(this.view.lookupInput.trim()),
        cancel,
      );
      guard();
      this.update({ person });
    });
  }
  async save(submit = false) {
    if (!this.mutable() || !this.view.form) return;
    await this.perform(async () => {
      const data = decodeOrganizationData(this.view.form);
      const cas = {
        clientRequestId: await this.newId(),
        expectedRevision: this.view.revision,
        expectedAuthorityVersion: this.view.authorityVersion,
      };
      if (!this.view.id) {
        if (submit)
          throw new ClientError('protocol', '请先保存草稿并上传必填图片');
        return {
          ...cas,
          action: 'create',
          organizationId: await this.newId(),
          regionId: this.view.regionId,
          data,
        };
      }
      return {
        ...cas,
        action: submit ? 'submit' : 'save',
        data,
        mediaChanges: this.changes,
      };
    });
  }
  async review(action: 'approve' | 'reject') {
    if (this.view.busy || this.pending || !this.view.detail?.permissions.review)
      return;
    await this.perform(async () => ({
      clientRequestId: await this.newId(),
      expectedRevision: this.view.revision,
      expectedAuthorityVersion: this.view.authorityVersion,
      action,
      reason: action === 'reject' ? this.view.reason.trim() : '',
    }));
  }
  async member(
    action: 'add_admin' | 'remove_admin' | 'transfer_owner',
    profileId?: string,
  ) {
    if (
      this.view.busy ||
      this.pending ||
      !this.view.detail?.permissions.manageMembers ||
      (action === 'transfer_owner' &&
        !this.view.detail.permissions.transferOwner)
    )
      return;
    const target = profileId ?? this.view.person?.profileId;
    if (!target) return;
    await this.perform(async () => ({
      clientRequestId: await this.newId(),
      expectedRevision: this.view.revision,
      expectedAuthorityVersion: this.view.authorityVersion,
      action,
      targetProfileId: organizationUuid(target),
    }));
  }
  private async perform(prepare: () => Promise<OrganizationCommand>) {
    await this.run(async (cancel, guard) => {
      const command = decodeOrganizationCommand(await prepare());
      guard();
      const id =
          command.action === 'create' ? command.organizationId : this.view.id,
        actor = this.sessions.snapshot().credentials!.accountId;
      this.pending = this.journal.write(actor, id, this.view.regionId, command);
      this.update({ pending: true, pendingId: id });
      guard();
      const receipt = await this.gateway.command(
        id,
        this.view.regionId,
        command,
        cancel,
      );
      guard();
      await this.settle(receipt, cancel, guard);
    });
  }
  private async settle(
    receipt: OrganizationReceipt,
    cancel: Cancellation,
    guard: () => void,
  ) {
    if (!this.pending) return;
    const old = this.pending;
    this.journal.settle(old, receipt);
    this.pending = null;
    this.update({ pending: false, pendingId: '', status: '操作已确认' });
    if (this.settledMedia) {
      await this.settledMedia(receipt.organizationId);
      guard();
    }
    try {
      const detail = await this.gateway.detail(receipt.organizationId, cancel);
      guard();
      this.show(detail);
    } catch (error) {
      guard();
      this.update({
        detail: null,
        form: null,
        id: receipt.organizationId,
        slots: [],
        status:
          receipt.outcome === 'owner_transferred'
            ? '所有权已转让，原所有者已降为管理员'
            : '操作已完成，当前详情需重新加载',
        error: clientError(error).message,
      });
    }
  }
  async recover(retry = false) {
    if (!this.pending || this.view.busy) return;
    await this.run(async (cancel, guard) => {
      const p = this.pending!;
      let result = await this.gateway.recover(
        p.command.clientRequestId,
        cancel,
      );
      guard();
      if (result.state === 'not_recorded' && retry) {
        const receipt = await this.gateway.command(
          p.organizationId,
          p.regionId,
          p.command,
          cancel,
        );
        guard();
        result = {
          state: 'recorded',
          requestId: p.command.clientRequestId,
          receipt,
        };
      }
      if (result.state === 'recorded')
        await this.settle(result.receipt, cancel, guard);
      else if (result.state === 'cancelled') {
        if (result.requestHash !== p.requestHash)
          throw new ClientError('protocol', '原请求摘要不匹配');
        this.journal.discard(p);
        this.pending = null;
        this.update({
          pending: false,
          pendingId: '',
          status: '原操作已取消，请刷新后重新操作',
        });
      } else
        this.update({ status: '服务端尚无结果，可重试同一请求或取消原请求' });
    });
  }
  async cancelPending() {
    if (!this.pending || this.view.busy) return;
    await this.run(async (cancel, guard) => {
      const p = this.pending!,
        result = await this.gateway.cancel(
          p.command.clientRequestId,
          p.requestHash,
          cancel,
        );
      guard();
      if (result.state === 'recorded')
        await this.settle(result.receipt, cancel, guard);
      else if (
        result.state === 'cancelled' &&
        result.requestHash === p.requestHash
      ) {
        this.journal.discard(p);
        this.pending = null;
        this.update({
          pending: false,
          pendingId: '',
          status: '原操作已取消，请刷新后重新操作',
        });
      } else throw new ClientError('protocol', '取消结果尚未确认');
    });
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.unsubscribe();
  }
}
export interface OrganizationListView {
  busy: boolean;
  loaded: boolean;
  items: OrganizationPage['items'];
  more: boolean;
  error: string;
  status: string;
}
export const initialOrganizationListView = (): OrganizationListView => ({
  busy: false,
  loaded: false,
  items: [],
  more: false,
  error: '',
  status: '',
});
export class OrganizationListController {
  private view = initialOrganizationListView();
  private generation = 0;
  private cancel = new Cancellation();
  private disposed = false;
  private cursor: string | null = null;
  private query: OrganizationQuery = {};
  private mode: 'mine' | 'review' | 'public' = 'mine';
  private region: string | null = null;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: OrganizationGateway,
    private readonly render: (v: OrganizationListView) => void,
  ) {
    let owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        current.epoch !== owner.epoch ||
        current.credentials?.accountId !== owner.credentials?.accountId
      ) {
        owner = current;
        this.clear();
        this.update({ error: '账号已变化，请重新加载' });
      }
    });
  }
  private update(v: Partial<OrganizationListView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...v };
    this.render(this.view);
  }
  clear() {
    this.generation++;
    this.cancel.cancel();
    this.cancel = new Cancellation();
    this.cursor = null;
    this.view = initialOrganizationListView();
    this.update({});
  }
  async load(
    mode: 'mine' | 'review' | 'public',
    region: string | null,
    query: OrganizationQuery = {},
  ) {
    this.clear();
    this.mode = mode;
    this.region = region;
    this.query = { ...query };
    await this.fetch(false);
  }
  next() {
    if (!this.cursor || this.view.busy) return;
    return this.fetch(true);
  }
  private async fetch(more: boolean) {
    if (this.disposed || this.view.busy) return;
    const gen = this.generation,
      ticket = this.sessions.snapshot();
    this.update({ busy: true, error: '' });
    try {
      if (!ticket.credentials)
        throw new ClientError('auth-required', '请先登录');
      const page = await this.gateway.list(
        this.mode,
        this.region,
        {
          ...this.query,
          ...(more && this.cursor ? { cursor: this.cursor } : {}),
        },
        this.cancel,
      );
      this.sessions.assertCurrent(ticket);
      if (this.disposed || gen !== this.generation) return;
      const items = more ? [...this.view.items, ...page.items] : page.items;
      if (new Set(items.map((i) => i.id)).size !== items.length)
        throw new ClientError('protocol', '组织目录已变化，请刷新');
      this.cursor = page.nextCursor;
      this.update({ loaded: true, items, more: !!this.cursor });
    } catch (error) {
      if (gen === this.generation && !this.disposed) {
        this.cursor = null;
        this.update({
          items: [],
          more: false,
          loaded: false,
          error: clientError(error).message,
        });
      }
    } finally {
      if (gen === this.generation && !this.disposed)
        this.update({ busy: false });
    }
  }
  dispose() {
    this.clear();
    this.disposed = true;
    this.unsubscribe();
  }
}
