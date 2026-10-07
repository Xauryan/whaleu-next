import { boundedText, exact, invalid } from './contract';
import {
  decodePollComponent,
  finalPollOption,
  type PollComponent,
  type SelectionMode,
} from './poll-contract';
export interface PollDraft {
  readonly enabled: boolean;
  readonly question: string;
  readonly selectionMode: SelectionMode;
  readonly options: readonly string[];
  readonly finalOption: boolean;
}
export const emptyPollDraft = (): PollDraft =>
  Object.freeze({
    enabled: false,
    question: '',
    selectionMode: 'single',
    options: Object.freeze(['', '']),
    finalOption: true,
  });
export function decodePollDraft(value: unknown): PollDraft {
  exact(value, [
    'enabled',
    'question',
    'selectionMode',
    'options',
    'finalOption',
  ]);
  if (
    typeof value.enabled !== 'boolean' ||
    typeof value.finalOption !== 'boolean' ||
    !(
      typeof value.question === 'string' &&
      boundedText(value.question.replace(/\r\n/g, '\n'), 0, 10000)
    ) ||
    !['single', 'multiple'].includes(String(value.selectionMode)) ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > (value.finalOption ? 4 : 5) ||
    !value.options.every(
      (option) =>
        typeof option === 'string' &&
        boundedText(option.replace(/\r\n/g, '\n'), 0, 10000),
    )
  )
    invalid();
  return Object.freeze({
    enabled: value.enabled,
    question: value.question,
    selectionMode: value.selectionMode as SelectionMode,
    options: Object.freeze([...value.options]),
    finalOption: value.finalOption,
  });
}
export function pollDraftComponent(draft: PollDraft): PollComponent {
  if (!draft.enabled) return Object.freeze({ kind: 'none' });
  return decodePollComponent({
    kind: 'poll',
    question: draft.question.replace(/\r\n/g, '\n'),
    selectionMode: draft.selectionMode,
    options: [
      ...draft.options.map((option) => option.replace(/\r\n/g, '\n')),
      ...(draft.finalOption ? [finalPollOption] : []),
    ],
  });
}
export function componentDraft(
  component:
    | PollComponent
    | import('./formation-contract').FormationComponent
    | undefined,
): PollDraft {
  if (!component || component.kind !== 'poll') return emptyPollDraft();
  const finalOptionEnabled =
    component.options[component.options.length - 1]?.trim() === finalPollOption;
  return Object.freeze({
    enabled: true,
    question: component.question,
    selectionMode: component.selectionMode,
    options: Object.freeze(
      component.options.slice(0, finalOptionEnabled ? -1 : undefined),
    ),
    finalOption: finalOptionEnabled,
  });
}
