import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const schema = z.strictObject({
  v: z.literal(1),
  scope: z.string().regex(/^system-notices:[a-f0-9]{64}$/),
  limit: z.number().int().min(1).max(50),
  at: z.iso.datetime({ precision: 3 }),
  id: z.uuid(),
});
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
) {
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
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid request');
  }
}

export function encodeSystemNoticesCursor(
  at: string,
  id: string,
  accountId: string,
  limit: number,
) {
  return Buffer.from(
    JSON.stringify({ v: 1, scope: ownerScope(accountId), limit, at, id }),
  ).toString('base64url');
}
