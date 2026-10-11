import { boundedText, exact, invalid } from './contract';
import { tradingText } from './trading-contract';
export interface FeedbackContacts {
  readonly wechat: string;
  readonly qq: string;
  readonly phone: string;
}
export interface FeedbackInput {
  readonly contacts: FeedbackContacts;
}
export interface FeedbackView {
  readonly authorSchool: string | null;
  readonly hasContacts: boolean;
}
export interface FeedbackDraft extends FeedbackContacts {
  readonly consent: boolean;
}
export const emptyFeedbackDraft = (): FeedbackDraft => ({
  wechat: '',
  qq: '',
  phone: '',
  consent: false,
});
export function decodeFeedbackContacts(value: unknown): FeedbackContacts {
  exact(value, ['wechat', 'qq', 'phone']);
  if (
    !tradingText(value.wechat, 50, false) ||
    !tradingText(value.qq, 50, false) ||
    !tradingText(value.phone, 50, false)
  )
    invalid();
  return Object.freeze({
    wechat: value.wechat,
    qq: value.qq,
    phone: value.phone,
  });
}
export function decodeFeedbackInput(value: unknown): FeedbackInput {
  exact(value, ['contacts']);
  return Object.freeze({ contacts: decodeFeedbackContacts(value.contacts) });
}
export function decodeFeedbackView(value: unknown): FeedbackView {
  exact(value, ['authorSchool', 'hasContacts']);
  if (
    (value.authorSchool !== null && !boundedText(value.authorSchool, 1, 500)) ||
    typeof value.hasContacts !== 'boolean'
  )
    invalid();
  return Object.freeze({
    authorSchool: value.authorSchool,
    hasContacts: value.hasContacts,
  });
}
export function decodeFeedbackDraft(value: unknown): FeedbackDraft {
  exact(value, ['wechat', 'qq', 'phone', 'consent']);
  if (typeof value.consent !== 'boolean') invalid();
  // In-progress draft fields may exceed server limits, but are never truncated.
  if (
    ![value.wechat, value.qq, value.phone].every((v) =>
      boundedText(v, 0, 10000),
    )
  )
    invalid();
  return Object.freeze(value) as unknown as FeedbackDraft;
}
export function feedbackDraftInput(draft: FeedbackDraft): FeedbackInput {
  const contacts = decodeFeedbackContacts({
    wechat: draft.wechat,
    qq: draft.qq,
    phone: draft.phone,
  });
  if (Object.values(contacts).some((v) => v.trim()) && !draft.consent)
    invalid();
  return { contacts };
}
