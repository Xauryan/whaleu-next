import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
export const redeemableTitleKey = 'redeem_liangchenmeijing' as const;
export type RedeemableTitleKey = typeof redeemableTitleKey;
export interface RedemptionKey {
  version: string;
  key: Uint8Array;
}
/** No production activation route. Test providers are injected, never configured by environment. */
@Injectable()
export class RedemptionProvider {
  available(): boolean {
    return false;
  }
  key(_version?: string): RedemptionKey | null {
    return null;
  }
  async lookup(_fingerprint: string): Promise<RedeemableTitleKey | null> {
    return null;
  }
}
@Injectable()
export class RedemptionAttemptBudget {
  available(): boolean {
    return false;
  }
  async permit(_owner: string): Promise<boolean> {
    return false;
  }
}
export function validRedemptionKey(material: RedemptionKey): boolean {
  return (
    /^[a-zA-Z0-9_-]{1,40}$/.test(material.version) &&
    material.key.byteLength >= 32
  );
}
export function redemptionFingerprints(
  owner: string,
  code: string,
  material: RedemptionKey,
) {
  if (!validRedemptionKey(material)) return null;
  const digest = (domain: string, values: string[]) =>
    createHmac('sha256', material.key)
      .update(JSON.stringify([domain, ...values]))
      .digest('hex');
  return {
    intent: digest('whaleu:title-redemption:intent:v1', [
      owner,
      'redeem_title',
      code,
    ]),
    lookup: digest('whaleu:title-redemption:lookup:v1', [code]),
    version: material.version,
  };
}
