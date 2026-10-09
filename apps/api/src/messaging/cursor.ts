import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ApplicationError } from '../http/application-error.js';
import { dmId, dmSequence } from './contracts.js';
const cursor = z.strictObject({
  v: z.literal(1),
  purpose: z.enum(['list', 'history', 'events']),
  owner: z.string().regex(/^[a-f0-9]{64}$/),
  conversation: dmId.nullable(),
  sequence: dmSequence,
  epoch: dmSequence,
  at: z.iso.datetime().nullable(),
  id: dmId.nullable(),
  limit: z.number().int().min(1).max(50),
});
type Cursor = z.infer<typeof cursor>;
const owner = (actor: string) =>
  createHash('sha256')
    .update('whaleu:dm-cursor:v1:' + actor)
    .digest('hex');
export function encodeDmCursor(
  actor: string,
  data: Omit<Cursor, 'v' | 'owner'>,
) {
  return Buffer.from(
    JSON.stringify({ v: 1, owner: owner(actor), ...data }),
  ).toString('base64url');
}
export function decodeDmCursor(
  raw: string,
  actor: string,
  purpose: Cursor['purpose'],
  conversation: string | null,
  limit: number,
) {
  try {
    if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const data = cursor.parse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
    if (
      data.owner !== owner(actor) ||
      data.purpose !== purpose ||
      data.conversation !== conversation ||
      data.limit !== limit
    )
      throw new Error();
    return data;
  } catch {
    throw new ApplicationError('DM_CURSOR_STALE');
  }
}
