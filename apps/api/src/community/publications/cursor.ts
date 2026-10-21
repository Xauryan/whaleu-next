import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PublicationKind } from './contracts.js';

export interface PublicationAnchor {
  targetKind: PublicationKind;
  at: string;
  id: string;
}
export const publicationAnchorSchema = z.strictObject({
  targetKind: z.enum(['post', 'comment', 'reply']),
  at: z.iso.datetime({ precision: 3 }),
  id: z.uuid(),
});
export function publicationCursorScope(
  owner: string,
  session: string,
  limit: number,
  kind: 'topic' | 'reply',
  identity: 'named' | 'anonymous',
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'community-owner-publications-v1',
        owner.toLowerCase(),
        session.toLowerCase(),
        limit,
        kind,
        identity,
      ]),
    )
    .digest('hex');
}
/** Newest publication first; kind breaks equal timestamp/UUID ties across tables. */
export function comparePublicationAnchors(
  a: PublicationAnchor,
  b: PublicationAnchor,
): number {
  return (
    b.at.localeCompare(a.at) ||
    b.id.localeCompare(a.id) ||
    b.targetKind.localeCompare(a.targetKind)
  );
}
