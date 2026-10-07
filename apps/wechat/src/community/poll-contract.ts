import { decodeFormation, type Formation } from './formation-contract';
import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import { boundedText, exact, invalid, timestamp, uuid4 } from './contract';

export type SelectionMode = 'single' | 'multiple';
export type PollComponent =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'poll';
      readonly question: string;
      readonly selectionMode: SelectionMode;
      readonly options: readonly string[];
    };
export interface Poll {
  readonly id: string;
  readonly postId: string;
  readonly question: string;
  readonly selectionMode: SelectionMode;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly position: number;
    readonly count: number;
  }[];
  readonly deadline: string | null;
  readonly expired: boolean;
  readonly voterCount: number;
  readonly selectionCount: number;
  readonly viewer: {
    readonly hasVoted: boolean;
    readonly selectedOptionIds: readonly string[];
    readonly canVote: boolean;
    readonly reason: string | null;
  };
}
export type PostComponent =
  | { readonly kind: 'none' }
  | { readonly kind: 'poll'; readonly poll: Poll }
  | { readonly kind: 'formation'; readonly formation: Formation };
export interface BallotIntent {
  readonly clientRequestId: string;
  readonly optionIds: readonly string[];
}
export type BallotReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'cast_poll_ballot';
      readonly outcome: 'created';
      readonly resourceId: string;
      readonly createdAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: 'cast_poll_ballot';
      readonly outcome: 'rejected';
      readonly code: string;
    };
export interface OwnBallot {
  readonly postId: string;
  readonly ballotId: string;
  readonly createdAt: string;
  readonly selectedOptionIds: readonly string[];
}
export const finalPollOption = '吃瓜🍉';
const historicalText = (value: unknown): value is string =>
  typeof value === 'string' &&
  [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return code < 0xd800 || code > 0xdfff;
  });
