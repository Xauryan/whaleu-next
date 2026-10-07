import { ClientError } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { exact, invalid } from './contract';
import {
  decodeReportIntent,
  decodeReportReceipt,
  matchReportReceipt,
  type ReportIntent,
  type ReportOperation,
  type ReportReceipt,
} from './report-contract';
export interface PendingReport {
  readonly version: 1;
  readonly accountId: string;
  readonly intent: ReportIntent;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = () =>
  new ClientError('storage', 'Report recovery storage unavailable');
function decode(
  value: unknown,
  accountId: string,
  operation: ReportOperation,
): PendingReport {
  exact(value, ['version', 'accountId', 'intent']);
  if (
    value.version !== 1 ||
    !isUuid(accountId) ||
    value.accountId !== accountId
  )
    invalid();
  const intent = decodeReportIntent(value.intent);
  if (intent.operation !== operation) invalid();
  return Object.freeze({ version: 1, accountId, intent });
}
/** Physically separate report/vote journals; neither can overwrite another feature or operation. */
export class PendingReportStore {
  constructor(
    private readonly storage: Storage,
    private readonly namespace: string,
    readonly operation: ReportOperation,
  ) {}
  private key(accountId: string): string {
    if (!isUuid(accountId)) throw unavailable();
    return `whaleu.safety.${this.operation}.pending.v1:${this.namespace}:${accountId}`;
  }
  load(accountId: string): PendingReport | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId, this.operation);
    } catch {
      throw unavailable();
    }
  }
  freeze(attempt: PendingReport): PendingReport {
    try {
      const checked = decode(attempt, attempt.accountId, this.operation),
        old = this.load(attempt.accountId);
      if (old && !equal(old, checked)) throw unavailable();
      if (!old) this.storage.set(this.key(attempt.accountId), checked);
      const saved = this.load(attempt.accountId);
      if (!saved || !equal(saved, checked)) throw unavailable();
      return saved;
    } catch {
      throw unavailable();
    }
  }
  settle(attempt: PendingReport, raw: ReportReceipt): ReportReceipt {
    const result = decodeReportReceipt(raw);
    matchReportReceipt(attempt.intent, result);
    let cleanupStarted = false;
    try {
      const current = this.load(attempt.accountId);
      if (!current || !equal(current, attempt)) throw unavailable();
      cleanupStarted = true;
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      // A storage adapter may remove and then throw, or fail its readback.
      // Restore the validated original key best-effort; never create a new intent.
      if (cleanupStarted) {
        try {
          this.storage.set(this.key(attempt.accountId), attempt);
        } catch {
          /* The controller also retains the original immutable attempt. */
        }
      }
      throw unavailable();
    }
    return result;
  }
}
