import {
  exactExperience,
  experienceRequestId,
  invalidExperience,
} from './contract';
export interface RedemptionCapability {
  readonly status: 'available' | 'unavailable';
}
export interface RedemptionInput {
  readonly requestId: string;
  readonly code: string;
}
export type RedemptionReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'redeem_title';
      readonly outcome: 'granted';
      readonly titleKey: 'redeem_liangchenmeijing';
    }
  | {
      readonly requestId: string;
      readonly operation: 'redeem_title';
      readonly outcome: 'rejected';
      readonly code:
        'EXPERIENCE_REDEMPTION_INVALID' | 'EXPERIENCE_TITLE_ALREADY_OWNED';
    };
export function decodeRedemptionCapability(raw: unknown): RedemptionCapability {
  exactExperience(raw, ['status']);
  if (raw.status !== 'available' && raw.status !== 'unavailable')
    invalidExperience();
  return Object.freeze({ status: raw.status });
}
export function validRedemptionCode(raw: unknown): raw is string {
  if (
    typeof raw !== 'string' ||
    !raw.length ||
    Array.from(raw).some((character) => {
      const point = character.charCodeAt(0);
      return point < 32 || (point >= 127 && point <= 159);
    })
  )
    return false;
  try {
    return encodeURIComponent(raw).replace(/%[A-F\d]{2}/gi, 'x').length <= 128;
  } catch {
    return false;
  }
}
export function decodeRedemptionInput(raw: unknown): RedemptionInput {
  exactExperience(raw, ['requestId', 'code']);
  if (!experienceRequestId(raw.requestId) || !validRedemptionCode(raw.code))
    invalidExperience();
  return { requestId: raw.requestId, code: raw.code };
}
export function decodeRedemptionReceipt(raw: unknown): RedemptionReceipt {
  const value = raw as Record<string, unknown> | null;
  exactExperience(
    raw,
    value?.outcome === 'granted'
      ? ['requestId', 'operation', 'outcome', 'titleKey']
      : ['requestId', 'operation', 'outcome', 'code'],
  );
  if (!experienceRequestId(raw.requestId) || raw.operation !== 'redeem_title')
    invalidExperience();
  if (raw.outcome === 'granted' && raw.titleKey === 'redeem_liangchenmeijing')
    return Object.freeze({
      requestId: raw.requestId,
      operation: 'redeem_title',
      outcome: 'granted',
      titleKey: raw.titleKey,
    });
  if (
    raw.outcome === 'rejected' &&
    (raw.code === 'EXPERIENCE_REDEMPTION_INVALID' ||
      raw.code === 'EXPERIENCE_TITLE_ALREADY_OWNED')
  )
    return Object.freeze({
      requestId: raw.requestId,
      operation: 'redeem_title',
      outcome: 'rejected',
      code: raw.code,
    });
  return invalidExperience();
}
