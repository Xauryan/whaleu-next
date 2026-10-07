import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import {
  boundedText,
  displayDiscussionText,
  exact,
  invalid,
  uuid4,
} from './contract';

export const tradingCategories = [
  { key: 'qiugou', label: '求购' },
  { key: 'shuma', label: '数码' },
  { key: 'shujia', label: '书籍' },
  { key: 'yifu', label: '衣服' },
  { key: 'meizhuang', label: '美妆' },
  { key: 'yundong', label: '运动' },
  { key: 'riyong', label: '日用' },
  { key: 'shipin', label: '食品' },
  { key: 'kaquan', label: '卡券' },
  { key: 'xiangbao', label: '箱包' },
  { key: 'zixingche', label: '自行车' },
  { key: 'diandongche', label: '电动车' },
  { key: 'xianshiqi', label: '显示器' },
] as const;
export type TradingSubtype = (typeof tradingCategories)[number]['key'];
export type TradingResolution = 'open' | 'resolved';
export interface TradingContacts {
  readonly wechat: string;
  readonly qq: string;
  readonly phone: string;
}
export interface TradingIntent {
  readonly subtype: TradingSubtype;
  readonly price: string;
  readonly urgency: 'normal' | 'urgent';
  readonly location: string;
  readonly contacts: TradingContacts;
}
export interface TradingView {
  readonly price:
    | {
        readonly kind: 'exact';
        readonly amount: string;
        readonly legacyText: string | null;
      }
    | { readonly kind: 'legacy'; readonly text: string };
  readonly subtype:
    | {
        readonly kind: 'known';
        readonly key: TradingSubtype;
        readonly legacyText: string | null;
      }
    | { readonly kind: 'legacy'; readonly text: string };
  readonly urgency: 'normal' | 'urgent';
  readonly location: string;
  readonly resolution: TradingResolution;
  readonly viewer: { readonly canSetResolution: boolean };
}
export interface TradingContactView {
  readonly postId: string;
  readonly contacts: TradingContacts;
}
export type TradingReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'set_trading_resolution';
      readonly outcome: 'applied';
      readonly resourceId: string;
      readonly resolution: TradingResolution;
    }
  | {
      readonly requestId: string;
      readonly operation: 'set_trading_resolution';
      readonly outcome: 'rejected';
      readonly code: string;
    };
export const isTradingSubtype = (value: unknown): value is TradingSubtype =>
  typeof value === 'string' &&
  tradingCategories.some((item) => item.key === value);
