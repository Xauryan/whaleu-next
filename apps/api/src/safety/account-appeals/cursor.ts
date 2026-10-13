import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
const schema = z.strictObject({
  v: z.literal(1),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  limit: z.number().int().min(1).max(50),
  at: z.iso.datetime({ precision: 3 }),
  id: z.uuid(),
});
const scope = (actor: string, management: boolean) =>
  createHash('sha256')
    .update(JSON.stringify(['account-appeals:v1', actor, management]))
    .digest('hex');
export interface AppealSeek {
  at: string;
  id: string;
}
export function decodeAppealCursor(
  cursor: string | undefined,
  actor: string,
  management: boolean,
  limit: number,
): AppealSeek | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = schema.parse(JSON.parse(bytes.toString('utf8')));
    if (value.scope !== scope(actor, management) || value.limit !== limit)
      throw new Error();
    return { at: value.at, id: value.id };
  } catch {
    throw new BadRequestException('Invalid request');
  }
}
export function encodeAppealCursor(
  seek: AppealSeek,
  actor: string,
  management: boolean,
  limit: number,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, scope: scope(actor, management), limit, ...seek }),
  ).toString('base64url');
}
