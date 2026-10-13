import { AsyncLocalStorage } from 'node:async_hooks';
import type { SafetyAction } from '../account-moderation/contracts.js';

/** Trusted semantic context supplied by the checked controller manifest. Never
 * read from headers, body, query, a session claim, or client feature flags. It
 * does not grant authority and cannot bypass an owner's pre-existing checks. */
export const accountPolicyAction = new AsyncLocalStorage<SafetyAction>();
export function currentAccountPolicyAction(
  fallback: SafetyAction,
): SafetyAction {
  return accountPolicyAction.getStore() ?? fallback;
}