export const isTradingResolution = (
  value: unknown,
): value is TradingResolution => value === 'open' || value === 'resolved';
/** Exact decimal text. No Number/parseFloat conversion, scale rounding or exponent coercion. */
export function exactTradingPrice(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 100 ||
    !/^\d+(?:\.\d+)?$/.test(value) ||
    /[^0-9.]/.test(value)
  )
    invalid();
  const [rawWhole, rawFraction = ''] = value.split('.');
  const whole = rawWhole!.replace(/^0+(?=\d)/, ''),
    fraction = rawFraction.replace(/0+$/, '');
  if (
    (whole === '0' && !fraction) ||
    whole.length > 5 ||
    (whole === '99999' && fraction)
  )
    invalid();
  return whole + (fraction ? `.${fraction}` : '');
}
function utf8Length(value: string): number {
  return [...value].reduce((sum, character) => {
    const point = character.codePointAt(0)!;
    return (
      sum + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4)
    );
  }, 0);
}
export function tradingText(
  value: unknown,
  maximum: number,
  required = true,
): value is string {
  return (
    boundedText(value, 0, maximum) &&
    !value.includes('\r') &&
    utf8Length(value) <= maximum &&
    (!required || !!value.trim())
  );
}
export function decodeTradingContacts(value: unknown): TradingContacts {
  exact(value, ['wechat', 'qq', 'phone']);
  if (
    !tradingText(value.wechat, 50, false) ||
    !tradingText(value.qq, 50, false) ||
    !tradingText(value.phone, 50, false) ||
    ![value.wechat, value.qq, value.phone].some((item) => item.trim())
  )
    invalid();
  return Object.freeze({
    wechat: value.wechat,
    qq: value.qq,
    phone: value.phone,
  });
}
function fields(
  value: Record<string, unknown>,
): Omit<TradingIntent, 'contacts'> {
  if (
    !isTradingSubtype(value.subtype) ||
    (value.urgency !== 'normal' && value.urgency !== 'urgent') ||
    !tradingText(value.location, 200) ||
    (value.subtype === 'qiugou' && value.urgency !== 'normal')
  )
    invalid();
  return {
    subtype: value.subtype,
    price: exactTradingPrice(value.price),
    urgency: value.urgency as TradingIntent['urgency'],
    location: value.location,
  };
}
export function decodeTradingIntent(value: unknown): TradingIntent {
  exact(value, ['subtype', 'price', 'urgency', 'location', 'contacts']);
  return Object.freeze({
    ...fields(value),
    contacts: decodeTradingContacts(value.contacts),
  });
}
export function decodeTradingView(value: unknown): TradingView {
  exact(value, [
    'subtype',
    'price',
    'urgency',
    'location',
    'resolution',
    'viewer',
  ]);
  exact(value.viewer, ['canSetResolution']);
  if (
    !isTradingResolution(value.resolution) ||
    typeof value.viewer.canSetResolution !== 'boolean' ||
    (value.urgency !== 'normal' && value.urgency !== 'urgent') ||
    !displayDiscussionText(value.location)
  )
    invalid();
  if (!isRecord(value.price) || !isRecord(value.subtype)) invalid();
  let price: TradingView['price'], subtype: TradingView['subtype'];
  if (value.price.kind === 'exact') {
    exact(value.price, ['kind', 'amount', 'legacyText']);
    if (
      exactTradingPrice(value.price.amount) !== value.price.amount ||
      !(
        value.price.legacyText === null ||
        displayDiscussionText(value.price.legacyText)
      )
    )
      invalid();
    price = Object.freeze({
      kind: 'exact',
      amount: value.price.amount as string,
      legacyText: value.price.legacyText,
    });
  } else {
    exact(value.price, ['kind', 'text']);
    if (
      value.price.kind !== 'legacy' ||
      !displayDiscussionText(value.price.text)
    )
      invalid();
    price = Object.freeze({ kind: 'legacy', text: value.price.text });
  }
  if (value.subtype.kind === 'known') {
    exact(value.subtype, ['kind', 'key', 'legacyText']);
    if (
      !isTradingSubtype(value.subtype.key) ||
      !(
        value.subtype.legacyText === null ||
        displayDiscussionText(value.subtype.legacyText)
      ) ||
      (value.subtype.key === 'qiugou' && value.urgency !== 'normal')
    )
      invalid();
    subtype = Object.freeze({
      kind: 'known',
      key: value.subtype.key,
      legacyText: value.subtype.legacyText,
    });
  } else {
    exact(value.subtype, ['kind', 'text']);
    if (
      value.subtype.kind !== 'legacy' ||
      !displayDiscussionText(value.subtype.text)
    )
      invalid();
    subtype = Object.freeze({ kind: 'legacy', text: value.subtype.text });
  }
  return Object.freeze({
    subtype,
    price,
    location: value.location,
    urgency: value.urgency as TradingView['urgency'],
    resolution: value.resolution,
    viewer: Object.freeze({ canSetResolution: value.viewer.canSetResolution }),
  });
}
export function decodeTradingContactView(value: unknown): TradingContactView {
  exact(value, ['postId', 'contacts']);
  exact(value.contacts, ['wechat', 'qq', 'phone']);
  if (
    !isUuid(value.postId) ||
    !displayDiscussionText(value.contacts.wechat) ||
    !displayDiscussionText(value.contacts.qq) ||
    !displayDiscussionText(value.contacts.phone)
  )
    invalid();
  return Object.freeze({
    postId: value.postId,
    contacts: Object.freeze({
      wechat: value.contacts.wechat,
      qq: value.contacts.qq,
      phone: value.contacts.phone,
    }),
  });
}
export function decodeTradingReceipt(value: unknown): TradingReceipt {
  if (!isRecord(value)) invalid();
  if (value.outcome === 'applied') {
    exact(value, [
      'requestId',
      'operation',
      'outcome',
      'resourceId',
      'resolution',
    ]);
    if (
      !uuid4(value.requestId) ||
      value.operation !== 'set_trading_resolution' ||
      !isUuid(value.resourceId) ||
      !isTradingResolution(value.resolution)
    )
      invalid();
    return Object.freeze({
      requestId: value.requestId,
      operation: 'set_trading_resolution',
      outcome: 'applied',
      resourceId: value.resourceId,
      resolution: value.resolution,
    });
  }
  exact(value, ['requestId', 'operation', 'outcome', 'code']);
  if (
    !uuid4(value.requestId) ||
    value.operation !== 'set_trading_resolution' ||
    value.outcome !== 'rejected' ||
    typeof value.code !== 'string' ||
    ![
      'POST_NOT_FOUND',
      'COMMUNITY_SCOPE_UNAVAILABLE',
      'PHONE_VERIFICATION_REQUIRED',
      'COMMUNITY_ACTION_RESTRICTED',
    ].includes(value.code)
  )
    invalid();
  return Object.freeze({
    requestId: value.requestId,
    operation: 'set_trading_resolution',
    outcome: 'rejected',
    code: value.code,
  });
}

export const tradingLabels = Object.freeze(
  Object.fromEntries(tradingCategories.map((item) => [item.key, item.label])),
);
