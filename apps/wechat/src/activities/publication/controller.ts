import { ClientError, clientError } from '../../api/errors';
import type { SessionStore } from '../../auth/session';
import { Cancellation } from '../../platform/contracts';
import { activityMediaSlots } from '../media-validation';
import type { ActivityMediaSlot } from '../media-validation';
import type { ActivityMediaUploadTarget } from '../media-runtime';
import {
  decodeActivityCommand,
  decodeActivityContent,
  emptyActivityContent,
  activitySlotLabels,
  activityId,
  invalidActivityPublication,
} from './contract';
import type {
  ActivityOrganizer,
  ActivityDraft,
  ActivityChanges,
  ActivityCommand,
  ActivityReceipt,
  ActivityRecovery,
} from './contract';
import { HttpActivityPublicationGateway } from './gateway';
import { ActivityPublicationJournal } from './pending';
import type { PendingActivityCommand } from './pending';
export const initialActivityPublicationView = () => ({
  busy: false,
  loaded: false,
  id: '',
  revision: 0,
  regionId: '',
  organizers: [] as ActivityOrganizer[],
  moreOrganizers: false,
  selected: null as ActivityOrganizer | null,
  draft: null as ActivityDraft | null,
  form: emptyActivityContent(),
  pending: false,
  pendingId: '',
  review: '',
  error: '',
  status: '',
  slots: activityMediaSlots.map((slot) => ({
    slot,
    label: activitySlotLabels[slot],
    configured: false,
    changed: false,
  })),
  dirty: false,
  endAtInput: '',
});
export type ActivityPublicationView = ReturnType<
  typeof initialActivityPublicationView
