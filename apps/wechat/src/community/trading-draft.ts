import { boundedText, exact, invalid } from './contract';
import {
  isTradingSubtype,
  decodeTradingIntent,
  type TradingIntent,
  type TradingSubtype,
} from './trading-contract';
export interface TradingDraft {
  readonly subtype: TradingSubtype;
  readonly price: string;
  readonly urgency: 'normal' | 'urgent';
  readonly location: string;
  readonly wechat: string;
  readonly qq: string;
  readonly phone: string;
  readonly contactConsent: boolean;
}
export const emptyTradingDraft = (): TradingDraft => ({
  subtype: 'shuma',
  price: '',
  urgency: 'urgent',
  location: '',
  wechat: '',
  qq: '',
  phone: '',
  contactConsent: false,
});
export function decodeTradingDraft(value: unknown): TradingDraft {
  exact(value, [
    'subtype',
    'price',
    'urgency',
    'location',
    'wechat',
    'qq',
    'phone',
    'contactConsent',
  ]);
  if (
    !isTradingSubtype(value.subtype) ||
    (value.urgency !== 'urgent' && value.urgency !== 'normal') ||
    (value.subtype === 'qiugou' && value.urgency !== 'normal') ||
    typeof value.contactConsent !== 'boolean' ||
    ![value.price, value.location, value.wechat, value.qq, value.phone].every(
      (item) =>
        typeof item === 'string' &&
        boundedText(item.replace(/\r\n/g, '\n'), 0, 10000),
    )
  )
    invalid();
  return Object.freeze({
    subtype: value.subtype,
    price: value.price as string,
    urgency: value.urgency,
    location: value.location as string,
    wechat: value.wechat as string,
    qq: value.qq as string,
    phone: value.phone as string,
    contactConsent: value.contactConsent,
  });
}
export function tradingDraftIntent(draft: TradingDraft): TradingIntent {
  return decodeTradingIntent({
    subtype: draft.subtype,
    price: draft.price,
    urgency: draft.subtype === 'qiugou' ? 'normal' : draft.urgency,
    location: draft.location.replace(/\r\n/g, '\n'),
    contacts: {
      wechat: draft.wechat.replace(/\r\n/g, '\n'),
      qq: draft.qq.replace(/\r\n/g, '\n'),
      phone: draft.phone.replace(/\r\n/g, '\n'),
    },
  });
}
export const intentTradingDraft = (intent: TradingIntent): TradingDraft => ({
  subtype: intent.subtype,
  price: intent.price,
  urgency: intent.urgency,
  location: intent.location,
  ...intent.contacts,
  contactConsent: true,
});
