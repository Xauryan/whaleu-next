import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import { ApiClient } from '../api/client';
import { ClientError, isRecord } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import { Cancellation, type Storage } from '../platform/contracts';

const consent = 'wechat-phone-verification-v1';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const phoneStates = [
  'reserved',
  'processing',
  'unknown',
  'verified',
  'closed',
  'expired',
  'not_found',
] as const;
export interface PhoneReceipt {
  readonly requestId: string;
  readonly state: (typeof phoneStates)[number];
}
export function decodePhoneReceipt(value: unknown): PhoneReceipt {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.requestId !== 'string' ||
    !uuid.test(value.requestId) ||
    typeof value.state !== 'string' ||
    !(phoneStates as readonly string[]).includes(value.state)
  )
    throw new ClientError('protocol', 'Invalid phone authorization receipt');
  return Object.freeze({
    requestId: value.requestId,
    state: value.state as PhoneReceipt['state'],
  });
}
export interface PhoneGateway {
  reserve(
    id: string,
    replaces: string | null,
    cancellation: Cancellation,
  ): Promise<PhoneReceipt>;
  read(id: string, cancellation: Cancellation): Promise<PhoneReceipt>;
  authorize(
    id: string,
    code: string,
    cancellation: Cancellation,
  ): Promise<PhoneReceipt>;
  close(id: string, cancellation: Cancellation): Promise<PhoneReceipt>;
}
export class HttpPhoneGateway implements PhoneGateway {
  constructor(private readonly api: ApiClient) {}
  private call(
    id: string,
    action: 'read' | 'reserve' | 'authorize' | 'close',
    cancellation: Cancellation,
    code?: string,
    replaces?: string | null,
  ) {
    if (!uuid.test(id))
      throw new ClientError('protocol', 'Invalid phone request');
    return this.api.request(
      {
        path: `/v1/me/phone-binding/requests${action === 'reserve' ? '' : `/${id}${action === 'read' ? '' : `/${action}`}`}`,
        method: action === 'read' ? 'GET' : 'POST',
        authentication: 'required',
        authReplay: action === 'authorize' ? 'never' : 'once',
        successStatus: 200,
        decode: decodePhoneReceipt,
      },
      {
        cancellation,
        ...(action === 'read'
          ? {}
          : {
              body:
                action === 'reserve'
                  ? {
                      requestId: id,
                      consent,
                      replacesRequestId: replaces ?? null,
                    }
                  : action === 'authorize'
                    ? { code: code!, consent }
                    : {},
            }),
      },
    );
  }
  reserve(id: string, replaces: string | null, cancellation: Cancellation) {
    return this.call(id, 'reserve', cancellation, undefined, replaces);
  }
  read(id: string, cancellation: Cancellation) {
    return this.call(id, 'read', cancellation);
  }
  authorize(id: string, code: string, cancellation: Cancellation) {
    return this.call(id, 'authorize', cancellation, code);
  }
  close(id: string, cancellation: Cancellation) {
    return this.call(id, 'close', cancellation);
  }
}
export interface PhoneView {
  readonly busy: boolean;
  readonly hasSession: boolean;
  readonly configured: boolean;
  readonly phase: 'idle' | 'recovering' | PhoneReceipt['state'];
  readonly requestId: string;
  readonly message: string;
}
interface SavedRequest {
  requestId: string;
  replacesRequestId: string | null;
}
/** Persist only original opaque keys. Never persist code, phone or verification facts.
 * Every callback is login-epoch bound; foreground restoration only reads the key. */