>;
export class ActivityPublicationController {
  private view = initialActivityPublicationView();
  private generation = 0;
  private cancellation = new Cancellation();
  private disposed = false;
  private changes: ActivityChanges = {};
  private pending: PendingActivityCommand | null = null;
  private cursor: string | null = null;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: Pick<
      HttpActivityPublicationGateway,
      'organizers' | 'draft' | 'command' | 'recover' | 'cancel'
    >,
    private readonly journal: ActivityPublicationJournal,
    private readonly newId: () => Promise<string>,
    private readonly render: (v: ActivityPublicationView) => void,
    private readonly reconcile?: (id: string) => Promise<void>,
  ) {
    let epoch = sessions.snapshot().epoch;
    this.unsubscribe = sessions.subscribe(() => {
      if (sessions.snapshot().epoch !== epoch) {
        epoch = sessions.snapshot().epoch;
        this.clear();
        this.update({ error: '账号已变化，请重新打开活动页面' });
      }
    });
  }
  snapshot() {
    return JSON.parse(JSON.stringify(this.view)) as ActivityPublicationView;
  }
  private update(patch: Partial<ActivityPublicationView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.render(this.snapshot());
  }
  private async run(work: () => Promise<void>) {
    if (this.disposed || this.view.busy) return;
    const generation = this.generation;
    this.update({ busy: true, error: '' });
    try {
      await work();
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        const e = clientError(error);
        this.update({
          error:
            e.kind === 'storage'
              ? e.message
              : this.pending
                ? '原活动请求结果尚未确认，请恢复或取消原请求'
                : '活动数据不可用，请刷新后重试',
        });
      }
    } finally {
      if (generation === this.generation) this.update({ busy: false });
    }
  }
  private ticket() {
    const ticket = this.sessions.snapshot();
    if (!ticket.credentials) throw new ClientError('auth-required', '请先登录');
    const generation = this.generation;
    return {
      actor: ticket.credentials.accountId,
      check: () => {
        this.sessions.assertCurrent(ticket);
        if (
          this.disposed ||
          generation !== this.generation ||
          this.cancellation.isCancelled
        )
          throw new ClientError('cancelled', '活动页面已离开');
      },
    };
  }
  async load(id: string | null = null) {
    await this.run(async () => {
      const t = this.ticket();
      this.pending = this.journal.read(t.actor);
      this.update({
        pending: !!this.pending,
        pendingId: this.pending?.command.clientRequestId ?? '',
      });
      const target =
        this.pending?.activityId ?? id ?? this.journal.draftId(t.actor);
      if (target) {
        this.update({ id: target });
        if (this.pending) {
          await this.recoverInternal(t);
          return;
        }
        await this.readDraft(target, t);
      } else {
        const page = await this.gateway.organizers(this.cancellation);
        t.check();
        this.cursor = page.nextCursor;
        this.update({
          organizers: page.items,
          regionId: page.regionId,
          moreOrganizers: !!page.nextCursor,
          loaded: true,
        });
      }
    });
  }
  async moreOrganizers() {
    if (!this.cursor || this.view.id || this.pending) return;
    await this.run(async () => {
      const t = this.ticket(),
        page = await this.gateway.organizers(this.cancellation, this.cursor!);
      t.check();
      this.cursor = page.nextCursor;
      this.update({
        organizers: [...this.view.organizers, ...page.items],
        moreOrganizers: !!page.nextCursor,
      });
    });
  }
  chooseOrganizer(id: string) {
    if (this.view.busy || this.pending || this.view.id) return;
    const selected = this.view.organizers.find((o) => o.organizationId === id);
    if (selected) this.update({ selected, dirty: true });
  }
  setField(field: string, value: string) {
    if (
      this.view.busy ||
      this.pending ||
      this.view.draft?.state === 'published' ||
      ![
        'title',
        'description',
        'activityTime',
        'activityLocation',
        'endAt',
      ].includes(field)
    )
      return;
    if (field === 'endAt') {
      this.update({ endAtInput: value, dirty: true, error: '' });
      return;
    }
    try {
      const form = decodeActivityContent({
        ...this.view.form,
        [field]: field === 'endAt' ? value.trim() || null : value,
      });
      this.update({ form, dirty: true, error: '' });
    } catch {
      this.update({ error: '请检查字段长度及结束时间格式' });
    }
  }
  toggleType(type: string) {
    if (
      this.view.busy ||
      this.pending ||
      this.view.draft?.state === 'published' ||
      !['reward', 'online', 'offline'].includes(type)
    )
      return;
    const types = this.view.form.types.includes(type as never)
      ? this.view.form.types.filter((t) => t !== type)
      : [...this.view.form.types, type];
    this.update({
      form: decodeActivityContent({ ...this.view.form, types }),
      dirty: true,
    });
  }
  setQr(value: boolean) {
    if (
      !this.view.busy &&
      !this.pending &&
      this.view.draft?.state !== 'published'
    )
      this.update({
        form: { ...this.view.form, showOrganizerQr: value },
        dirty: true,
      });
  }
  uploadTarget(slot: ActivityMediaSlot): ActivityMediaUploadTarget | null {
    if (
      this.view.busy ||
      this.pending ||
      !this.view.draft ||
      this.view.draft.state !== 'draft'
    )
      return null;
    return { activityId: this.view.id, revision: this.view.revision, slot };
  }
  setMediaAsset(target: ActivityMediaUploadTarget, asset: string) {
    if (
      this.view.busy ||
      this.pending ||
      target.activityId !== this.view.id ||
      target.revision !== this.view.revision
    )
      return;
    this.changes = {
      ...this.changes,
      [target.slot]: { action: 'replace', assetId: activityId(asset) },
    };
    this.refreshSlots();
    this.update({ dirty: true });
  }
  removeMedia(slot: ActivityMediaSlot) {
    if (!this.uploadTarget(slot)) return;
    this.changes = { ...this.changes, [slot]: { action: 'remove' } };
    this.refreshSlots();
    this.update({ dirty: true });
  }
  private refreshSlots() {
    this.update({
      slots: activityMediaSlots.map((slot) => ({
        slot,
        label: activitySlotLabels[slot],
        configured:
          this.changes[slot]?.action === 'replace' ||
          (this.changes[slot]?.action !== 'remove' &&
            !!this.view.draft?.mediaBindings[slot]),
        changed: !!this.changes[slot],
      })),
    });
  }
  async create() {
    if (this.pending || this.view.id || !this.view.selected) return;
    await this.run(async () => {
      const t = this.ticket(),
        id = await this.newId(),
        key = await this.newId();
      t.check();
      await this.send(t, id, {
        action: 'create',
        clientRequestId: key,
        expectedRevision: 0,
        organization: {
          source: 'managed',
          organizationId: this.view.selected!.organizationId,
        },
        organizationRevision: this.view.selected!.revision,
        content: decodeActivityContent({
          ...this.view.form,
          endAt: this.view.endAtInput.trim() || null,
        }),
      });
    });
  }
  async save() {
    if (this.pending || !this.view.draft || this.view.draft.state !== 'draft')
      return;
    await this.run(async () => {
      const t = this.ticket(),
        key = await this.newId();
      t.check();
      await this.send(t, this.view.id, {
        action: 'save',
        clientRequestId: key,
        expectedRevision: this.view.revision,
        content: decodeActivityContent({
          ...this.view.form,
          endAt: this.view.endAtInput.trim() || null,
        }),
        mediaChanges: this.changes,
      });
    });
  }
  async discardDraft() {
    if (this.pending || !this.view.draft || this.view.draft.state !== 'draft')
      return;
    await this.run(async () => {
      const t = this.ticket(),
        key = await this.newId();
      t.check();
      await this.send(t, this.view.id, {
        action: 'cancel_draft',
        clientRequestId: key,
        expectedRevision: this.view.revision,
      });
    });
  }
  async publish() {
    if (this.pending || !this.view.draft || this.view.draft.state !== 'draft')
      return;
    if (this.view.dirty) {
      this.update({ error: '请先保存内容和图片，再提交审核' });
      return;
    }
    const c = this.view.form;
    if (
      !c.title.trim() ||
      !c.types.length ||
      !this.view.draft.mediaBindings.cover ||
      (c.types.includes('offline') &&
        (!c.activityTime.trim() || !c.activityLocation.trim()))
    ) {
      this.update({ error: '请填写标题、类型、封面；线下活动还需时间和地点' });
      return;
    }
    await this.run(async () => {
      const t = this.ticket(),
        key = await this.newId();
      t.check();
      await this.send(t, this.view.id, {
        action: 'publish',
        clientRequestId: key,
        expectedRevision: this.view.revision,
      });
    });
  }
  private async send(
    t: ReturnType<ActivityPublicationController['ticket']>,
    id: string,
    raw: ActivityCommand,
  ) {
    const command = decodeActivityCommand(raw);
    this.pending = this.journal.write(t.actor, id, command);
    this.update({ id, pending: true, pendingId: command.clientRequestId });
    const result = await this.gateway.command(id, command, this.cancellation);
    t.check();
    if ('state' in result) await this.handleRecovery(result, t);
    else await this.settle(result, t);
  }
  private async settle(
    receipt: ActivityReceipt,
    t: ReturnType<ActivityPublicationController['ticket']>,
  ) {
    const p = this.pending;
    if (!p) invalidActivityPublication();
    this.journal.settle(p, receipt);
    this.pending = null;
    this.changes = {};
    this.update({
      pending: false,
      pendingId: '',
      review: '',
      dirty: false,
      status:
        receipt.outcome === 'draft_cancelled'
          ? '未发布草稿已放弃'
          : receipt.outcome === 'published'
            ? '活动已发布'
            : receipt.outcome === 'created'
              ? '草稿已创建，请上传封面'
              : '内容与图片已保存',
    });
    await this.reconcile?.(receipt.activityId);
    t.check();
    if (receipt.outcome === 'draft_cancelled') {
      const page = await this.gateway.organizers(this.cancellation);
      t.check();
      this.cursor = page.nextCursor;
      this.update({
        ...initialActivityPublicationView(),
        loaded: true,
        organizers: page.items,
        regionId: page.regionId,
        moreOrganizers: !!page.nextCursor,
        status: '未发布草稿已放弃',
      });
    } else await this.readDraft(receipt.activityId, t);
  }
  private async readDraft(
    id: string,
    t: ReturnType<ActivityPublicationController['ticket']>,
  ) {
    const draft = await this.gateway.draft(id, this.cancellation);
    t.check();
    this.update({
      id: draft.id,
      revision: draft.revision,
      regionId: draft.regionId,
      draft,
      form: draft.content,
      endAtInput: draft.content.endAt ?? '',
      loaded: true,
      dirty: false,
    });
    this.refreshSlots();
  }
  private async handleRecovery(
    result: ActivityRecovery,
    t: ReturnType<ActivityPublicationController['ticket']>,
  ) {
    const p = this.pending;
    if (!p || result.requestId !== p.command.clientRequestId)
      invalidActivityPublication();
    if (result.state === 'recorded') return this.settle(result.receipt, t);
    if (result.state === 'cancelled') {
      if (result.requestHash !== p.requestHash) invalidActivityPublication();
      this.journal.discard(p);
      this.pending = null;
      this.update({
        pending: false,
        pendingId: '',
        review: '',
        status: '原活动请求已取消',
      });
      if (p.command.action !== 'create') await this.readDraft(p.activityId, t);
      else {
        this.journal.rememberDraft(t.actor, null);
        const page = await this.gateway.organizers(this.cancellation);
        t.check();
        this.cursor = page.nextCursor;
        this.update({
          id: '',
          loaded: true,
          organizers: page.items,
          moreOrganizers: !!page.nextCursor,
          regionId: page.regionId,
        });
      }
      return;
    }
    if (result.state === 'pending') {
      if (result.requestHash !== p.requestHash) invalidActivityPublication();
      this.update({
        pending: true,
        review: result.review,
        status:
          result.review === 'pending'
            ? '正在等待内容审核'
            : result.review === 'ready'
              ? '审核通过，可恢复原请求完成发布'
              : result.review === 'rejected'
                ? '内容审核未通过，请取消原请求后修改'
                : '审核暂不可用，请保留原请求',
      });
      return;
    }
    this.update({ status: '原请求尚未登记，可重试或取消原请求' });
  }
  private async recoverInternal(
    t: ReturnType<ActivityPublicationController['ticket']>,
  ) {
    const p = this.pending;
    if (!p) return;
    const result = await this.gateway.recover(
      p.command.clientRequestId,
      this.cancellation,
    );
    t.check();
    await this.handleRecovery(result, t);
    if (result.state === 'pending' && result.review === 'ready') {
      const receipt = await this.gateway.command(
        p.activityId,
        p.command,
        this.cancellation,
      );
      t.check();
      if ('state' in receipt) await this.handleRecovery(receipt, t);
      else await this.settle(receipt, t);
    }
  }
  async recover() {
    await this.run(async () => {
      const t = this.ticket();
      this.pending = this.journal.read(t.actor);
      if (this.pending) {
        this.update({
          id: this.pending.activityId,
          pending: true,
          pendingId: this.pending.command.clientRequestId,
        });
        await this.recoverInternal(t);
      }
    });
  }
  async retry() {
    if (!this.pending) return;
    await this.run(async () => {
      const t = this.ticket(),
        p = this.pending!;
      const result = await this.gateway.command(
        p.activityId,
        p.command,
        this.cancellation,
      );
      t.check();
      if ('state' in result) await this.handleRecovery(result, t);
      else await this.settle(result, t);
    });
  }
  async cancelOriginal() {
    if (!this.pending) return;
    await this.run(async () => {
      const t = this.ticket(),
        p = this.pending!,
        result = await this.gateway.cancel(
          p.command.clientRequestId,
          p.requestHash,
          this.cancellation,
        );
      t.check();
      await this.handleRecovery(result, t);
    });
  }
  clear() {
    this.generation++;
    this.cancellation.cancel();
    this.cancellation = new Cancellation();
    this.pending = null;
    this.changes = {};
    this.cursor = null;
    this.view = initialActivityPublicationView();
    this.update({});
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.unsubscribe();
    this.disposed = true;
  }
}
