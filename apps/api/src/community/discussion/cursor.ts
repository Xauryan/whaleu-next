import { BadRequestException } from '@nestjs/common';
import { ApplicationError } from '../../http/application-error.js';
import { z } from 'zod';
const rootSchema = z.strictObject({
  v: z.literal(3),
  scope: z.string().max(300),
  limit: z.number().int().min(1).max(10),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().min(1).max(1024),
});
const legacyRootSchema = rootSchema.extend({ v: z.literal(2) });
const replySchema = z.strictObject({
  v: z.literal(1),
  scope: z.string().max(200),
  limit: z.number().int().min(1).max(50),
  sequence: z.string().regex(/^[1-9][0-9]{0,18}$/),
});
function read(cursor: string): unknown {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid request');
  }
}
export function rootCursor(
  cursor: string | undefined,
  scope: string,
  limit: number,
) {
  if (!cursor) return null;
  const value = read(cursor);
  // v2 coupled all off-page reply counts into traversal. A client must discard
  // that traversal explicitly rather than accidentally treating it as v3.
  if (legacyRootSchema.safeParse(value).success)
    throw new ApplicationError('DISCUSSION_RESTART_REQUIRED');
  const parsed = rootSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid request');
  if (parsed.data.scope !== scope || parsed.data.limit !== limit)
    throw new ApplicationError('DISCUSSION_RESTART_REQUIRED');
  return parsed.data;
}
export function replyCursor(
  cursor: string | undefined,
  scope: string,
  limit: number,
) {
  if (!cursor) return null;
  const parsed = replySchema.safeParse(read(cursor));
  if (
    !parsed.success ||
    parsed.data.scope !== scope ||
    parsed.data.limit !== limit
  )
    throw new BadRequestException('Invalid request');
  return parsed.data.sequence;
}
export function encodeDiscussionCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
