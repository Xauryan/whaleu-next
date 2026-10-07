import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { LikedKind } from './contracts.js';

const schema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('community_liked'),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  limit: z.number().int().min(1).max(50),
  targetKind: z.enum(['post', 'comment', 'reply']),
  at: z.iso.datetime({ precision: 3 }).nullable(),
  id: z.uuid().transform((value) => value.toLowerCase()),
});
export interface LikedAnchor {
  targetKind: LikedKind;
  at: string | null;
  id: string;
}
function scope(owner: string, session: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'community-liked-v1',
        owner.toLowerCase(),
        session.toLowerCase(),
      ]),
    )
    .digest('hex');
}
export function decodeLikedCursor(
  value: string | undefined,
  owner: string,
  session: string,
  limit: number,
): LikedAnchor | null {
  if (value === undefined) return null;
  try {
    if (!value.length || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const parsed = schema.parse(JSON.parse(bytes.toString('utf8')));
    if (parsed.scope !== scope(owner, session) || parsed.limit !== limit)
      throw new Error();
    return { targetKind: parsed.targetKind, at: parsed.at, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid request');
  }
}
export function encodeLikedCursor(
  anchor: LikedAnchor,
  owner: string,
  session: string,
  limit: number,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kind: 'community_liked',
      scope: scope(owner, session),
      limit,
      ...anchor,
    }),
  ).toString('base64url');
}
/** Known times first, newest first. Undated records remain reachable by ID.
 * Kind is the final deterministic tie-breaker across independent like tables. */
export function compareLikedAnchors(a: LikedAnchor, b: LikedAnchor): number {
  if (a.at === null && b.at !== null) return 1;
  if (a.at !== null && b.at === null) return -1;
  return (
    (b.at ?? '').localeCompare(a.at ?? '') ||
    b.id.localeCompare(a.id) ||
    b.targetKind.localeCompare(a.targetKind)
  );
}
