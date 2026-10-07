import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LikedKind } from './contracts.js';

export interface LikedAnchor {
  targetKind: LikedKind;
  at: string | null;
  id: string;
}
export const likedAnchorSchema = z.strictObject({
  targetKind: z.enum(['post', 'comment', 'reply']),
  at: z.iso.datetime({ precision: 3 }).nullable(),
  id: z.uuid(),
});
export function likedCursorScope(
  owner: string,
  session: string,
  limit: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'community-liked-v2',
        owner.toLowerCase(),
        session.toLowerCase(),
        limit,
      ]),
    )
    .digest('hex');
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
