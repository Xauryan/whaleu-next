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
export interface ModerationSeek {
  at: string;
  id: string;
}
const scope = (actor: string, family: string) =>
  createHash('sha256')
    .update(JSON.stringify(['account-moderation-cursor:v1', actor, family]))
    .digest('hex');
export function moderationCursor(
  value: string | undefined,
  actor: string,
  family: string,
  limit: number,
): ModerationSeek | null {
  if (value === undefined) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (value.length > 1024 || bytes.toString('base64url') !== value)
      throw new Error();
    const parsed = schema.parse(JSON.parse(bytes.toString('utf8')));
    if (parsed.scope !== scope(actor, family) || parsed.limit !== limit)
      throw new Error();
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid request');
  }
}
export function encodeModerationCursor(
  seek: ModerationSeek,
  actor: string,
  family: string,
  limit: number,
): string {
  return Buffer.from(
    JSON.stringify({ v: 1, scope: scope(actor, family), limit, ...seek }),
  ).toString('base64url');
}
