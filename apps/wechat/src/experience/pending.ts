import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { Storage } from '../platform/contracts';
import {
  decodeExperienceIntent,
  decodeExperienceReceipt,
  exactExperience,
  experienceUuid,
  invalidExperience,
  matchExperienceReceipt,
  type ExperienceIntent,
  type ExperienceOperation,
  type ExperienceReceipt,
} from './contract';
export type PendingExperience = {
  readonly version: 1;
  readonly accountId: string;
  readonly intent: ExperienceIntent;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = () =>
  new ClientError('storage', 'Experience recovery storage unavailable');
function decode(
  value: unknown,
  accountId: string,
  operation: ExperienceOperation,
): PendingExperience {
  exactExperience(value, ['version', 'accountId', 'intent']);
  const intent = decodeExperienceIntent(value.intent);
  if (
    value.version !== 1 ||
    !experienceUuid(accountId) ||
    value.accountId !== accountId ||
    intent.operation !== operation
  )
    invalidExperience();
  return Object.freeze({ version: 1, accountId, intent });
}
/** Separate lanes allow a blocked sign-in and a valid owned-title selection to coexist. */
export class PendingExperienceStore {
  private readonly namespace: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.namespace = origin;
  }
  private key(accountId: string, operation: ExperienceOperation): string {
    if (
      !experienceUuid(accountId) ||
      !['sign_in', 'appearance'].includes(operation)
    )
      throw unavailable();
    return `whaleu.experience.pending.v1:${normalizeOrigin(this.namespace)}:${accountId}:${operation}`;
  }
  load(
    accountId: string,
    operation: ExperienceOperation,
  ): PendingExperience | null {
    try {
      const v = this.storage.get(this.key(accountId, operation));
      return v === undefined || v === null || v === ''
        ? null
        : decode(v, accountId, operation);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingExperience): PendingExperience {
    try {
      const checked = decode(raw, raw.accountId, raw.intent.operation),
        old = this.load(raw.accountId, raw.intent.operation);
      if (old && !same(old, checked)) throw unavailable();
      if (!old)
        this.storage.set(
          this.key(raw.accountId, raw.intent.operation),
          checked,
        );
      const saved = this.load(raw.accountId, raw.intent.operation);
      if (!saved || !same(saved, checked)) throw unavailable();
      return saved;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(attempt: PendingExperience): void {
    if (!same(this.load(attempt.accountId, attempt.intent.operation), attempt))
      throw unavailable();
  }
  settle(
    attempt: PendingExperience,
    raw: ExperienceReceipt,
  ): ExperienceReceipt {
    const receipt = decodeExperienceReceipt(raw);
    matchExperienceReceipt(attempt.intent, receipt);
    try {
      this.assertOriginal(attempt);
      this.storage.remove(
        this.key(attempt.accountId, attempt.intent.operation),
      );
      if (this.load(attempt.accountId, attempt.intent.operation))
        throw unavailable();
    } catch {
      throw unavailable();
    }
    return receipt;
  }
}
