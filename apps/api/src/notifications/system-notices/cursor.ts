import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { SystemNoticeKind } from './contracts.js';

const fields = {
  scope: z.string().regex(/^system-notices:[a-f0-9]{64}$/),
  limit: z.number().int().min(1).max(50),
  at: z.iso.datetime({ precision: 3 }),
  id: z.uuid(),
};
const schema = z.discriminatedUnion('v', [
  z.strictObject({ v: z.literal(1), ...fields }),
  z.strictObject({
    v: z.literal(2),
    ...fields,
    kind: z.enum(['post_jury_removed', 'profile_nickname_reset']),
  }),
]);
export interface SystemNoticesSeek {
  at: string;
  id: string;
  kind: SystemNoticeKind;
}
// This scope is an opaque owner binding, never an authorization grant. Every
// request independently authenticates the owner before the cursor is consumed.
const ownerScope = (accountId: string) =>
  `system-notices:${createHash('sha256')
    .update(
      JSON.stringify(['system-notices-cursor-v1', accountId.toLowerCase()]),
    )
    .digest('hex')}`;

export function systemNoticesCursor(
  cursor: string | undefined,
  accountId: string,
  limit: number,
): SystemNoticesSeek | null {
  if (cursor === undefined) return null;
  try {
    if (
      !cursor.length ||
      cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)
    )
      throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const parsed = schema.parse(JSON.parse(bytes.toString('utf8')));
    if (parsed.scope !== ownerScope(accountId) || parsed.limit !== limit)
      throw new Error();
    // Cursors issued before profile moderation can only refer to jury notices.
    // The global ID registry preserves their exact seek boundary in the union.
    return {
      at: parsed.at,
      id: parsed.id,
      kind: parsed.v === 1 ? 'post_jury_removed' : parsed.kind,
    };
  } catch {
    throw new BadRequestException('Invalid request');
  }
}

export function encodeSystemNoticesCursor(
  at: string,
  id: string,
  accountId: string,
  limit: number,
  kind: SystemNoticeKind = 'post_jury_removed',
) {
  return Buffer.from(
    JSON.stringify({ v: 2, scope: ownerScope(accountId), limit, at, id, kind }),
  ).toString('base64url');
}
