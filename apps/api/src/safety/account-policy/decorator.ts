import { sessionPolicyContext } from '../../http/session-policy-context.js';
import type { SafetyAction } from '../account-moderation/contracts.js';
import { enforceAccountPunishment } from '../account-moderation/policy.js';
import { accountPolicyAction } from './context.js';
export type AccountPolicyPhase =
  'entry' | 'owner_after_recovery' | 'restricted';
/** Direct service calls receive the same explicit server-owned semantic class.
 * An established outer operation is retained across helper calls. A command
 * annotation never moves eligibility before its historical receipt lookup. */
export function runAccountPolicy<T>(
  action: SafetyAction,
  phase: AccountPolicyPhase,
  operation: () => T,
  semanticDispatch = false,
): T {
  if (!semanticDispatch && accountPolicyAction.getStore() !== undefined)
    return operation();
  return accountPolicyAction.run(action, () =>
    sessionPolicyContext.run(
      {
        observe: async (session, tx) => {
          if (phase === 'entry')
            await enforceAccountPunishment(session.accountId, action, tx);
        },
      },
      operation,
    ),
  );
}
export function AccountPolicy(action: SafetyAction, phase: AccountPolicyPhase) {
  return <T>(
    _target: object,
    _property: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    const original = descriptor.value;
    if (typeof original !== 'function')
      throw new Error('Account policy needs a method');
    const wrapped = function (this: unknown, ...args: unknown[]) {
      return runAccountPolicy(action, phase, () =>
        Reflect.apply(original, this, args),
      );
    };
    copyMethodMetadata(original, wrapped);
    descriptor.value = wrapped as T;
  };
}
/** A few existing methods handle both withdrawal and creation. Classify from
 * their typed semantic operation, never from HTTP verbs or caller role flags. */
export function AccountPolicyFor(
  action: (args: readonly unknown[]) => SafetyAction,
  phase: AccountPolicyPhase,
) {
  return <T>(
    _target: object,
    _property: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    const original = descriptor.value;
    if (typeof original !== 'function')
      throw new Error('Account policy needs a method');
    const wrapped = function (this: unknown, ...args: unknown[]) {
      return runAccountPolicy(
        action(args),
        phase,
        () => Reflect.apply(original, this, args),
        true,
      );
    };
    copyMethodMetadata(original, wrapped);
    descriptor.value = wrapped as T;
  };
}

/** Fail closed even for internal callers that bypass request DTO parsing. */
export function booleanAccountPolicy(
  value: unknown,
  whenTrue: SafetyAction,
  whenFalse: SafetyAction,
): SafetyAction {
  if (typeof value !== 'boolean')
    throw new Error('Unknown account policy operation');
  return value ? whenTrue : whenFalse;
}

export function operationAccountPolicy(
  value: unknown,
  actions: Readonly<Record<string, SafetyAction>>,
): SafetyAction {
  if (
    typeof value !== 'string' ||
    !Object.prototype.hasOwnProperty.call(actions, value)
  )
    throw new Error('Unknown account policy operation');
  return actions[value]!;
}

function copyMethodMetadata(original: object, wrapped: object): void {
  for (const key of Reflect.getOwnMetadataKeys(original))
    Reflect.defineMetadata(key, Reflect.getOwnMetadata(key, original), wrapped);
}
