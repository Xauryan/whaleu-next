import { createHmac } from 'node:crypto';
import { DeletionError } from './contracts.js';
export const SYNTHETIC_APP = 'synthetic-account-deletion-rehearsal';
/** Explicit test-owned key only. No default, environment secret or provider call. */
export class SyntheticIdentityKeys {
  private readonly key: Buffer;
  constructor(key: Uint8Array) {
    if (key.length < 32) throw new DeletionError('SYNTHETIC_KEY_REQUIRED');
    this.key = Buffer.from(key);
  }
  digest(subject: string): string {
    if (!/^synthetic-[0-9a-f-]{36}$/.test(subject))
      throw new DeletionError('NON_SYNTHETIC_IDENTITY');
    return createHmac('sha256', this.key)
      .update(JSON.stringify(['wechat', SYNTHETIC_APP, subject]))
      .digest('hex');
  }
}
