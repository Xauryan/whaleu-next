import { boundedText, exact, invalid } from './contract';
import {
  decodeFormationComponent,
  type FormationComponent,
} from './formation-contract';

/** Entered contacts belong only to this account's draft, never profile/trading preferences. */
export interface FormationDraft {
  readonly enabled: boolean;
  readonly theme: string;
  readonly capacity: string;
  readonly wechat: string;
  readonly qq: string;
  readonly phone: string;
  readonly contactConsent: boolean;
}
export const emptyFormationDraft = (): FormationDraft =>
  Object.freeze({
    enabled: false,
    theme: '',
    capacity: '',
    wechat: '',
    qq: '',
    phone: '',
    contactConsent: false,
  });

/** Incomplete inputs survive reopening without truncation or coerced capacity. */
export function decodeFormationDraft(value: unknown): FormationDraft {
  exact(value, [
    'enabled',
    'theme',
    'capacity',
    'wechat',
    'qq',
    'phone',
    'contactConsent',
  ]);
  if (
    typeof value.enabled !== 'boolean' ||
    typeof value.contactConsent !== 'boolean' ||
    ![value.theme, value.capacity, value.wechat, value.qq, value.phone].every(
      (item) =>
        typeof item === 'string' &&
        boundedText(item.replace(/\r\n/g, '\n'), 0, 10000),
    )
  )
    invalid();
  return Object.freeze({
    enabled: value.enabled,
    theme: value.theme as string,
    capacity: value.capacity as string,
    wechat: value.wechat as string,
    qq: value.qq as string,
    phone: value.phone as string,
    contactConsent: value.contactConsent,
  });
}

export function formationDraftComponent(
  draft: FormationDraft,
): FormationComponent {
  if (
    !draft.enabled ||
    !draft.contactConsent ||
    !/^(?:[1-9]|1[0-9]|20)(?![\s\S])/.test(draft.capacity)
  )
    invalid();
  return decodeFormationComponent({
    kind: 'formation',
    theme: draft.theme.replace(/\r\n/g, '\n').trim(),
    capacity: Number(draft.capacity),
    contacts: {
      wechat: draft.wechat.replace(/\r\n/g, '\n').trim(),
      qq: draft.qq.replace(/\r\n/g, '\n').trim(),
      phone: draft.phone.replace(/\r\n/g, '\n').trim(),
    },
    contactSharing: 'members_v1',
  });
}

export function componentFormationDraft(
  component: FormationComponent,
): FormationDraft {
  const checked = decodeFormationComponent(component);
  return Object.freeze({
    enabled: true,
    theme: checked.theme,
    capacity: String(checked.capacity),
    ...checked.contacts,
    contactConsent: true,
  });
}
