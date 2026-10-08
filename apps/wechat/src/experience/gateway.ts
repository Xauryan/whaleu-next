import {
  decodeRedemptionCapability,
  decodeRedemptionInput,
  decodeRedemptionReceipt,
  type RedemptionCapability,
  type RedemptionInput,
  type RedemptionReceipt,
} from './redemption-contract';
import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import {
  decodeAppearanceIntent,
  decodeExperienceAcknowledgement,
  decodeExperienceAppearance,
  decodeExperienceCatalog,
  decodeExperienceReceipt,
  decodeExperienceRecords,
  decodeExperienceSummary,
  decodeExperienceUnlocks,
  decodeSignInIntent,
  experienceCursor,
  experienceRequestId,
  experienceUuid,
  invalidExperience,
  matchExperienceReceipt,
  type AppearanceIntent,
  type AppearanceReceipt,
  type ExperienceAcknowledgement,
  type ExperienceAppearance,
  type ExperienceCatalog,
  type ExperienceReceipt,
  type ExperienceRecords,
  type ExperienceSummary,
  type ExperienceUnlocks,
  type SignInIntent,
  type SignInReceipt,
} from './contract';
export interface ExperienceGateway {
  redemption(cancel: Cancellation): Promise<RedemptionCapability>;
  redeemTitle(
    input: RedemptionInput,
    cancel: Cancellation,
  ): Promise<RedemptionReceipt>;
  summary(cancel: Cancellation): Promise<ExperienceSummary>;
  catalog(cancel: Cancellation): Promise<ExperienceCatalog>;
  records(
    after: string | null,
    cancel: Cancellation,
  ): Promise<ExperienceRecords>;
  appearance(cancel: Cancellation): Promise<ExperienceAppearance>;
  signIn(intent: SignInIntent, cancel: Cancellation): Promise<SignInReceipt>;
  selectAppearance(
    intent: AppearanceIntent,
    cancel: Cancellation,
  ): Promise<AppearanceReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<ExperienceReceipt>;
  unlocks(cancel: Cancellation): Promise<ExperienceUnlocks>;
  acknowledge(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<ExperienceAcknowledgement>;
}
export class HttpExperienceGateway implements ExperienceGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: (v: unknown) => T,
    cancel: Cancellation,
    query?: Readonly<Record<string, string | number>>,
    authReplay: 'once' | 'never' = 'once',
  ): Promise<T> {
    return this.api.request(
      {
        path,
        method: 'GET',
        authentication: 'required',
        authReplay,
        successStatus: 200,
        decode,
      },
      { cancellation: cancel, ...(query ? { query } : {}) },
    );
  }
  private write<T>(
    path: string,
    method: 'POST' | 'PUT',
    body: Json,
    decode: (v: unknown) => T,
    cancel: Cancellation,
  ): Promise<T> {
    return this.api.request(
      {
        path,
        method,
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode,
      },
      { body, cancellation: cancel },
    );
  }
  redemption(cancel: Cancellation) {
    return this.api.request(
      {
        path: '/v1/me/experience/redemption',
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeRedemptionCapability,
      },
      { cancellation: cancel },
    );
  }
  redeemTitle(
    raw: RedemptionInput,
    cancel: Cancellation,
  ): Promise<RedemptionReceipt> {
    const input = decodeRedemptionInput(raw),
      requestId = input.requestId;
    return this.write(
      '/v1/me/experience/redemptions',
      'POST',
      { requestId, code: input.code },
      (v) => {
        const receipt = decodeRedemptionReceipt(v);
        if (receipt.requestId !== requestId) invalidExperience();
        return receipt;
      },
      cancel,
    );
  }
  summary(cancel: Cancellation) {
    return this.read('/v1/me/experience', decodeExperienceSummary, cancel);
  }
  catalog(cancel: Cancellation) {
    return this.read('/v1/experience/catalog', decodeExperienceCatalog, cancel);
  }
  records(after: string | null, cancel: Cancellation) {
    if (after !== null && !experienceCursor(after)) invalidExperience();
    return this.read(
      '/v1/me/experience/records',
      decodeExperienceRecords,
      cancel,
      { limit: 20, ...(after ? { cursor: after } : {}) },
    );
  }
  appearance(cancel: Cancellation) {
    return this.read(
      '/v1/me/experience/appearance',
      decodeExperienceAppearance,
      cancel,
    );
  }
  signIn(raw: SignInIntent, cancel: Cancellation): Promise<SignInReceipt> {
    const intent = decodeSignInIntent(raw);
    return this.write(
      '/v1/me/experience/sign-in',
      'POST',
      { ...intent },
      (v) => {
        const receipt = decodeExperienceReceipt(v);
        matchExperienceReceipt({ operation: 'sign_in', ...intent }, receipt);
        if (receipt.operation !== 'sign_in') invalidExperience();
        return receipt;
      },
      cancel,
    );
  }
  selectAppearance(
    raw: AppearanceIntent,
    cancel: Cancellation,
  ): Promise<AppearanceReceipt> {
    const intent = decodeAppearanceIntent(raw);
    return this.write(
      '/v1/me/experience/appearance',
      'PUT',
      { ...intent },
      (v) => {
        const receipt = decodeExperienceReceipt(v);
        matchExperienceReceipt({ operation: 'appearance', ...intent }, receipt);
        if (receipt.operation !== 'appearance') invalidExperience();
        return receipt;
      },
      cancel,
    );
  }
  receipt(requestId: string, cancel: Cancellation) {
    if (!experienceRequestId(requestId)) invalidExperience();
    return this.read(
      `/v1/me/experience/requests/${requestId}`,
      (v) => {
        const r = decodeExperienceReceipt(v);
        if (r.requestId !== requestId) invalidExperience();
        return r;
      },
      cancel,
      undefined,
      'never',
    );
  }
  unlocks(cancel: Cancellation) {
    return this.read(
      '/v1/me/experience/unlocks',
      decodeExperienceUnlocks,
      cancel,
    );
  }
  acknowledge(noticeId: string, cancel: Cancellation) {
    if (!experienceUuid(noticeId)) invalidExperience();
    return this.write(
      `/v1/me/experience/unlocks/${noticeId}/ack`,
      'PUT',
      {},
      (v) => {
        const r = decodeExperienceAcknowledgement(v);
        if (r.noticeId !== noticeId) invalidExperience();
        return r;
      },
      cancel,
    );
  }
}
