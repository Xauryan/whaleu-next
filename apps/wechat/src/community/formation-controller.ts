import { ClientError } from '../api/errors';
import type { Cancellation, Clock } from '../platform/contracts';
import { systemClock } from '../platform/clock';
import { boundedText, type Post } from './contract';
import { tradingText } from './trading-contract';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  reasonMessage,
  type CommunityView,
} from './controller';
import {
  checkFormationCreator,
  decodeFormation,
  decodeFormationContactView,
  decodeFormationJoinIntent,
  decodeFormationReceipt,
  decodeOwnFormationMembership,
  formationContactDisclosure,
  type Formation,
  type FormationContacts,
  type FormationReceipt,
} from './formation-contract';
import type { PendingFormationJoin } from './formation-pending';
import type { CommunityRuntime } from './runtime';
export interface FormationView extends CommunityView {
  readonly active: boolean;
  readonly formation: Formation | null;
  readonly loaded: boolean;
  readonly canJoin: boolean;
  readonly frozen: boolean;
  readonly contacts: FormationContacts;
  readonly contactConsent: boolean;
  readonly disclosure: string;
  readonly recoveryPostId: string;
  readonly blocker: string;
  readonly receiptStatus: string;
  readonly ownStatus: string;
}
const emptyContacts = (): FormationContacts => ({
  wechat: '',
  qq: '',
  phone: '',
});
export const initialFormationView = (): FormationView => ({
  ...initialCommunityView(),
  active: false,
  formation: null,
  loaded: false,
  canJoin: false,
  frozen: false,
  contacts: emptyContacts(),
  contactConsent: false,
  disclosure: formationContactDisclosure,
  recoveryPostId: '',
  blocker: '',
  receiptStatus: '',
  ownStatus: '',
});
/** One immutable account/origin join intent; receipt recovery never fetches a hidden parent or contacts. */
export class FormationController extends CommunityController<FormationView> {
  private parent: Post | null = null;
  private pending: PendingFormationJoin | null = null;
  private expectedMembership: string | null = null;
  constructor(
    runtime: CommunityRuntime,
    private readonly postId: string,
    render: (view: FormationView) => void,
    private readonly onChanged: () => void = () => undefined,
  ) {
    super(runtime, initialFormationView, render);
  }
  protected override resetPrivate(): void {
    this.parent = null;
    this.pending = null;
    this.expectedMembership = null;
  }
  private show(attempt: PendingFormationJoin): void {
    this.pending = attempt;
    // Do not render stored contacts while the parent is unavailable; recovery only needs its request identity.
    this.update({
      active: true,
      frozen: true,
      canJoin: false,
      contacts: emptyContacts(),
      contactConsent: false,
      recoveryPostId: attempt.postId,
      blocker:
        '原加入请求结果待确认。联系方式与请求编号保持不变，只能查询或重试原请求',
      status: '加入结果待确认',
    });
  }
  private restore(): boolean {
    const accountId = this.accountId();
    if (!accountId) return false;
    try {
      this.pending = this.runtime.pendingFormations.load(accountId);
      if (this.pending) this.show(this.pending);
      return true;
    } catch (error) {
      this.update({
        active: true,
        frozen: true,
        canJoin: false,
        error: communityError(error),
        blocker: '无法读取原加入记录，禁止新建请求',
      });
      return false;
    }
  }
  async load(post: Post | null): Promise<void> {
    this.stop();
    this.parent =
      post?.id === this.postId && post.component.kind === 'formation'
        ? post
        : null;
    this.pending = null;
    this.update({
      active: !!this.parent,
      formation: null,
      loaded: false,
      busy: false,
      canJoin: false,
      frozen: false,
      contacts: emptyContacts(),
      contactConsent: false,
      recoveryPostId: '',
      blocker: '',
      error: '',
    });
    if (!this.restore() || !this.parent || !this.available()) return;
    const parent = this.parent;
    await this.run(
      (cancel) => this.runtime.gateway!.formation(this.postId, cancel),
      (raw) => {
        const formation = decodeFormation(raw);
        if (
          formation.postId !== this.postId ||
          parent.component.kind !== 'formation' ||
          formation.id !== parent.component.formation.id
        )
          throw new ClientError('protocol', 'Formation parent mismatch');
        checkFormationCreator(formation, parent.author);
        if (
          this.expectedMembership &&
          (!formation.viewer.isMember ||
            !formation.members.some(
              (m) => m.id === this.expectedMembership && m.viewer.isSelf,
            ))
        )
          throw new ClientError('protocol', 'Committed membership missing');
        this.expectedMembership = null;
        if (!this.restore()) return;
        this.update({
          active: true,
          formation,
          loaded: true,
          canJoin: !this.pending && formation.viewer.canJoin,
          blocker: this.pending
            ? this.view.blocker
            : reasonMessageForFormation(formation),
          status: formation.viewer.isMember
            ? '你已加入组队'
            : formation.status === 'full'
              ? '组队已满员'
              : '组队已加载',
        });
      },
      () =>
        this.update({
          formation: null,
          loaded: false,
          canJoin: false,
          contacts: emptyContacts(),
          contactConsent: false,
        }),
    );
  }
  setContact(field: string, value: string): void {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.canJoin ||
      !['wechat', 'qq', 'phone'].includes(field) ||
      !this.restore() ||
      this.pending
    )
      return;
    if (!boundedText(value, 0, 10000)) {
      this.update({
        contactConsent: false,
        error: '联系方式过长或包含不支持的字符，请自行修改',
      });
      return;
    }
    this.update({
      contacts: { ...this.view.contacts, [field]: value },
      contactConsent: false,
      error: '',
    });
  }
  setConsent(value: boolean): void {
    if (
      !this.view.busy &&
      !this.view.frozen &&
      this.view.canJoin &&
      this.restore() &&
      !this.pending
    )
      this.update({ contactConsent: value });
  }
  async join(): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.canJoin ||
      !this.view.contactConsent ||
      !this.available() ||
      !this.restore() ||
      this.pending
    )
      return;
    const limits = { wechat: 100, qq: 50, phone: 20 },
      labels = { wechat: '微信', qq: 'QQ', phone: '电话' };
    for (const field of ['wechat', 'qq', 'phone'] as const) {
      if (
        !tradingText(this.view.contacts[field].trim(), limits[field], false)
      ) {
        this.update({
          error: `${labels[field]}格式无效或超过 ${limits[field]} 个 UTF-8 字节，请自行修改`,
        });
        return;
      }
    }
    if (!Object.values(this.view.contacts).some((value) => value.trim())) {
      this.update({ error: '请填写至少一种你愿意向成员分享的联系方式' });
      return;
    }
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot(),
      contacts = { ...this.view.contacts };
    let settled = false;
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const payload = decodeFormationJoinIntent({
          clientRequestId,
          contacts,
          contactSharing: 'members_v1',
        });
        const attempt = this.runtime.pendingFormations.freeze({
          version: 1,
          accountId,
          postId: this.postId,
          payload,
        });
        this.show(attempt);
        return this.dispatch(attempt, cancel);
      },
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      () => {
        if (this.pending) this.show(this.pending);
      },
    );
    if (settled && this.parent) await this.load(this.parent);
  }
  private dispatch(
    attempt: PendingFormationJoin,
    cancel: Cancellation,
  ): Promise<FormationReceipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    if (
      JSON.stringify(this.runtime.pendingFormations.load(attempt.accountId)) !==
      JSON.stringify(attempt)
    )
      throw new ClientError('storage', 'Pending join changed');
    return this.runtime.gateway!.joinFormation(
      attempt.postId,
      attempt.payload,
      cancel,
    );
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || !this.pending)
      return;
    const attempt = this.pending;
    let settled = false;
    await this.run(
      (cancel) =>
        retry
          ? this.dispatch(attempt, cancel)
          : this.runtime.gateway!.formationReceipt(
              attempt.payload.clientRequestId,
              cancel,
            ),
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      () => this.show(attempt),
    );
    if (settled && this.parent) await this.load(this.parent);
  }
  private settle(raw: FormationReceipt): void {
    const attempt = this.pending;
    if (!attempt || attempt.accountId !== this.accountId())
      throw new ClientError('protocol', 'Missing original join');
    const receipt = decodeFormationReceipt(raw);
    this.runtime.pendingFormations.settle(attempt, receipt);
    this.pending = null;
    this.expectedMembership =
      receipt.outcome === 'created' && attempt.postId === this.postId
        ? receipt.resourceId
        : null;
    this.update({
      active: true,
      formation: null,
      loaded: false,
      canJoin: false,
      frozen: false,
      contacts: emptyContacts(),
      contactConsent: false,
      recoveryPostId: '',
      blocker: '',
      error: '',
      receiptStatus:
        receipt.outcome === 'created'
          ? '加入已确认，每个账号只占一个席位'
          : `本次请求已确认拒绝：${reasonMessage(receipt.code)}`,
      status: '原加入请求已确认',
    });
    this.onChanged();
  }
  async inspectOwnMembership(): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || !this.pending)
      return;
    const target = this.pending.postId;
    await this.run(
      (cancel) => this.runtime.gateway!.ownFormationMembership(target, cancel),
      (raw) => {
        const own = decodeOwnFormationMembership(raw);
        if (own.postId !== target)
          throw new ClientError('protocol', 'Membership parent mismatch');
        this.update({
          ownStatus:
            '服务器确认此账号已有成员记录。原请求仍需通过回执确认，不能更换联系方式或请求编号',
        });
      },
    );
  }
  override cancel(): void {
    super.cancel();
    this.update({
      formation: null,
      loaded: false,
      canJoin: false,
      contacts: emptyContacts(),
      contactConsent: false,
    });
    if (this.pending) this.show(this.pending);
  }
}
function reasonMessageForFormation(value: Formation): string {
  return value.viewer.canJoin ? '' : reasonMessage(value.viewer.reason);
}
export interface FormationContactRow {
  readonly membershipId: string;
  readonly displayName: string;
  readonly isCreator: boolean;
  readonly contacts: FormationContacts;
}
export interface FormationContactsView extends CommunityView {
  readonly enabled: boolean;
  readonly rows: readonly FormationContactRow[];
  readonly open: boolean;
}
export const initialFormationContactsView = (): FormationContactsView => ({
  ...initialCommunityView(),
  enabled: false,
  rows: [],
  open: false,
});
/** Received contacts are transient only. Open and every copy revalidate parent, membership and phone qualification. */
export class FormationContactsController extends CommunityController<FormationContactsView> {
  private parent: Post | null = null;
  private clearLease: (() => void) | undefined;
  constructor(
    runtime: CommunityRuntime,
    render: (view: FormationContactsView) => void,
    private readonly copyText: (text: string) => Promise<void>,
    private readonly clock: Clock = systemClock,
  ) {
    super(runtime, initialFormationContactsView, render);
  }
  protected override resetPrivate(): void {
    this.clearLease?.();
    this.clearLease = undefined;
    this.parent = null;
  }
  load(post: Post | null): void {
    this.stop();
    this.clearLease?.();
    this.parent = post?.component.kind === 'formation' ? post : null;
    this.update({
      rows: [],
      open: false,
      busy: false,
      enabled:
        !!this.parent &&
        this.parent.component.kind === 'formation' &&
        this.parent.component.formation.viewer.canReadContacts,
      error: '',
    });
  }
  async reveal(): Promise<void> {
    await this.read();
  }
  async copy(membershipId: string, field: string): Promise<void> {
    if (field !== 'wechat' && field !== 'qq' && field !== 'phone') return;
    await this.read({ membershipId, field });
  }
  private async read(copy?: {
    membershipId: string;
    field: keyof FormationContacts;
  }): Promise<void> {
    if (
      !this.parent ||
      !this.view.enabled ||
      this.view.busy ||
      !this.available()
    )
      return;
    const parent = this.parent,
      owner = this.runtime.sessions.snapshot();
    this.clearLease?.();
    this.update({ rows: [], open: false });
    await this.run(
      async (cancel) => {
        const formation = decodeFormation(
          await this.runtime.gateway!.formation(parent.id, cancel),
        );
        if (
          formation.postId !== parent.id ||
          parent.component.kind !== 'formation' ||
          formation.id !== parent.component.formation.id ||
          !formation.viewer.isMember ||
          !formation.viewer.canReadContacts
        )
          throw new ClientError('forbidden', 'Membership unavailable');
        checkFormationCreator(formation, parent.author);
        // A later refresh must not extend a response beyond the contact request's original access lease.
        const requestExpiresAt =
          this.runtime.sessions.snapshot().credentials?.expiresAt ?? 0;
        const assertLease = () => {
          this.runtime.sessions.assertCurrent(owner);
          const current = this.runtime.sessions.snapshot().credentials;
          if (
            !current ||
            Math.min(current.expiresAt, requestExpiresAt) <= this.clock.now()
          )
            throw new ClientError(
              'auth-expired',
              'Contact authorization expired',
            );
        };
        assertLease();
        const result = decodeFormationContactView(
          await this.runtime.gateway!.formationContacts(parent.id, cancel),
        );
        assertLease();
        if (
          cancel.isCancelled ||
          this.parent !== parent ||
          result.postId !== parent.id
        )
          throw new ClientError('cancelled', 'Contact read replaced');
        const rows = result.members.flatMap((member) => {
          const publicMember = formation.members.find(
            (item) => item.id === member.membershipId,
          );
          return publicMember
            ? [
                {
                  membershipId: member.membershipId,
                  displayName: publicMember.author.displayName,
                  isCreator: publicMember.isCreator,
                  contacts: member.contacts,
                },
              ]
            : [];
        });
        if (copy) {
          const text = rows.find(
            (member) => member.membershipId === copy.membershipId,
          )?.contacts[copy.field];
          if (!text) throw new ClientError('protocol', 'Contact unavailable');
          assertLease();
          await this.copyText(text);
        }
        assertLease();
        return {
          rows,
          expiresAt: Math.min(
            requestExpiresAt,
            this.runtime.sessions.snapshot().credentials!.expiresAt,
          ),
        };
      },
      ({ rows, expiresAt }) => {
        if (expiresAt <= this.clock.now())
          throw new ClientError(
            'auth-expired',
            'Contact authorization expired',
          );
        this.update({
          rows,
          open: true,
          status: copy
            ? '已复制成员自愿分享的联系方式'
            : '联系方式仅供当前有权查看本帖的成员使用，60秒后清除本页显示',
        });
        this.clearLease = this.clock.schedule(
          () => {
            this.clearLease = undefined;
            this.update({
              rows: [],
              open: false,
              status: '联系方式显示已过期，请重新查看',
            });
          },
          Math.max(0, Math.min(60000, expiresAt - this.clock.now())),
        );
      },
      () => this.update({ rows: [], open: false }),
    );
  }
  dismiss(): void {
    this.stop();
    this.clearLease?.();
    this.clearLease = undefined;
    this.update({ rows: [], open: false, busy: false });
  }
  override cancel(): void {
    super.cancel();
    this.clearLease?.();
    this.update({ rows: [], open: false });
  }
}
