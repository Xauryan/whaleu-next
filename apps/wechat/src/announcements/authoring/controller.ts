import { ClientError, clientError } from '../../api/errors';
import type { SessionStore } from '../../auth/session';
import { Cancellation } from '../../platform/contracts';
import {
  id,
  slots,
  emptyContent,
  decodeInput,
  decodeCommand,
} from './contract';
import type {
  Slot,
  Managed,
  ContentInput,
  AudienceInput,
  Changes,
  Command,
  Receipt,
  Recovery,
} from './contract';
import { AnnouncementManagementGateway } from './gateway';
import { AnnouncementPublicationJournal } from './pending';
import type { PendingCommand } from './pending';
export const initialAuthoringView = () => ({
  busy: false,
  loaded: false,
  id: '',
  revision: 0,
  state: 'new',
  management: 'none' as 'none' | 'fixed' | 'global',
  regionName: '',
  form: emptyContent(),
  audienceKind: 'all' as 'all' | 'regions',
  regions: [] as { id: string; name: string }[],
  selectedRegions: [] as string[],
  search: '',
  moreRegions: false,
  items: [] as Managed[],
  more: false,
  pending: false,
  pendingId: '',
  dirty: false,
  error: '',
  status: '',
  slots: slots.map((slot) => ({ slot, configured: false, changed: false })),
});
export type AuthoringView = ReturnType<typeof initialAuthoringView>;
export class AnnouncementAuthoringController {
  private view = initialAuthoringView();
  private disposed = false;
  private generation = 0;
  private cancellation = new Cancellation();
  private pending: PendingCommand | null = null;
  private row: Managed | null = null;
  private changes: Changes = {};
  private cursor: string | null = null;
  private readonly stop: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: AnnouncementManagementGateway,
    private readonly journal: AnnouncementPublicationJournal,
    private readonly newId: () => Promise<string>,
    private readonly render: (v: AuthoringView) => void,
    private readonly reconcile?: (id: string) => Promise<void>,
  ) {
    let epoch = sessions.snapshot().epoch;
    this.stop = sessions.subscribe(() => {
      if (epoch !== sessions.snapshot().epoch) {
        epoch = sessions.snapshot().epoch;
        this.clear();
        this.update({ error: '账号已变化，请重新打开公告管理' });
      }
    });
  }
  snapshot() {
    return JSON.parse(JSON.stringify(this.view)) as AuthoringView;
  }
  private update(v: Partial<AuthoringView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...v };
    this.render(this.snapshot());
  }
  private ticket() {
    const ticket = this.sessions.snapshot(),
      generation = this.generation;
    if (!ticket.credentials) throw new ClientError('auth-required', '请先登录');
    return {
      actor: ticket.credentials.accountId,
      check: () => {
        this.sessions.assertCurrent(ticket);
        if (
          this.disposed ||
          generation !== this.generation ||
          this.cancellation.isCancelled
        )
          throw new ClientError('cancelled', '页面已关闭');
      },
    };
  }
  private async run(work: () => Promise<void>) {
    if (this.disposed || this.view.busy) return;
    const gen = this.generation;
    this.update({ busy: true, error: '' });
    try {
      await work();
    } catch (error) {
      if (gen === this.generation && !this.disposed) {
        const e = clientError(error);
        this.update({
          error:
            e.kind === 'storage' ||
            e.details.serverCode === 'ANNOUNCEMENT_INPUT_TOO_LARGE'
              ? e.message
              : this.pending
                ? '原公告操作尚未确认，请恢复或取消原请求'
                : '公告操作不可用，请刷新权限与内容后重试',
        });
      }
    } finally {
      if (gen === this.generation) this.update({ busy: false });
    }
  }
  async load(target: string | null = null, list = false) {
    await this.run(async () => {
      const t = this.ticket();
      this.pending = this.journal.read(t.actor);
      this.update({
        pending: !!this.pending,
        pendingId: this.pending?.command.clientRequestId ?? '',
      });
      if (this.pending) {
        this.update({ id: this.pending.announcementId });
        await this.recoverInternal(t);
        return;
      }
      let cap;
      try {
        cap = await this.gateway.capabilities(this.cancellation);
      } catch (error) {
        const draft = target ?? this.journal.draftId(t.actor);
        if (!draft) throw error;
        await this.closeOnly(draft, t);
        return;
      }
      t.check();
      this.update({
        management: cap.management,
        regionName: cap.region?.name ?? '',
        loaded: true,
      });
      if (cap.management === 'none') {
        const draft = target ?? this.journal.draftId(t.actor);
        if (draft) {
          const closure = await this.gateway.closure(draft, this.cancellation);
          t.check();
          this.update({
            id: closure.id,
            revision: closure.revision,
            state: closure.state,
            status: '当前管理权限已结束，仍可取消自己的上传草稿',
          });
        } else
          this.update({ status: '需要当前学校管理员或全局超级管理员权限' });
        return;
      }
      if (list) {
        const page = await this.gateway.list(this.cancellation);
        t.check();
        this.cursor = page.nextCursor;
        this.update({ items: page.items, more: !!this.cursor });
        return;
      }
      const draft = target ?? this.journal.draftId(t.actor);
      if (draft) {
        try {
          await this.read(draft, t);
        } catch (error) {
          try {
            await this.closeOnly(draft, t);
          } catch {
            throw error;
          }
        }
      } else if (cap.management === 'global') await this.regionsInternal('', t);
    });
  }
  async more() {
    if (!this.cursor) return;
    await this.run(async () => {
      const t = this.ticket(),
        page = await this.gateway.list(this.cancellation, this.cursor!);
      t.check();
      this.cursor = page.nextCursor;
      this.update({
        items: [...this.view.items, ...page.items],
        more: !!this.cursor,
      });
    });
  }
  private async closeOnly(
    target: string,
    t: ReturnType<AnnouncementAuthoringController['ticket']>,
  ) {
    const closure = await this.gateway.closure(target, this.cancellation);
    t.check();
    this.row = null;
    this.changes = {};
    this.update({
      id: closure.id,
      revision: closure.revision,
      state: 'draft',
      management: 'none',
      loaded: true,
      form: emptyContent(),
      status: '当前仅可取消自己的上传草稿',
    });
  }
  private async read(
    target: string,
    t: ReturnType<AnnouncementAuthoringController['ticket']>,
  ) {
    const row = await this.gateway.detail(target, this.cancellation);
    t.check();
    this.row = row;
    this.changes = {};
    const form = decodeInput(
      Object.fromEntries(
        Object.entries(row.content).filter(
          ([field]) => field !== 'title' && field !== 'type',
        ),
      ),
    );
    this.update({
      id: row.id,
      revision: row.revision,
      state: row.state,
      form,
      audienceKind: row.audience.kind,
      selectedRegions: row.audience.regionIds,
      dirty: false,
      loaded: true,
      slots: slots.map((slot) => ({
        slot,
        configured: !!row.mediaBindings[slot],
        changed: false,
      })),
    });
  }
  private async regionsInternal(
    search: string,
    t: ReturnType<AnnouncementAuthoringController['ticket']>,
  ) {
    const r = await this.gateway.regions(search, this.cancellation);
    t.check();
    this.update({ regions: r.items, moreRegions: r.more });
  }
  search(value: string) {
    if (!this.view.busy && !this.pending) this.update({ search: value });
  }
  async findRegions() {
    await this.run(async () =>
      this.regionsInternal(this.view.search, this.ticket()),
    );
  }
  chooseRegion(target: string) {
    if (
      this.view.busy ||
      this.pending ||
      !this.view.regions.some((r) => r.id === target)
    )
      return;
    const selected = this.view.selectedRegions.includes(target)
      ? this.view.selectedRegions.filter((x) => x !== target)
      : [...this.view.selectedRegions, target];
    if (selected.length > 64) return;
    this.update({
      selectedRegions: selected,
      audienceKind: 'regions',
      dirty: true,
    });
  }
  chooseAll() {
    if (!this.view.busy && !this.pending && this.view.management === 'global')
      this.update({ audienceKind: 'all', selectedRegions: [], dirty: true });
  }
  setField(field: string, value: string | boolean) {
    if (
      this.view.busy ||
      this.pending ||
      this.view.state === 'cancelled' ||
      ![
        'versionLabel',
        'bodyText',
        'announcementDate',
        'popupEnabled',
        'highlight',
      ].includes(field)
    )
      return;
    try {
      const form = decodeInput({
        ...this.view.form,
        [field]: field === 'announcementDate' ? value || null : value,
      });
      this.update({ form, dirty: true });
    } catch {
      this.update({ error: '公告字段格式无效' });
    }
  }
  private audience(): AudienceInput {
    return this.view.management === 'fixed'
      ? { kind: 'fixed' }
      : this.view.audienceKind === 'all'
        ? { kind: 'all' }
        : { kind: 'regions', regionIds: this.view.selectedRegions };
  }
  private syncedContent(): ContentInput {
    return {
      ...this.view.form,
      popupTitle:
        this.row?.content.title ?? `鲸语校园${this.view.form.versionLabel}`,
      popupBodyText: this.view.form.bodyText,
    };
  }
  async act(action: Command['action'], enabled?: boolean) {
    if (this.pending) return;
    await this.run(async () => {
      const t = this.ticket(),
        requestId = await this.newId();
      t.check();
      const target = this.view.id || (await this.newId());
      t.check();
      const base = {
        clientRequestId: requestId,
        expectedRevision: this.view.revision,
      };
      const command = decodeCommand(
        action === 'create'
          ? {
              ...base,
              action,
              content: this.syncedContent(),
              audience: this.audience(),
            }
          : action === 'save' || action === 'update'
            ? {
                ...base,
                action,
                content: this.syncedContent(),
                audience: this.audience(),
                mediaChanges: this.changes,
              }
            : action === 'set_enabled'
              ? { ...base, action, enabled }
              : { ...base, action },
      );
      this.pending = this.journal.write(t.actor, target, command);
      this.update({ id: target, pending: true, pendingId: requestId });
      await this.send(t);
    });
  }
  private async send(t: ReturnType<AnnouncementAuthoringController['ticket']>) {
    const p = this.pending!;
    const r = await this.gateway.command(
      p.announcementId,
      p.command,
      this.cancellation,
    );
    t.check();
    await this.settle(p, r, t);
  }
  private async settle(
    p: PendingCommand,
    r: Receipt,
    t: ReturnType<AnnouncementAuthoringController['ticket']>,
  ) {
    this.journal.settle(p, r);
    t.check();
    this.pending = null;
    this.update({
      pending: false,
      pendingId: '',
      status: '操作已确认，正在读取当前公告',
      dirty: false,
    });
    await this.reconcile?.(p.announcementId);
    t.check();
    if (r.outcome === 'cancel_draft') {
      this.row = null;
      this.changes = {};
      this.update({
        ...initialAuthoringView(),
        management: this.view.management,
        regionName: this.view.regionName,
        status: '上传草稿已取消',
      });
      return;
    }
    const cap = await this.gateway.capabilities(this.cancellation);
    t.check();
    this.update({
      management: cap.management,
      regionName: cap.region?.name ?? '',
    });
    try {
      await this.read(p.announcementId, t);
    } catch (error) {
      try {
        await this.closeOnly(p.announcementId, t);
      } catch {
        throw error;
      }
    }
  }
  private async recovery(
    r: Recovery,
    t: ReturnType<AnnouncementAuthoringController['ticket']>,
  ) {
    const p = this.pending!;
    if (r.state === 'recorded') await this.settle(p, r.receipt, t);
    else if (r.state === 'cancelled') {
      if (r.requestHash !== p.requestHash)
        throw new ClientError('protocol', '取消回执不匹配');
      this.journal.discard(p);
      this.pending = null;
      this.update({
        pending: false,
        pendingId: '',
        status: '原请求已取消，请重新读取后编辑',
      });
    } else this.update({ status: '原请求尚无回执；可重试原请求或明确取消' });
  }
  private async recoverInternal(
    t: ReturnType<AnnouncementAuthoringController['ticket']>,
  ) {
    const r = await this.gateway.recover(
      this.pending!.command.clientRequestId,
      this.cancellation,
    );
    t.check();
    await this.recovery(r, t);
  }
  async recover() {
    if (this.pending)
      await this.run(async () => this.recoverInternal(this.ticket()));
  }
  async retry() {
    if (this.pending) await this.run(async () => this.send(this.ticket()));
  }
  async cancelOriginal() {
    if (!this.pending) return;
    await this.run(async () => {
      const t = this.ticket(),
        p = this.pending!,
        r = await this.gateway.cancel(
          p.command.clientRequestId,
          p.requestHash,
          this.cancellation,
        );
      t.check();
      await this.recovery(r, t);
    });
  }
  uploadTarget(slot: Slot) {
    if (
      this.disposed ||
      this.view.busy ||
      this.pending ||
      !this.row ||
      this.row.state === 'cancelled' ||
      !slots.includes(slot)
    )
      return null;
    return { announcementId: this.row.id, slot, revision: this.row.revision };
  }
  setMediaAsset(
    target: { announcementId: string; revision: number; slot: Slot },
    assetId: string,
  ) {
    if (
      this.pending ||
      this.disposed ||
      !this.row ||
      target.announcementId !== this.row.id ||
      target.revision !== this.row.revision
    )
      return;
    this.changes[target.slot] = { action: 'replace', assetId: id(assetId) };
    this.update({
      dirty: true,
      slots: this.view.slots.map((s) =>
        s.slot === target.slot ? { ...s, configured: true, changed: true } : s,
      ),
    });
  }
  removeMedia(slot: Slot) {
    if (this.pending || this.view.busy || !this.row) return;
    this.changes[slot] = { action: 'remove' };
    this.update({
      dirty: true,
      slots: this.view.slots.map((s) =>
        s.slot === slot ? { ...s, configured: false, changed: true } : s,
      ),
    });
  }
  private clear() {
    this.generation++;
    this.cancellation.cancel();
    this.cancellation = new Cancellation();
    this.pending = null;
    this.row = null;
    this.changes = {};
    this.cursor = null;
    this.update(initialAuthoringView());
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.stop();
    this.disposed = true;
  }
}
