import { z } from 'zod';
import type { SessionView } from '../../identity/contracts.js';
import { discoveryScopeHash } from '../discovery-cursors.js';
import {
  hotScoreDecimalSchema,
  HOT_SCORE_IDENTITY,
} from '../hot-score/certificate.js';
import type { HotQuery } from './contracts.js';
export const HOT_POPULATION = 'independent-native-components-v1';
export const HOT_POLICY =
  'explicit-space-publication-age-trading-open-normal-v1';
const uuid = z.uuid().refine((id) => id === id.toLowerCase());
export const hotAnchorSchema = z.strictObject({
  score: hotScoreDecimalSchema,
  id: uuid,
});
export type HotAnchor = z.infer<typeof hotAnchorSchema>;
/** Compare exact fixed-scale integers; never lexical decimal or Number. */
export function hotAnchorFollows(a: HotAnchor, b: HotAnchor): boolean {
  const left = BigInt(a.score.replace('.', '')),
    right = BigInt(b.score.replace('.', ''));
  return left < right || (left === right && a.id < b.id);
}
export const hotVisibleSchema = z.strictObject({
  id: uuid,
  spaceId: uuid,
  at: z.iso.datetime({ precision: 6 }),
});
export type HotVisible = z.infer<typeof hotVisibleSchema>;
export const hotPositionSchema = z
  .strictObject({
    v: z.literal(1),
    kind: z.literal('hot'),
    after: hotAnchorSchema,
    visible: hotVisibleSchema.nullable(),
    emitted: z.number().int().min(0).max(1000),
  })
  .refine((value) => (value.emitted === 0) === (value.visible === null));
export type HotPosition = z.infer<typeof hotPositionSchema>;
export function hotCursorScope(
  query: HotQuery,
  session: SessionView | null,
): string {
  return discoveryScopeHash([
    'community-hot',
    1,
    query.spaceId,
    query.range,
    query.limit,
    HOT_POLICY,
    HOT_POPULATION,
    HOT_SCORE_IDENTITY,
    session?.accountId ?? null,
    session?.sessionId ?? null,
  ]);
}