export class PhoneBindingController {
  private view: PhoneView;
  private readonly owner: SessionTicket;
  private saved: SavedRequest | undefined;
  private disposed = false;
  private cancellation: Cancellation | undefined;
  private readonly unsubscribe: () => void;
  private readonly unsubscribePrivate: (() => void) | undefined;
  private readonly key: string;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: PhoneGateway | undefined,
    private readonly storage: Storage,
    origin: string,
    private readonly newId: () => Promise<string>,
    private readonly render: (view: PhoneView) => void,
    privateViews?: PrivateViewLifecycle,
  ) {
    this.owner = sessions.snapshot();
    this.key = `whaleu.phone-request.v1:${origin}:${this.owner.credentials?.accountId ?? 'guest'}`;
    this.view = {
      busy: false,
      hasSession: !!this.owner.credentials,
      configured: !!gateway,
      phase: 'idle',
      requestId: '',
      message: !gateway
        ? '手机号授权尚未配置，请先配置 API。'
        : !this.owner.credentials
          ? '请先登录后再授权。'
          : '请阅读用途说明后主动准备授权。',
    };
    this.unsubscribe = sessions.subscribe(() => {
      try {
        sessions.assertCurrent(this.owner);
      } catch {
        this.dispose();
        this.render({
          ...this.view,
          busy: false,
          hasSession: false,
          phase: 'idle',
          requestId: '',
          message: '登录状态已改变，请重新进入',
        });
      }
    });
    this.unsubscribePrivate = privateViews?.subscribe(() => this.dispose());
    this.render(this.view);
  }
  private update(patch: Partial<PhoneView>) {
    this.view = { ...this.view, ...patch };
    this.render(this.view);
  }
  private check() {
    this.sessions.assertCurrent(this.owner);
    if (this.disposed) throw new ClientError('cancelled', 'Page closed');
  }
  private apply(result: PhoneReceipt) {
    this.check();
    const checked = decodePhoneReceipt(result);
    if (checked.requestId !== this.saved?.requestId)
      throw new ClientError('protocol', 'Phone receipt key mismatch');
    const text: Record<PhoneReceipt['state'], string> = {
      reserved: '请求已准备。请主动点击微信授权按钮。',
      processing: '原请求正在处理，请稍后查询原结果。',
      unknown:
        '原授权结果未知；不会重发原验证码。可查询原结果，或明确重新授权建立新请求。',
      verified: '此次手机号授权验证已记录。实际操作仍以当前服务端资格为准。',
      closed: '原请求已关闭。再次授权需要新请求。',
      expired: '请求已过期，请重新准备并授权。',
      not_found: '未找到原请求。可用原编号重新准备，不会发送授权码。',
    };
    this.update({
      requestId: checked.requestId,
      phase: checked.state,
      message: text[checked.state],
    });
  }
  private async work(action: (c: Cancellation) => Promise<void>) {
    if (
      this.disposed ||
      this.view.busy ||
      !this.gateway ||
      !this.owner.credentials
    )
      return;
    this.update({ busy: true });
    const cancellation = new Cancellation();
    this.cancellation = cancellation;
    try {
      this.check();
      await action(cancellation);
    } catch {
      if (!this.disposed)
        this.update({
          phase: this.saved ? 'recovering' : 'idle',
          message:
            '结果未确认，请查询原请求。服务可能未开启，登录或网络也可能已失效；请勿重复提交授权码。',
        });
    } finally {
      if (!this.disposed) this.update({ busy: false });
      this.cancellation = undefined;
    }
  }
  async restore() {
    await this.work(async (c) => {
      const value = this.storage.get(this.key);
      if (value === undefined || value === null || value === '') return;
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 2 ||
        typeof value.requestId !== 'string' ||
        !uuid.test(value.requestId) ||
        !(
          value.replacesRequestId === null ||
          (typeof value.replacesRequestId === 'string' &&
            uuid.test(value.replacesRequestId))
        )
      )
        throw new ClientError('storage', 'Invalid saved phone request');
      this.saved = {
        requestId: value.requestId,
        replacesRequestId: value.replacesRequestId as string | null,
      };
      this.update({ requestId: this.saved.requestId, phase: 'recovering' });
      this.apply(await this.gateway!.read(this.saved.requestId, c));
    });
  }
  async prepare() {
    await this.work(async (c) => {
      if (
        this.saved &&
        !['not_found', 'closed', 'expired', 'unknown', 'verified'].includes(
          this.view.phase,
        )
      )
        return;
      const existing = this.saved;
      const reuse = existing && this.view.phase === 'not_found';
      const id = reuse ? existing.requestId : await this.newId();
      this.check();
      if (!uuid.test(id))
        throw new ClientError('protocol', 'Invalid new phone key');
      const saved = reuse
        ? existing
        : {
            requestId: id,
            replacesRequestId:
              this.view.phase === 'verified'
                ? null
                : (existing?.requestId ?? null),
          };
      this.storage.set(this.key, saved);
      this.saved = saved;
      this.update({ requestId: id, phase: 'recovering' });
      this.apply(await this.gateway!.reserve(id, saved.replacesRequestId, c));
    });
  }
  async recover() {
    await this.work(async (c) => {
      if (this.saved)
        this.apply(await this.gateway!.read(this.saved.requestId, c));
    });
  }
  async authorize(detail: { errMsg?: string; code?: string }) {
    if (detail.errMsg !== 'getPhoneNumber:ok' || !detail.code) {
      if (!this.disposed)
        this.update({ message: '未获得微信手机号授权，没有发送验证码。' });
      return;
    }
    if (this.view.phase !== 'reserved') return;
    await this.work(async (c) => {
      if (!this.saved) return;
      this.update({
        phase: 'processing',
        message: '正在提交本次授权，仅发送一次。',
      });
      this.apply(
        await this.gateway!.authorize(this.saved.requestId, detail.code!, c),
      );
    });
  }
  async close() {
    await this.work(async (c) => {
      if (this.saved)
        this.apply(await this.gateway!.close(this.saved.requestId, c));
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancellation?.cancel();
    this.unsubscribe();
    this.unsubscribePrivate?.();
    this.saved = undefined;
    this.view = {
      ...this.view,
      busy: false,
      hasSession: false,
      phase: 'idle',
      requestId: '',
      message: '页面已隐藏，请重新进入后查询原请求。',
    };
    this.render(this.view);
  }
}
