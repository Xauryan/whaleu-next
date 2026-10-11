import { ClientError, clientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import { Cancellation } from '../platform/contracts';
import type { ProfileGateway } from '../profile/gateway';
import type { Campus } from '../profile/contract';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import { friendlyError } from '../pages/login/controller';
import { HttpStudentVerificationGateway } from './student-gateway';
import { StudentCommandJournal } from './student-pending';
import type { PendingStudentCommand } from './student-pending';
import { studentCommandHash, studentLabels } from './student-contract';
import type {
  StudentApplication,
  StudentNotice,
  StudentReceipt,
} from './student-contract';
import type { VerificationEvidenceUploadDescriptor } from './evidence-contract';
import type {
  VerificationEvidenceUploader,
  VerificationEvidenceReader,
  createVerificationEvidenceRuntime,
} from './evidence-runtime';
export type StudentEvidenceRuntime = ReturnType<
  typeof createVerificationEvidenceRuntime
>;
export interface StudentView {
  busy: boolean;
  loaded: boolean;
  hasSession: boolean;
  error: string;
  message: string;
  application: StudentApplication | null;
  stateLabel: string;
  canApply: boolean;
  campuses: readonly Campus[];
  campusQuery: string;
  selectedCampusId: string;
  evidenceReady: boolean;
  evidenceSrc: string;
  evidenceMessage: string;
  pending: boolean;
  confirmation: string;
  management: 'none' | 'fixed' | 'global';
  regionId: string;
  regionName: string;
  items: readonly StudentApplication[];
  page: number;
  hasNext: boolean;
  reason: string;
  notices: readonly StudentNotice[];
}
function studentError(error: unknown) {
  const failure = clientError(error);
  const messages: Record<string, string> = {
    STUDENT_VERIFICATION_ALREADY_VERIFIED:
      '已有通过的认证或当前有效归属；如需换校、续期或处理撤销，请联系学校管理员',
    STUDENT_VERIFICATION_EXPIRED: '本次材料已过期，请刷新后使用新材料重新申请',
    STUDENT_VERIFICATION_SELF_REVIEW:
      '不能审核自己的申请，请由另一位被授权的学校管理员审核',
    STUDENT_VERIFICATION_CONFLICT: '申请版本或原请求已改变，请查询原请求并刷新',
    STUDENT_VERIFICATION_CANCELLED: '原请求已关闭，可重新开始',
    VERIFICATION_UNAVAILABLE:
      '当前认证来源或资格暂无法确认，请刷新；仍不可用时联系学校管理员',
  };
  return messages[failure.details.serverCode ?? ''] ?? friendlyError(failure);
}
export const initialStudentView = (): StudentView => ({
  busy: false,
  loaded: false,
  hasSession: false,
  error: '',
  message: '',
  application: null,
  stateLabel: '',
  canApply: false,
  campuses: [],
  campusQuery: '',
  selectedCampusId: '',
  evidenceReady: false,
  evidenceSrc: '',
  evidenceMessage: '',
  pending: false,
  confirmation: '',
  management: 'none',
  regionId: '',
  regionName: '',
  items: [],
  page: 1,
  hasNext: false,
  reason: '',
  notices: [],
});
export interface StudentControllerOptions {
  sessions: SessionStore;
  gateway: HttpStudentVerificationGateway;
  profiles: ProfileGateway;
  journal: StudentCommandJournal;
  newRequestId: () => Promise<string>;
  media: StudentEvidenceRuntime;
  privateViews: PrivateViewLifecycle;
  render: (view: StudentView) => void;
}
/** All private facts and inline files are transient and bound to account/login epoch. */
export class StudentVerificationController {
  private queueCursor: string | null = null;
  private nextCursor: string | null = null;
  private cursorHistory: (string | null)[] = [];
  private view = initialStudentView();
  private readonly owner: SessionTicket;
  private generation = 0;
  private disposed = false;
  private cancellation: Cancellation | null = null;
  private readonly unsubscribe: () => void;
  private readonly visibility: () => void;
  private readonly uploader: VerificationEvidenceUploader;
  private readonly reader: VerificationEvidenceReader;
  private evidence: VerificationEvidenceUploadDescriptor | null = null;
  constructor(
    private readonly o: StudentControllerOptions,
    readonly mode: 'own' | 'review' | 'notices',
    private readonly requested: {
      applicationId?: string;
      regionId?: string;
    } = {},
  ) {
    this.owner = o.sessions.snapshot();
    this.unsubscribe = o.sessions.subscribe(() => {
      const n = o.sessions.snapshot();
      if (
        n.epoch !== this.owner.epoch ||
        n.credentials?.accountId !== this.owner.credentials?.accountId
      )
        this.close('登录账号已改变，认证材料已清除');
    });
    this.visibility = o.privateViews.subscribe(() =>
      this.close('已离开前台，认证材料已清除'),
    );
    this.uploader = o.media.createUploader((v) => {
      if (!this.disposed) this.update({ evidenceMessage: v.message });
    });
    this.reader = o.media.createReader((v) => {
      if (!this.disposed)
        this.update({ evidenceSrc: v.src, evidenceMessage: v.message });
    });
    this.update({ hasSession: !!this.owner.credentials });
  }
  private update(patch: Partial<StudentView>) {
    if (this.disposed) return;
    this.view = Object.freeze({ ...this.view, ...patch });
    this.o.render(this.view);
  }
  private current(g: number) {
    if (this.disposed || g !== this.generation) return false;
    try {
      this.o.sessions.assertCurrent(this.owner);
      return true;
    } catch {
      return false;
    }
  }
  private async run(work: (cancel: Cancellation) => Promise<void>) {
    if (this.disposed || this.view.busy) return;
    const generation = this.generation,
      cancel = new Cancellation();
    this.cancellation = cancel;
    this.update({ busy: true, error: '', confirmation: '' });
    try {
      this.o.sessions.assertCurrent(this.owner);
      if (!this.owner.credentials)
        throw new ClientError('auth-required', '请先登录');
      await work(cancel);
    } catch (error) {
      if (this.current(generation)) {
        if (this.mode === 'review') {
          this.setApplication(null);
          this.update({ items: [], reason: '', confirmation: '' });
        }
        this.update({
          error: studentError(error),
          message: '操作未确认，请查询原请求后继续',
        });
      }
    } finally {
      if (this.current(generation)) {
        this.cancellation = null;
        this.update({ busy: false, pending: !!this.pending() });
      }
    }
  }
  private pending() {
    const actor = this.owner.credentials?.accountId;
    return actor ? this.o.journal.read(actor) : null;
  }
  private setApplication(application: StudentApplication | null) {
    if (
      this.view.application?.id !== application?.id ||
      this.view.application?.revision !== application?.revision
    ) {
      this.reader.clear();
      this.uploader.clear();
      this.evidence = null;
      this.update({ reason: '', confirmation: '' });
    }
    this.update({
      application,
      stateLabel: application ? studentLabels[application.state] : '尚无申请',
      evidenceReady: !!this.evidence,
      selectedCampusId: application?.campusId ?? this.view.selectedCampusId,
    });
  }
  private async refresh(cancel: Cancellation) {
    if (this.mode === 'own') {
      const result = await this.o.gateway.own(cancel);
      this.o.sessions.assertCurrent(this.owner);
      let application = result.application;
      if (this.requested.applicationId)
        application = await this.o.gateway.detail(
          this.requested.applicationId,
          cancel,
        );
      this.setApplication(application);
      this.update({ canApply: result.canApply, loaded: true });
    } else if (this.mode === 'review') {
      const cap = await this.o.gateway.capabilities(cancel);
      this.o.sessions.assertCurrent(this.owner);
      if (
        cap.management === 'none' ||
        (cap.region && cap.region.id !== this.view.regionId) ||
        cap.management !== this.view.management
      ) {
        this.setApplication(null);
        this.queueCursor = null;
        this.nextCursor = null;
        this.cursorHistory = [];
        this.update({
          items: [],
          regionId: '',
          regionName: '',
          page: 1,
          reason: '',
        });
      }
      this.update({
        management: cap.management,
        regionId: cap.region?.id ?? this.view.regionId,
        regionName: cap.region?.name ?? this.view.regionName,
      });
      if (this.requested.regionId && cap.management === 'global')
        this.update({ regionId: this.requested.regionId });
      if (this.view.regionId) {
        const result = await this.o.gateway.queue(
          this.view.regionId,
          this.view.page,
          cancel,
          this.queueCursor,
        );
        this.o.sessions.assertCurrent(this.owner);
        this.nextCursor = result.nextCursor;
        this.update({
          items: result.items,
          page: result.page,
          hasNext: result.hasNext,
        });
      }
      if (this.requested.applicationId && this.view.regionId) {
        this.setApplication(
          await this.o.gateway.detail(
            this.requested.applicationId,
            cancel,
            this.view.regionId,
          ),
        );
      } else if (this.view.application && this.view.regionId)
        this.setApplication(
          await this.o.gateway.detail(
            this.view.application.id,
            cancel,
            this.view.regionId,
          ),
        );
      this.update({ loaded: true });
    } else {
      const result = await this.o.gateway.notices(this.view.page, cancel);
      this.o.sessions.assertCurrent(this.owner);
      this.update({
        notices: result.items,
        page: result.page,
        hasNext: result.hasNext,
        loaded: true,
      });
    }
  }
  load() {
    if (this.mode === 'review') {
      this.setApplication(null);
      this.update({ items: [], evidenceSrc: '', reason: '' });
    }
    return this.run(async (cancel) => {
      await this.o.media.reconcile();
      await this.refresh(cancel);
      this.update({ pending: !!this.pending(), message: '已查询当前状态' });
    });
  }
  query(value: string) {
    if (!this.view.busy) this.update({ campusQuery: value.slice(0, 100) });
  }
  searchCampuses() {
    return this.run(async (cancel) => {
      const page = await this.o.profiles.campuses(
        { q: this.view.campusQuery, district: '', page: 1, pageSize: 20 },
        cancel,
      );
      this.o.sessions.assertCurrent(this.owner);
      this.update({ campuses: page.items.filter((c) => c.isActive) });
    });
  }
  chooseCampus(id: string) {
    if (this.view.busy) return;
    const campus = this.view.campuses.find((c) => c.id === id && c.isActive);
    if (!campus) return;
    this.update({ selectedCampusId: id });
    if (this.mode === 'review' && this.view.management === 'global') {
      delete this.requested.regionId;
      delete this.requested.applicationId;
      this.setApplication(null);
      this.queueCursor = null;
      this.nextCursor = null;
      this.cursorHistory = [];
      this.update({
        items: [],
        reason: '',
        regionId: '',
        regionName: '',
        page: 1,
      });
      void this.run(async (cancel) => {
        const regions = await this.o.gateway.regions(id, cancel);
        this.o.sessions.assertCurrent(this.owner);
        if (!regions[0])
          throw new ClientError('protocol', '该校园暂未开放审核地区');
        this.update({
          regionId: regions[0].id,
          regionName: regions[0].name,
          page: 1,
          application: null,
        });
        await this.refresh(cancel);
      });
    }
  }
  private async command(
    operation: PendingStudentCommand['operation'],
    applicationId: string | null,
    parts: (key: string) => unknown[],
    send: (key: string, cancel: Cancellation) => Promise<StudentReceipt>,
    cancel: Cancellation,
  ) {
    if (this.pending())
      throw new ClientError('business', '请先查询或关闭原请求');
    const actor = this.owner.credentials!.accountId,
      key = await this.o.newRequestId();
    this.o.sessions.assertCurrent(this.owner);
    const record = {
      actor,
      requestId: key,
      requestHash: studentCommandHash(parts(key)),
      applicationId,
      operation,
    };
    this.o.journal.save(record);
    this.update({ pending: true });
    const result = await send(key, cancel);
    this.o.sessions.assertCurrent(this.owner);
    if (cancel.isCancelled) throw new ClientError('cancelled', '已取消');
    if (
      result.requestId !== key ||
      (applicationId && result.applicationId !== applicationId)
    )
      throw new ClientError('protocol', '原请求响应不匹配');
    this.o.journal.clear(record);
    if (operation === 'reserve') delete this.requested.applicationId;
    await this.refresh(cancel);
    this.update({ message: '操作已记录，已读取最新状态' });
  }
  prepare() {
    return this.run(async (cancel) => {
      if (!this.view.canApply || !this.view.selectedCampusId) return;
      const campusId = this.view.selectedCampusId;
      await this.command(
        'reserve',
        null,
        (key) => ['reserve', { clientRequestId: key, campusId }],
        (key, c) =>
          this.o.gateway.reserve({ clientRequestId: key, campusId }, c),
        cancel,
      );
    });
  }
  async pickEvidence(recover = false) {
    if (
      this.disposed ||
      this.view.busy ||
      !this.view.application ||
      this.view.application.state !== 'draft'
    )
      return;
    const app = this.view.application,
      g = this.generation;
    this.update({ busy: true, error: '' });
    try {
      const target = { applicationId: app.id, revision: app.revision };
      const result = await (recover
        ? this.uploader.recover(target)
        : this.uploader.pick(target));
      if (
        this.current(g) &&
        this.view.application?.id === app.id &&
        this.view.application?.revision === app.revision
      ) {
        this.evidence = result;
        this.update({ evidenceReady: !!result });
      }
    } finally {
      if (this.current(g)) this.update({ busy: false });
    }
  }
  requestSubmit() {
    if (
      this.view.application?.state === 'draft' &&
      this.evidence &&
      !this.pending()
    )
      this.update({ confirmation: 'submit' });
  }
  requestWithdraw() {
    if (
      this.view.application &&
      ['draft', 'pending'].includes(this.view.application.state) &&
      !this.pending()
    )
      this.update({ confirmation: 'withdraw' });
  }
  setReason(value: string) {
    if (!this.view.busy) this.update({ reason: value.slice(0, 200) });
  }
  requestDecision(decision: 'approved' | 'rejected') {
    if (
      this.view.application?.state !== 'pending' ||
      this.view.busy ||
      this.pending()
    )
      return;
    if (decision === 'rejected' && !this.view.reason.trim()) {
      this.update({ error: '请填写不超过200字的拒绝原因' });
      return;
    }
    this.update({ confirmation: decision });
  }
  dismiss() {
    this.update({ confirmation: '' });
  }
  confirm() {
    const operation = this.view.confirmation,
      app = this.view.application,
      evidence = this.evidence,
      region = this.view.regionId,
      reason = this.view.reason.trim();
    return this.run(async (cancel) => {
      if (!app) return;
      if (operation === 'submit' && evidence)
        await this.command(
          'submit',
          app.id,
          (key) => [
            'submit',
            app.id,
            { clientRequestId: key, expectedRevision: app.revision, evidence },
          ],
          (key, c) =>
            this.o.gateway.submit(
              app.id,
              {
                clientRequestId: key,
                expectedRevision: app.revision,
                evidence,
              },
              c,
            ),
          cancel,
        );
      else if (operation === 'withdraw') {
        await this.command(
          'withdraw',
          app.id,
          (key) => [
            'withdraw',
            app.id,
            { clientRequestId: key, expectedRevision: app.revision },
          ],
          (key, c) =>
            this.o.gateway.withdraw(
              app.id,
              { clientRequestId: key, expectedRevision: app.revision },
              c,
            ),
          cancel,
        );
        await this.o.media.reconcile(true);
      } else if (
        (operation === 'approved' || operation === 'rejected') &&
        region
      ) {
        const payload = (key: string) =>
          operation === 'approved'
            ? {
                clientRequestId: key,
                expectedRevision: app.revision,
                decision: 'approved' as const,
              }
            : {
                clientRequestId: key,
                expectedRevision: app.revision,
                decision: 'rejected' as const,
                reason,
              };
        await this.command(
          'decide',
          app.id,
          (key) => ['decide', region, app.id, payload(key)],
          (key, c) => this.o.gateway.decide(region, app.id, payload(key), c),
          cancel,
        );
        this.reader.clear();
        this.update({ reason: '' });
      }
    });
  }
  recover(close = false) {
    return this.run(async (cancel) => {
      const p = this.pending();
      if (!p) return;
      const result = close
        ? await this.o.gateway.cancelRequest(p.requestId, p.requestHash, cancel)
        : await this.o.gateway.recover(p.requestId, cancel);
      this.o.sessions.assertCurrent(this.owner);
      if (result.requestId !== p.requestId)
        throw new ClientError('protocol', '恢复结果不匹配');
      if (result.state === 'recorded' || result.state === 'cancelled')
        this.o.journal.clear(p);
      if (result.receipt && p.operation === 'reserve')
        this.requested.applicationId = result.receipt.applicationId;
      await this.refresh(cancel);
      this.update({
        message:
          result.state === 'not_recorded'
            ? '原请求尚未落库，可继续查询或关闭原请求后重试'
            : '已恢复原请求结果',
      });
    });
  }
  select(id: string) {
    this.setApplication(null);
    return this.run(async (cancel) => {
      if (this.mode !== 'review' || !this.view.regionId) return;
      this.setApplication(
        await this.o.gateway.detail(id, cancel, this.view.regionId),
      );
    });
  }
  preview() {
    const app = this.view.application;
    if (
      this.disposed ||
      this.view.busy ||
      !app?.evidenceAvailable ||
      !app.evidenceRevision
    )
      return;
    return this.reader.load({
      applicationId: app.id,
      revision: app.evidenceRevision,
      reviewRegionId: this.mode === 'review' ? this.view.regionId : null,
    });
  }
  clearEvidence() {
    this.reader.clear();
  }
  page(delta: number) {
    if (
      this.view.busy ||
      (delta > 0 && !this.view.hasNext) ||
      (delta < 0 && this.view.page <= 1)
    )
      return;
    if (this.mode === 'review') {
      if (delta > 0) {
        this.cursorHistory.push(this.queueCursor);
        this.queueCursor = this.nextCursor;
      } else this.queueCursor = this.cursorHistory.pop() ?? null;
      this.setApplication(null);
    }
    this.update({ page: this.view.page + delta });
    void this.load();
  }
  async noticeTarget(
    id: string,
  ): Promise<{ applicationId: string; regionId: string | null } | null> {
    let target: { applicationId: string; regionId: string | null } | null =
      null;
    await this.run(async (cancel) => {
      const result = await this.o.gateway.noticeTarget(id, cancel);
      this.o.sessions.assertCurrent(this.owner);
      if (result.status !== 'available')
        throw new ClientError('forbidden', '当前通知入口不可用');
      target = result.target;
    });
    return target;
  }
  readNotice(id: string) {
    return this.run(async (cancel) => {
      await this.o.gateway.noticeRead(id, cancel);
      await this.refresh(cancel);
    });
  }
  cleanup() {
    return this.run(async (cancel) => {
      await this.o.media.reconcile(true);
      await this.refresh(cancel);
      this.evidence = null;
      this.update({
        evidenceReady: false,
        message: '已关闭本人未绑定的材料请求',
      });
    });
  }
  private close(message: string) {
    this.generation++;
    this.cancellation?.cancel();
    this.reader?.clear();
    this.uploader?.clear();
    this.evidence = null;
    this.update({ ...initialStudentView(), message });
    this.disposed = true;
  }
  dispose() {
    if (!this.disposed) this.close('认证页面已关闭');
    this.unsubscribe();
    this.visibility();
    this.reader.dispose();
    this.uploader.dispose();
  }
}
