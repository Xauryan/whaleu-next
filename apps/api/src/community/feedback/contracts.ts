import { z } from 'zod';
import { textSchema } from '../text.js';
// Same reviewed byte bounds as the established Community contact fields, but
// feedback contacts are optional. Empty fields never invent contact consent.
const contact = textSchema(50).refine(
  (v) => Buffer.byteLength(v, 'utf8') <= 50,
);
export const feedbackContactsSchema = z.strictObject({
  wechat: contact,
  qq: contact,
  phone: contact,
});
export const feedbackInputSchema = z.strictObject({
  contacts: feedbackContactsSchema,
});
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;
export interface FeedbackView {
  /** Institution name from the author's reviewed affiliation; no private ID. */
  authorSchool: string | null;
  hasContacts: boolean;
}
