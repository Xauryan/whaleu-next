import { z } from 'zod';
import { ratingCategoryScopedReceiptSchema } from '../category-management/scoped-contracts.js';
import { ratingScopedReceiptSchema } from './contracts.js';

/** Shared historical recovery only. The eight existing command decoders retain
 * their original schemas; category outcomes have a separate exact operation
 * union and cannot authorize a public/target command. */
export const ratingScopedRequestReceiptSchema = z.union([
  ratingScopedReceiptSchema,
  ratingCategoryScopedReceiptSchema,
]);
export type RatingScopedRequestReceipt = z.infer<
  typeof ratingScopedRequestReceiptSchema
>;
