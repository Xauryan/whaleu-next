import type { Storage } from '../platform/contracts';
import { ClientError } from '../api/errors';
import { exact, id, invalid } from './contract';
export interface PendingImage {
  readonly accountId: string;
  readonly conversationId: string;
  readonly messageRequestId: string;
  readonly uploadRequestId: string;
  readonly uploadHash: string;
}
function decode(v: unknown): PendingImage {
  exact(v, [
    'accountId',
    'conversationId',
    'messageRequestId',
    'uploadRequestId',
    'uploadHash',
  ]);
  if (
    !id(v.accountId) ||
    !id(v.conversationId) ||
    !id(v.messageRequestId) ||
    !id(v.uploadRequestId) ||
    typeof v.uploadHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.uploadHash)
  )
    invalid();
  return Object.freeze({
    accountId: v.accountId,
    conversationId: v.conversationId,
    messageRequestId: v.messageRequestId,
    uploadRequestId: v.uploadRequestId,
    uploadHash: v.uploadHash,
  });
}
/** Only unresolved identities and hashes. No file paths, bytes, declaration,
 * image descriptor, asset manifest or committed history reaches storage. */
export class PendingPrivateMessageImages {
  private readonly key: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.key = 'whaleu.private-messages.images.v1:' + origin;
  }
  private rows(): PendingImage[] {
    try {
      const raw = this.storage.get(this.key);
      if (raw === undefined || raw === null || raw === '') return [];
      exact(raw, ['version', 'entries']);
      if (
        raw.version !== 1 ||
        !Array.isArray(raw.entries) ||
        raw.entries.length > 8
      )
        invalid();
      const rows = raw.entries.map(decode);
      if (new Set(rows.map((r) => r.accountId)).size !== rows.length) invalid();
      return rows;
    } catch {
      throw new ClientError('storage', '图片恢复记录不可读');
    }
  }
  private write(rows: PendingImage[]) {
    const value = { version: 1, entries: rows };
    this.storage.set(this.key, value);
    if (JSON.stringify(this.rows()) !== JSON.stringify(rows))
      throw new ClientError('storage', '图片恢复记录未保存');
  }
  load(account: string) {
    return this.rows().find((r) => r.accountId === account) ?? null;
  }
  freeze(raw: PendingImage) {
    const value = decode(raw),
      rows = this.rows(),
      old = this.load(value.accountId);
    if (old && JSON.stringify(old) !== JSON.stringify(value))
      throw new ClientError('storage', '请先恢复或安全取消原图片请求');
    if (!old) {
      if (rows.length === 8)
        throw new ClientError('storage', '图片恢复记录已满');
      this.write([...rows, value]);
    }
    return value;
  }
  clear(value: PendingImage) {
    if (JSON.stringify(this.load(value.accountId)) !== JSON.stringify(value))
      throw new ClientError('storage', '图片原请求不匹配');
    this.write(this.rows().filter((r) => r.accountId !== value.accountId));
  }
}
