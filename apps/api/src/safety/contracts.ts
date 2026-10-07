import { z } from 'zod';
import type { ApplicationErrorCode } from '../http/application-error.js';
const uuid = z.uuid().transform((id) => id.toLowerCase());
export const sourceSchema = z.strictObject({
  kind: z.enum(['post', 'comment', 'reply', 'profile']),
  id: uuid,
});
export type NamedBlockSource = z.infer<typeof sourceSchema>;
export const blockRequestSchema = z.strictObject({
  clientRequestId: z.uuidv4().transform((id) => id.toLowerCase()),
  source: sourceSchema,
  blocked: z.literal(true),
});
export const unblockRequestSchema = z.strictObject({
  clientRequestId: z.uuidv4().transform((id) => id.toLowerCase()),
  blocked: z.literal(false),
  expectedRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
});
export type BlockRequest = z.infer<typeof blockRequestSchema>;
export type UnblockRequest = z.infer<typeof unblockRequestSchema>;
export const emptyQuerySchema = z.strictObject({});
export const ownBlocksQuerySchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .default('20')
    .transform(Number),
});
export type OwnBlocksQuery = z.infer<typeof ownBlocksQuerySchema>;
export type SafetyOperation = 'block_named' | 'unblock_named';
export interface BlockState {
  relationshipId: string;
  blocked: boolean;
  revision: string;
}
export type BlockReceipt = { requestId: string; operation: SafetyOperation } & (
  | ({ outcome: 'applied' } & BlockState)
  | { outcome: 'rejected'; code: ApplicationErrorCode }
);
export interface BlockResult {
  receipt: BlockReceipt;
  current: BlockState | null;
}
export interface OwnBlock extends BlockState {
  blocked: true;
  blockedAt: string;
  display: {
    kind: 'current' | 'snapshot' | 'unavailable';
    displayName: string | null;
  };
  canUnblock: true;
}
export interface OwnBlocksPage {
  items: OwnBlock[];
  nextCursor: string | null;
}
