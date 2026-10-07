import { z } from 'zod';
import { textSchema } from '../text.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';

export const tradingSubtypeSchema = z.enum([
  'qiugou',
  'shuma',
  'shujia',
  'yifu',
  'meizhuang',
  'yundong',
  'riyong',
  'shipin',
  'kaquan',
  'xiangbao',
  'zixingche',
  'diandongche',
  'xianshiqi',
]);
export type TradingSubtype = z.infer<typeof tradingSubtypeSchema>;
/** Exact decimal only. The legacy price envelope was 100 bytes, not two decimals. */
export function canonicalPrice(value: string): string | null {
  if (value.length > 100 || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return null;
  const [whole = '', fraction = ''] = value.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const decimals = fraction.replace(/0+$/, '');
  if (
    integer.length > 5 ||
    (integer === '99999' && decimals) ||
    (integer === '0' && !decimals)
  )
    return null;
  return decimals ? `${integer}.${decimals}` : integer;
}
const priceSchema = z
  .string()
  .refine((value) => canonicalPrice(value) !== null)
  .transform((value) => canonicalPrice(value)!);
// Preserve the source server's byte ceilings without its unsafe byte truncation.
const byteText = (maximum: number) =>
  textSchema(maximum).refine(
    (value) => Buffer.byteLength(value, 'utf8') <= maximum,
  );
export const tradingContactsSchema = z
  .strictObject({
    wechat: byteText(50),
    qq: byteText(50),
    phone: byteText(50),
  })
  .refine((value) =>
    Object.values(value).some((contact) => contact.trim().length > 0),
  );
export const tradingInputSchema = z
  .strictObject({
    subtype: tradingSubtypeSchema,
    price: priceSchema,
    urgency: z.enum(['normal', 'urgent']).default('urgent'),
    location: byteText(200).refine((value) => value.trim().length > 0),
    contacts: tradingContactsSchema,
  })
  .transform((value) => ({
    ...value,
    urgency: value.subtype === 'qiugou' ? ('normal' as const) : value.urgency,
  }));
export type TradingInput = z.infer<typeof tradingInputSchema>;
export type TradingContacts = z.infer<typeof tradingContactsSchema>;
export const resolutionSchema = z.enum(['open', 'resolved']);
export const setTradingResolutionSchema = z.strictObject({
  clientRequestId: z.uuidv4(),
  resolution: resolutionSchema,
});
export type SetTradingResolution = z.infer<typeof setTradingResolutionSchema>;
export interface TradingView {
  subtype:
    | { kind: 'known'; key: TradingSubtype; legacyText: string | null }
    | { kind: 'legacy'; text: string };
  price:
    | { kind: 'exact'; amount: string; legacyText: string | null }
    | { kind: 'legacy'; text: string };
  urgency: 'normal' | 'urgent';
  location: string;
  resolution: 'open' | 'resolved';
  viewer: { canSetResolution: boolean };
}
export type TradingReceipt =
  | {
      requestId: string;
      operation: 'set_trading_resolution';
      outcome: 'applied';
      resourceId: string;
      resolution: 'open' | 'resolved';
    }
  | {
      requestId: string;
      operation: 'set_trading_resolution';
      outcome: 'rejected';
      code: ApplicationErrorCode;
    };
