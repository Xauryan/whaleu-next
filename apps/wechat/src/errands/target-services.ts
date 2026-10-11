import type { ApiClient } from '../api/client';
import { ClientError, clientError } from '../api/errors';
import type { SessionStore } from '../auth/session';
import { Cancellation } from '../platform/contracts';
import type { OwnProfile } from '../profile/contract';
import type { ProfileGateway } from '../profile/gateway';
import {
  decodeErrandSchoolService,
  schoolUuid,
  invalidSchool,
} from '../school-configuration/contract';
import type { ErrandSchoolService } from '../school-configuration/contract';
import type { SchoolQrPreviewTarget } from '../school-configuration/qr-runtime';
import type { ErrandDetail } from './contract';
export interface ErrandTargetServicesGateway {
  read(orderId: string, cancel: Cancellation): Promise<ErrandSchoolService>;
}
export class HttpErrandTargetServicesGateway implements ErrandTargetServicesGateway {
  constructor(private readonly api: ApiClient) {}
  async read(orderId: string, cancel: Cancellation) {
    const result = await this.api.request(
      {
        path: `/v1/school-services/errands/${schoolUuid(orderId)}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeErrandSchoolService,
      },
      { cancellation: cancel },
    );
    if (result.context.orderId !== orderId) invalidSchool();
    return result;
  }
}
export interface ErrandTargetServicesView {
  visible: boolean;
  busy: boolean;
  regionName: string;
  name: string;
  description: string;
  canPreview: boolean;
  message: string;
  error: string;
}
export const initialErrandTargetServicesView =
  (): ErrandTargetServicesView => ({
    visible: false,
    busy: false,
    regionName: '',
    name: '',
    description: '',
    canPreview: false,
    message: '',
    error: '',
  });
/** Order authority and account preference have independent owners. Never store a
 * selected campus, QR path, or full preference replacement in this controller. */
export class ErrandTargetServicesController {
  private generation = 0;
  private cancel = new Cancellation();
  private disposed = false;
  private detail: ErrandDetail | null = null;
  private result: ErrandSchoolService | null = null;
  private profile: OwnProfile | null = null;
  private view = initialErrandTargetServicesView();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: ErrandTargetServicesGateway,
    private readonly profiles: ProfileGateway,
    private readonly clearQr: () => void,
    private readonly render: (view: ErrandTargetServicesView) => void,
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
      }
    });
  }
  private update(patch: Partial<ErrandTargetServicesView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.render(this.view);
  }
  clear() {
    this.generation++;
    this.cancel.cancel();
    this.cancel = new Cancellation();
    this.detail = null;
    this.result = null;
    this.profile = null;
    this.clearQr();
    this.update(initialErrandTargetServicesView());
  }
  sync(detail: ErrandDetail | null) {
    if (!detail) {
      if (this.detail) this.clear();
      return;
    }
    if (
      this.detail?.id === detail.id &&
      this.detail.revision === detail.revision
    )
      return;
    void this.load(detail);
  }
  async load(detail: ErrandDetail) {
    this.clear();
    this.detail = detail;
    const generation = this.generation,
      ticket = this.sessions.snapshot(),
      cancel = this.cancel;
    this.update({ busy: true });
    try {
      const [result, profile] = await Promise.all([
        this.gateway.read(detail.id, cancel),
        this.profiles.profile(cancel),
      ]);
      this.sessions.assertCurrent(ticket);
      if (this.disposed || generation !== this.generation) return;
      if (
        result.context.orderId !== detail.id ||
        result.context.targetRegion.id !== detail.targetRegion.id ||
        profile.accountId !== ticket.credentials?.accountId
      )
        invalidSchool();
      this.result = result;
      this.profile = profile;
      this.show();
    } catch {
      if (!this.disposed && generation === this.generation)
        this.update({
          busy: false,
          error: '目标地区互助群暂不可读取，请刷新订单重试',
        });
    }
  }
  private show() {
    const result = this.result,
      profile = this.profile;
    if (!result || !profile) return;
    const entry = result.entry,
      data = entry.data;
    this.update({
      visible: profile.preferences.showErrandGroupNotice,
      busy: false,
      regionName: result.context.targetRegion.name,
      name: data?.kind === 'group' ? data.name : '',
      description: data?.kind === 'group' ? data.description : '',
      canPreview: !!data?.enabled && entry.qrcode.status === 'configured',
      message:
        entry.state === 'disabled'
          ? '目标地区互助群已停用'
          : entry.state === 'unconfigured'
            ? '目标地区尚未配置跑腿互助群'
            : entry.qrcode.status === 'none'
              ? '暂未配置群二维码'
              : '查看订单目标地区当前互助群二维码',
      error: '',
    });
  }
  previewContext(): SchoolQrPreviewTarget | null {
    const result = this.result;
    return !this.disposed &&
      this.view.visible &&
      !this.view.busy &&
      this.view.canPreview &&
      result
      ? {
          orderId: result.context.orderId,
          targetRegionId: result.context.targetRegion.id,
          entryKey: 'errand',
          entryRevision: result.entry.revision,
        }
      : null;
  }
  async dismiss() {
    if (this.disposed || this.view.busy || !this.view.visible || !this.profile)
      return;
    const generation = this.generation,
      ticket = this.sessions.snapshot(),
      cancel = this.cancel;
    const current = () => {
      this.sessions.assertCurrent(ticket);
      if (this.disposed || generation !== this.generation || cancel.isCancelled)
        throw new ClientError('cancelled', 'Notice closed');
    };
    const read = async () => {
      const profile = await this.profiles.profile(cancel);
      current();
      if (profile.accountId !== ticket.credentials?.accountId) invalidSchool();
      this.profile = profile;
      return profile;
    };
    this.clearQr();
    this.update({ busy: true, error: '' });
    try {
      // Shared profile CAS. On one explicit conflict, re-read and retry only this
      // single preference; never replace another setting with an old snapshot.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const profile = await this.profiles.updatePreferences(
            {
              expectedRevision: this.profile!.revision,
              preferences: { showErrandGroupNotice: false },
            },
            cancel,
          );
          current();
          if (
            profile.accountId !== ticket.credentials?.accountId ||
            profile.preferences.showErrandGroupNotice
          )
            invalidSchool();
          this.profile = profile;
          this.show();
          return;
        } catch (error) {
          current();
          const failure = clientError(error);
          if (
            attempt !== 0 ||
            failure.details.serverCode !== 'PROFILE_REVISION_CONFLICT' ||
            failure.kind === 'protocol' ||
            failure.details.httpStatus !== 409
          )
            throw error;
          if (!(await read()).preferences.showErrandGroupNotice) {
            this.show();
            return;
          }
        }
      }
    } catch {
      if (!this.disposed && generation === this.generation) {
        // A lost response might already be committed. Establish the stored value
        // with a read, without automatically replaying an uncertain write.
        try {
          await read();
          this.show();
        } catch {
          /* Explicit reload remains available. */
        }
        if (
          !this.disposed &&
          generation === this.generation &&
          this.view.visible
        )
          this.update({
            busy: false,
            error: '设置结果尚未确认，请刷新订单后重试',
          });
      }
    }
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.unsubscribe();
  }
}
