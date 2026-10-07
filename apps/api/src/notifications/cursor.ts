import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ownerCursorScope } from '../community/cursor-scope.js';
const schema = z.strictObject({
  v: z.literal(1),
  scope: z.string().max(100),
  limit: z.number().int().min(1).max(50),
  at: z.iso.datetime({ precision: 3 }),
  id: z.uuid(),
});
export function updatesCursor(
  cursor: string | undefined,
  accountId: string,
  limit: number,
) {
  if (!cursor) return null;
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const parsed = schema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (
      parsed.scope !== ownerCursorScope('updates', accountId) ||
      parsed.limit !== limit
    )
      throw new Error();
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid request');
  }
}
export function encodeUpdatesCursor(
  at: string,
  id: string,
  accountId: string,
  limit: number,
) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      scope: ownerCursorScope('updates', accountId),
      limit,
      at,
      id,
    }),
  ).toString('base64url');
}
