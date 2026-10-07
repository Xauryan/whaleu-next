import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { Seek } from './community.repository.js';
const cursorSchema = z.strictObject({
  v: z.literal(1),
  scope: z.string().max(200),
  limit: z.number().int().min(1).max(10),
  at: z.iso.datetime({ precision: 3 }),
  id: z.uuid(),
});
export function decodeCursor(
  cursor: string | undefined,
  scope: string,
  limit: number,
): Seek | null {
  if (!cursor) return null;
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (parsed.scope !== scope || parsed.limit !== limit) throw new Error();
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid request');
  }
}
export function encodeCursor(seek: Seek, scope: string, limit: number): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, limit, ...seek })).toString(
    'base64url',
  );
}
