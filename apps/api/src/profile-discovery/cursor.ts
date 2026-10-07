import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SessionView } from '../identity/contracts.js';
import type { PublicContentKind } from '../community/profile-discovery.facade.js';
import type { ProfileContentQuery } from './contracts.js';

const schema = z.strictObject({
  v: z.literal(1),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  at: z.iso.datetime({ precision: 3 }),
  id: z.uuid(),
});
export function profileCursorScope(
  profileId: string,
  kind: PublicContentKind,
  query: ProfileContentQuery,
  session: SessionView | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'public-profile-discovery-v1',
        profileId,
        kind,
        query.tradingSubtype ?? null,
        query.limit,
        session?.accountId ?? null,
        session?.sessionId ?? null,
      ]),
    )
    .digest('hex');
}
export function decodeProfileCursor(cursor: string | undefined, scope: string) {
  if (!cursor) return null;
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const parsed = schema.parse(JSON.parse(bytes.toString('utf8')));
    if (parsed.scope !== scope) throw new Error();
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid request');
  }
}
export function encodeProfileCursor(
  at: string,
  id: string,
  scope: string,
): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, at, id })).toString(
    'base64url',
  );
}
