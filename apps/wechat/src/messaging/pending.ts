import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import type { Storage } from '../platform/contracts';
import {
  decodeIntent,
  decodeReceipt,
  exact,
  id,
  invalid,
  matchReceipt,
  type Intent,
  type Operation,
  type Receipt,
} from './contract';
export interface Pending {
  readonly version: 2;
  readonly accountId: string;
  readonly requestId: string;
  readonly operation: Operation;
  readonly intentHash: string;
  readonly intent: Intent | null;
}
export interface FullPending extends Pending {
  readonly intent: Intent;
}
interface OriginalPending {
  readonly version: 1;
  readonly accountId: string;
  readonly intent: Intent;
}
interface Registry {
  readonly version: 2;
  readonly entries: readonly Pending[];
}
const maximumAccounts = 8;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = () =>
  new ClientError('storage', 'Private-message recovery storage unavailable');
export function canonicalDmJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalDmJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalDmJson(value[key])}`)
      .join(',')}}`;
  return invalid();
}
export function intentHash(raw: Intent): string {
  const { operation, ...intent } = decodeIntent(raw);
  return sha256('whaleu:dm:v1\n' + canonicalDmJson({ operation, intent }));
}
function original(v: unknown): FullPending {
  exact(v, ['version', 'accountId', 'intent']);
  if (v.version !== 1 || !id(v.accountId)) invalid();
  const intent = decodeIntent(v.intent);
  return Object.freeze({
    version: 2,
    accountId: v.accountId,
    requestId: intent.clientRequestId,
    operation: intent.operation,
    intentHash: intentHash(intent),
    intent,
  });
}
function decode(v: unknown): Pending {
  exact(v, [
    'version',
    'accountId',
    'requestId',
    'operation',
    'intentHash',
    'intent',
  ]);
  if (
    v.version !== 2 ||
    !id(v.accountId) ||
    !id(v.requestId) ||
    !['open', 'send', 'read', 'hide', 'reopen', 'recall', 'block'].includes(
      String(v.operation),
    ) ||
    typeof v.intentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.intentHash)
  )
    invalid();
  const intent = v.intent === null ? null : decodeIntent(v.intent);
  if (
    intent &&
    (intent.clientRequestId !== v.requestId ||
      intent.operation !== v.operation ||
      intentHash(intent) !== v.intentHash)
  )
    invalid();
  return Object.freeze({
    version: 2,
    accountId: v.accountId,
    requestId: v.requestId,
    operation: v.operation as Operation,
    intentHash: v.intentHash,
    intent,
  });
}
function registry(v: unknown): Registry {
  exact(v, ['version', 'entries']);
  if (
    v.version !== 2 ||
    !Array.isArray(v.entries) ||
    v.entries.length > maximumAccounts
  )
    invalid();
  const entries = v.entries.map(decode);
  if (new Set(entries.map((e) => e.accountId)).size !== entries.length)
    invalid();
  return Object.freeze({ version: 2, entries: Object.freeze(entries) });
}
/** Bounded account-isolated request commitments survive logout. Only explicit pending bodies
 * are scrubbed. Unknown requests are never evicted or given a replacement key. */
export class PendingMessagingStore {
  private readonly key: string;
  private readonly legacyKey: string;
  constructor(
    private readonly storage: Storage,
    namespace: string,
  ) {
    this.key = `whaleu.private-messages.pending.v2:${namespace}`;
    this.legacyKey = `whaleu.private-messages.pending.v1:${namespace}`;
  }
  private write(value: Registry): void {
    const checked = registry(value);
    this.storage.set(this.key, checked);
    if (!same(registry(this.storage.get(this.key)), checked))
      throw unavailable();
  }
  private read(): Registry {
    try {
      const raw = this.storage.get(this.key);
      let current: Registry =
        raw === undefined || raw === null || raw === ''
          ? { version: 2, entries: [] }
          : registry(raw);
      const legacyRaw = this.storage.get(this.legacyKey);
      if (legacyRaw !== undefined && legacyRaw !== null && legacyRaw !== '') {
        const legacy = original(legacyRaw),
          existing = current.entries.find(
            (e) => e.accountId === legacy.accountId,
          );
        if (
          existing &&
          (existing.requestId !== legacy.requestId ||
            existing.intentHash !== legacy.intentHash)
        )
          throw unavailable();
        if (!existing) {
          if (current.entries.length >= maximumAccounts) throw unavailable();
          current = { version: 2, entries: [...current.entries, legacy] };
          this.write(current);
        }
        this.storage.remove(this.legacyKey);
        const after = this.storage.get(this.legacyKey);
        if (after !== undefined && after !== null && after !== '')
          throw unavailable();
      }
      return current;
    } catch {
      throw unavailable();
    }
  }
  load(accountId: string): Pending | null {
    if (!id(accountId)) throw unavailable();
    return this.read().entries.find((e) => e.accountId === accountId) ?? null;
  }
  assertStored(attempt: Pending): void {
    const current = this.load(attempt.accountId);
    if (!current || !same(current, decode(attempt))) throw unavailable();
  }
  freeze(raw: OriginalPending | FullPending): FullPending {
    try {
      const checked = raw.version === 1 ? original(raw) : decode(raw);
      if (!checked.intent) throw unavailable();
      const current = this.read(),
        old = current.entries.find((e) => e.accountId === checked.accountId);
      if (old && !same(old, checked)) throw unavailable();
      if (!old) {
        if (current.entries.length >= maximumAccounts)
          throw new ClientError(
            'storage',
            '未确认私信记录已满，请登录原账号查询或安全取消原请求',
          );
        this.write({ version: 2, entries: [...current.entries, checked] });
      }
      const saved = this.load(checked.accountId);
      if (!saved?.intent || !same(saved, checked)) throw unavailable();
      return Object.freeze({ ...saved, intent: saved.intent });
    } catch (error) {
      if (error instanceof ClientError) throw error;
      throw unavailable();
    }
  }
  settle(attempt: Pending, raw: Receipt): Receipt {
    const receipt = decodeReceipt(raw);
    if (
      attempt.requestId !== receipt.requestId ||
      attempt.operation !== receipt.operation
    )
      invalid();
    if (attempt.intent) matchReceipt(attempt.intent, receipt);
    try {
      this.assertStored(attempt);
      const current = this.read();
      this.write({
        version: 2,
        entries: current.entries.filter(
          (e) => e.accountId !== attempt.accountId,
        ),
      });
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return receipt;
  }
  /** With an active account at relaunch, retain only that account's explicit original body. */
  scrubBodies(exceptAccountId?: string): void {
    try {
      const current = this.read();
      const entries = current.entries.map((entry) =>
        entry.accountId === exceptAccountId
          ? entry
          : Object.freeze({ ...entry, intent: null }),
      );
      if (!same(entries, current.entries)) this.write({ version: 2, entries });
    } catch {
      throw unavailable();
    }
  }
}
