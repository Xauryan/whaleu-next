import { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import { SessionStore } from '../auth/session';
import {
  boundedText,
  exact,
  invalid,
  type AuthorMode,
} from '../community/contract';
import { cancellable } from '../platform/cancellable';
import { Cancellation, type Clock } from '../platform/contracts';
import { isUuid } from '../profile/contract';
export interface IdentityTarget {
  readonly kind: 'post' | 'comment';
  readonly id: string;
}
export interface DisplayTarget extends IdentityTarget {
  readonly authorMode: AuthorMode;
}
export interface Authorization {
  readonly role: 'member' | 'school_admin' | 'super_admin' | 'developer';
  readonly management: {
    readonly global: boolean;
    readonly operatingRegionIds: readonly string[];
  };
  readonly identityView: {
    readonly allowed: boolean;
    readonly maxBatchSize: 20;
  };
}
export interface PrivateIdentity {
  readonly accountId: string;
  readonly nickname: string | null;
  readonly avatar: null;
  readonly studentNumber: string | null;
  readonly studentNumberStatus: 'verified' | 'unverified' | 'unavailable';
}
export type IdentityItem =
  | {
      readonly target: IdentityTarget;
      readonly status: 'available';
      readonly authorMode: AuthorMode;
      readonly identity: PrivateIdentity;
    }
  | { readonly target: IdentityTarget; readonly status: 'unavailable' };
export function decodeAuthorization(value: unknown): Authorization {
  exact(value, ['role', 'management', 'identityView']);
  exact(value.management, ['global', 'operatingRegionIds']);
  exact(value.identityView, ['allowed', 'maxBatchSize']);
  if (
    !['member', 'school_admin', 'super_admin', 'developer'].includes(
      String(value.role),
    ) ||
    typeof value.management.global !== 'boolean' ||
    !Array.isArray(value.management.operatingRegionIds) ||
    value.management.operatingRegionIds.length > 10000 ||
    !value.management.operatingRegionIds.every(isUuid) ||
    new Set(value.management.operatingRegionIds).size !==
      value.management.operatingRegionIds.length ||
    value.identityView.allowed !== (value.role === 'developer') ||
    value.identityView.maxBatchSize !== 20 ||
    value.management.global !==
      (value.role === 'developer' || value.role === 'super_admin') ||
    (value.role === 'member' && value.management.operatingRegionIds.length)
  )
    invalid();
  return Object.freeze({
    role: value.role as Authorization['role'],
    management: Object.freeze({
      global: value.management.global,
      operatingRegionIds: Object.freeze([
        ...value.management.operatingRegionIds,
      ]),
    }),
    identityView: Object.freeze({
      allowed: value.identityView.allowed,
      maxBatchSize: 20,
    }),
  });
}
function target(value: unknown): IdentityTarget {
  exact(value, ['kind', 'id']);
  if (!['post', 'comment'].includes(String(value.kind)) || !isUuid(value.id))
    invalid();
  return Object.freeze({
    kind: value.kind as IdentityTarget['kind'],
    id: value.id,
  });
}
export function decodeIdentityBatch(value: unknown): readonly IdentityItem[] {
  exact(value, ['items']);
  if (
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 20
  )
    invalid();
  const items = value.items.map((raw): IdentityItem => {
    if (typeof raw !== 'object' || raw === null || !('status' in raw))
      invalid();
    if (raw.status === 'unavailable') {
      exact(raw, ['target', 'status']);
      return Object.freeze({
        target: target(raw.target),
        status: 'unavailable',
      });
    }
    exact(raw, ['target', 'status', 'authorMode', 'identity']);
    exact(raw.identity, [
      'accountId',
      'nickname',
      'avatar',
      'studentNumber',
      'studentNumberStatus',
    ]);
    const identity = raw.identity;
    if (
      raw.status !== 'available' ||
      !['named', 'anonymous'].includes(String(raw.authorMode)) ||
      !isUuid(identity.accountId) ||
      !(identity.nickname === null || boundedText(identity.nickname, 1, 100)) ||
      identity.avatar !== null ||
      !['verified', 'unverified', 'unavailable'].includes(
        String(identity.studentNumberStatus),
      ) ||
      (identity.studentNumberStatus === 'verified'
        ? !boundedText(identity.studentNumber, 1, 100)
        : identity.studentNumber !== null)
    )
      invalid();
    return Object.freeze({
      target: target(raw.target),
      status: 'available',
      authorMode: raw.authorMode as AuthorMode,
      identity: Object.freeze({
        accountId: identity.accountId,
        nickname: identity.nickname,
        avatar: null,
        studentNumber: identity.studentNumber as string | null,
        studentNumberStatus:
          identity.studentNumberStatus as PrivateIdentity['studentNumberStatus'],
      }),
    });
  });
  if (
    new Set(items.map((item) => `${item.target.kind}:${item.target.id}`))
      .size !== items.length
  )
    invalid();
  return Object.freeze(items);
}
export interface IdentityPrivacyGateway {
  authorization(cancel: Cancellation): Promise<Authorization>;
  identities(
    targets: readonly IdentityTarget[],
    cancel: Cancellation,
  ): Promise<readonly IdentityItem[]>;
}
export class HttpIdentityPrivacyGateway implements IdentityPrivacyGateway {
  constructor(private readonly api: ApiClient) {}
  authorization(cancel: Cancellation): Promise<Authorization> {
    return this.api.request(
      {
        path: '/v1/me/authorization',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeAuthorization,
      },
      { cancellation: cancel },
    );
  }
  async identities(
    targets: readonly IdentityTarget[],
    cancel: Cancellation,
  ): Promise<readonly IdentityItem[]> {
    const checked = targets.map(target);
    if (
      !checked.length ||
      checked.length > 20 ||
      new Set(checked.map((item) => `${item.kind}:${item.id}`)).size !==
        checked.length
    )
      invalid();
    const result = await this.api.request(
      {
        path: '/v1/identity-privacy/content-identities',
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeIdentityBatch,
      },
      {
        body: { targets: checked.map((item) => ({ ...item })) },
        cancellation: cancel,
      },
    );
    const expected = new Set(checked.map((item) => `${item.kind}:${item.id}`));
    if (
      result.length !== expected.size ||
      result.some(
        (item) => !expected.has(`${item.target.kind}:${item.target.id}`),
      )
    )
      invalid();
    return result;
  }
}
export class PrivateViewLifecycle {
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  clear(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* One native render failure cannot retain another private overlay. */
      }
    }
  }
}
export interface OverlayView {
  readonly developerEnabled: boolean;
  readonly items: Readonly<Record<string, PrivateIdentity>>;
  readonly notice: string;
}
export const initialOverlayView = (): OverlayView => ({
  developerEnabled: false,
  items: {},
  notice: '',
});
/** Deliberately separate from ordinary post/comment state, drafts, storage, logs and shares. */
export class IdentityOverlayController {
  private generation = 0;
  private cancel: Cancellation | undefined;
  private stopped = false;
  private expiry: (() => void) | undefined;
  private owner;
  private unsubscribe: () => void;
  private unsubscribeVisibility: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: IdentityPrivacyGateway | undefined,
    private readonly clock: Clock,
    private readonly render: (view: OverlayView) => void,
    lifecycle?: PrivateViewLifecycle,
  ) {
    this.unsubscribeVisibility =
      lifecycle?.subscribe(() => this.clear()) ?? (() => undefined);
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== this.owner.epoch ||
        now.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.owner = now;
        this.clear();
      }
    });
    this.render(initialOverlayView());
  }
  clear(): void {
    this.generation += 1;
    this.cancel?.cancel();
    this.cancel = undefined;
    this.expiry?.();
    this.expiry = undefined;
    if (!this.stopped) this.render(initialOverlayView());
  }
  async show(targets: readonly DisplayTarget[]): Promise<void> {
    if (this.stopped) return;
    this.clear();
    if (!this.gateway || !this.owner.credentials || !targets.length) return;
    const generation = this.generation,
      owner = this.owner,
      cancel = new Cancellation();
    this.cancel = cancel;
    const current = () => !this.stopped && generation === this.generation;
    try {
      const work = async () => {
        this.sessions.assertCurrent(owner);
        if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
        const authorization = await this.gateway!.authorization(cancel);
        if (
          !authorization.identityView.allowed ||
          authorization.role !== 'developer'
        )
          return null;
        const items: IdentityItem[] = [];
        for (let offset = 0; offset < targets.length; offset += 20) {
          this.sessions.assertCurrent(owner);
          if (cancel.isCancelled)
            throw new ClientError('cancelled', 'Cancelled');
          const batch = targets.slice(offset, offset + 20);
          const result = await this.gateway!.identities(
            batch.map((item) => ({ kind: item.kind, id: item.id })),
            cancel,
          );
          for (const item of result) {
            const expected = batch.find(
              (candidate) =>
                candidate.kind === item.target.kind &&
                candidate.id === item.target.id,
            );
            if (
              !expected ||
              (item.status === 'available' &&
                item.authorMode !== expected.authorMode)
            )
              invalid();
          }
          items.push(...result);
        }
        return items;
      };
      const items = await cancellable(Promise.resolve().then(work), cancel);
      if (!current()) return;
      this.sessions.assertCurrent(owner);
      if (!items) return;
      const display: Record<string, PrivateIdentity> = {};
      for (const item of items)
        if (item.status === 'available')
          display[item.target.id] = item.identity;
      this.render({
        developerEnabled: true,
        items: Object.freeze(display),
        notice:
          '开发者身份视图 · 每次查看由服务端重新授权并审计；敏感资料将在 30 秒后清除',
      });
      this.expiry = this.clock.schedule(() => {
        if (current()) {
          this.clear();
          this.render({
            developerEnabled: false,
            items: {},
            notice: '敏感身份已自动清除。刷新内容后将重新核验权限',
          });
        }
      }, 30000);
    } catch {
      if (current()) {
        this.clear();
        this.render({
          developerEnabled: false,
          items: {},
          notice: '身份查看未完成或权限已改变，敏感资料已清除',
        });
      }
    } finally {
      if (current()) this.cancel = undefined;
    }
  }
  dispose(): void {
    if (this.stopped) return;
    this.clear();
    this.unsubscribe();
    this.unsubscribeVisibility();
    this.stopped = true;
  }
}