const selectionMode = (value: unknown): value is SelectionMode =>
  value === 'single' || value === 'multiple';
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const terminalCodes = [
  'POST_NOT_FOUND',
  'POLL_NOT_FOUND',
  'POLL_EXPIRED',
  'POLL_ALREADY_VOTED',
  'POLL_OPTIONS_INVALID',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
  'COMMUNITY_SCOPE_UNAVAILABLE',
];
const reasons = [
  'POLL_ALREADY_VOTED',
  'POLL_EXPIRED',
  'AUTHENTICATION_REQUIRED',
  'COMMUNITY_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
];
function optionIds(value: unknown, minimum: number): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > 5 ||
    !value.every(isUuid) ||
    new Set(value).size !== value.length
  )
    invalid();
  return Object.freeze([...value]);
}
/** New writes have deliberate 255-codepoint bounds; no deadline or future component fields. */
export function decodePollComponent(value: unknown): PollComponent {
  if (!isRecord(value)) invalid();
  if (value.kind === 'none') {
    exact(value, ['kind']);
    return Object.freeze({ kind: 'none' });
  }
  exact(value, ['kind', 'question', 'selectionMode', 'options']);
  if (
    value.kind !== 'poll' ||
    !boundedText(value.question, 1, 255) ||
    !value.question.trim() ||
    value.question.includes('\r') ||
    !selectionMode(value.selectionMode) ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 5
  )
    invalid();
  const labels: string[] = [];
  for (const label of value.options) {
    if (!boundedText(label, 1, 255) || !label.trim() || label.includes('\r'))
      invalid();
    labels.push(label);
  }
  const trimmed = labels.map((label) => label.trim());
  const final = trimmed.indexOf(finalPollOption);
  if (
    new Set(trimmed).size !== labels.length ||
    (final !== -1 && (final !== labels.length - 1 || labels.length < 3))
  )
    invalid();
  return Object.freeze({
    kind: 'poll',
    question: value.question,
    selectionMode: value.selectionMode,
    options: Object.freeze(labels),
  });
}
/** Historical text is preserved verbatim, including text longer than new-write limits. */
export function decodePoll(value: unknown): Poll {
  exact(value, [
    'id',
    'postId',
    'question',
    'selectionMode',
    'options',
    'deadline',
    'expired',
    'voterCount',
    'selectionCount',
    'viewer',
  ]);
  exact(value.viewer, ['hasVoted', 'selectedOptionIds', 'canVote', 'reason']);
  if (
    !isUuid(value.id) ||
    !isUuid(value.postId) ||
    !historicalText(value.question) ||
    !selectionMode(value.selectionMode) ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 5 ||
    !(value.deadline === null || timestamp(value.deadline)) ||
    typeof value.expired !== 'boolean' ||
    (value.deadline === null && value.expired) ||
    !count(value.voterCount) ||
    !count(value.selectionCount) ||
    typeof value.viewer.hasVoted !== 'boolean' ||
    typeof value.viewer.canVote !== 'boolean' ||
    !(
      value.viewer.reason === null ||
      (typeof value.viewer.reason === 'string' &&
        reasons.includes(value.viewer.reason))
    )
  )
    invalid();
  const options = value.options.map((option, position) => {
    exact(option, ['id', 'label', 'position', 'count']);
    if (
      !isUuid(option.id) ||
      !historicalText(option.label) ||
      option.position !== position ||
      !count(option.count) ||
      option.count > (value.voterCount as number)
    )
      invalid();
    return Object.freeze({
      id: option.id,
      label: option.label,
      position,
      count: option.count,
    });
  });
  const selected = optionIds(
    value.viewer.selectedOptionIds,
    value.viewer.hasVoted ? 1 : 0,
  );
  if (
    new Set(options.map((option) => option.id)).size !== options.length ||
    selected.some(
      (id) => !options.some((option) => option.id === id && option.count > 0),
    ) ||
    (!value.viewer.hasVoted && selected.length !== 0) ||
    (value.selectionMode === 'single' && selected.length > 1) ||
    options.reduce((total, option) => total + option.count, 0) !==
      value.selectionCount ||
    value.selectionCount < value.voterCount ||
    value.selectionCount > value.voterCount * options.length ||
    (value.selectionMode === 'single' &&
      value.selectionCount !== value.voterCount) ||
    value.viewer.canVote !== (value.viewer.reason === null) ||
    (value.viewer.hasVoted &&
      (value.viewer.canVote || value.viewer.reason !== 'POLL_ALREADY_VOTED')) ||
    (!value.viewer.hasVoted &&
      value.expired &&
      value.viewer.reason !== 'POLL_EXPIRED') ||
    (!value.viewer.hasVoted && value.viewer.reason === 'POLL_ALREADY_VOTED') ||
    (!value.expired && value.viewer.reason === 'POLL_EXPIRED') ||
    (value.expired && value.viewer.canVote)
  )
    invalid();
  return Object.freeze({
    id: value.id,
    postId: value.postId,
    question: value.question,
    selectionMode: value.selectionMode,
    options: Object.freeze(options),
    deadline: value.deadline,
    expired: value.expired,
    voterCount: value.voterCount,
    selectionCount: value.selectionCount,
    viewer: Object.freeze({
      hasVoted: value.viewer.hasVoted,
      selectedOptionIds: selected,
      canVote: value.viewer.canVote,
      reason: value.viewer.reason,
    }),
  });
}
export function decodePostComponent(
  value: unknown,
  postId: string,
): PostComponent {
  if (!isRecord(value)) invalid();
  if (value.kind === 'none') {
    exact(value, ['kind']);
    return Object.freeze({ kind: 'none' });
  }
  if (value.kind === 'formation') {
    exact(value, ['kind', 'formation']);
    const formation = decodeFormation(value.formation);
    if (formation.postId !== postId) invalid();
    return Object.freeze({ kind: 'formation', formation });
  }
  exact(value, ['kind', 'poll']);
  if (value.kind !== 'poll') invalid();
  const poll = decodePoll(value.poll);
  if (poll.postId !== postId) invalid();
  return Object.freeze({ kind: 'poll', poll });
}
export function decodeBallotIntent(value: unknown): BallotIntent {
  exact(value, ['clientRequestId', 'optionIds']);
  if (!uuid4(value.clientRequestId)) invalid();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    optionIds: Object.freeze([...optionIds(value.optionIds, 1)].sort()),
  });
}
export function decodeBallotReceipt(value: unknown): BallotReceipt {
  if (!isRecord(value)) invalid();
  if (value.outcome === 'created') {
    exact(value, [
      'requestId',
      'operation',
      'outcome',
      'resourceId',
      'createdAt',
    ]);
    if (
      !uuid4(value.requestId) ||
      value.operation !== 'cast_poll_ballot' ||
      !isUuid(value.resourceId) ||
      !timestamp(value.createdAt)
    )
      invalid();
    return Object.freeze({
      requestId: value.requestId,
      operation: 'cast_poll_ballot',
      outcome: 'created',
      resourceId: value.resourceId,
      createdAt: value.createdAt,
    });
  }
  exact(value, ['requestId', 'operation', 'outcome', 'code']);
  if (
    !uuid4(value.requestId) ||
    value.operation !== 'cast_poll_ballot' ||
    value.outcome !== 'rejected' ||
    typeof value.code !== 'string' ||
    !terminalCodes.includes(value.code)
  )
    invalid();
  return Object.freeze({
    requestId: value.requestId,
    operation: 'cast_poll_ballot',
    outcome: 'rejected',
    code: value.code,
  });
}
export function decodeOwnBallot(value: unknown): OwnBallot {
  exact(value, ['postId', 'ballotId', 'createdAt', 'selectedOptionIds']);
  if (
    !isUuid(value.postId) ||
    !isUuid(value.ballotId) ||
    !timestamp(value.createdAt)
  )
    invalid();
  return Object.freeze({
    postId: value.postId,
    ballotId: value.ballotId,
    createdAt: value.createdAt,
    selectedOptionIds: optionIds(value.selectedOptionIds, 1),
  });
}
