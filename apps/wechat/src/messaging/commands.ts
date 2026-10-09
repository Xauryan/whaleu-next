import { ClientError, clientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import {
  decodeIntent,
  type Intent,
  type Receipt,
  type CancellationResult,
} from './contract';
import type { Pending } from './pending';
import type { MessagingRuntime } from './runtime';
/** The caller's generation guard is checked before persistence and every dispatch continuation. */
export async function dispatch(
  runtime: MessagingRuntime,
  raw: Intent,
  cancel: Cancellation,
  assertCurrent: () => void,
): Promise<Receipt> {
  assertCurrent();
  runtime.assertStorage();
  const accountId = runtime.sessions.snapshot().credentials?.accountId;
  if (!accountId || !runtime.gateway)
    throw new ClientError('auth-required', 'Login is required');
  const attempt = runtime.pending.freeze({
    version: 1,
    accountId,
    intent: decodeIntent(raw),
  });
  assertCurrent();
  if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
  const receipt = await runtime.gateway.apply(attempt.intent, cancel);
  assertCurrent();
  const settled = runtime.pending.settle(attempt, receipt);
  if (settled.outcome !== 'rejected' && settled.operation === 'block')
    runtime.safetyChanges?.invalidate(attempt.accountId);
  return settled;
}
export async function recover(
  runtime: MessagingRuntime,
  attempt: Pending,
  retry: boolean,
  cancel: Cancellation,
  assertCurrent: () => void,
): Promise<Receipt> {
  assertCurrent();
  runtime.assertStorage();
  if (!runtime.gateway)
    throw new ClientError(
      'configuration',
      'Private-message service unavailable',
    );
  if (runtime.sessions.snapshot().credentials?.accountId !== attempt.accountId)
    throw new ClientError('auth-required', 'Original account is required');
  runtime.pending.assertStored(attempt);
  try {
    const receipt = await runtime.gateway.receipt(attempt.requestId, cancel);
    assertCurrent();
    const settled = runtime.pending.settle(attempt, receipt);
    if (settled.outcome !== 'rejected' && settled.operation === 'block')
      runtime.safetyChanges?.invalidate(attempt.accountId);
    return settled;
  } catch (error) {
    assertCurrent();
    if (!retry || clientError(error).details.serverCode !== 'REQUEST_NOT_FOUND')
      throw error;
  }
  assertCurrent();
  if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
  if (!attempt.intent)
    throw new ClientError(
      'business',
      '原文已清除，不能重试；请查询原回执或安全取消原请求',
    );
  return dispatch(runtime, attempt.intent, cancel, assertCurrent);
}

/** Server-side cancellation fences a late original command. Clearing a local row is not cancellation. */
export async function cancelPending(
  runtime: MessagingRuntime,
  attempt: Pending,
  cancel: Cancellation,
  assertCurrent: () => void,
): Promise<CancellationResult> {
  assertCurrent();
  runtime.assertStorage();
  if (
    !runtime.gateway ||
    runtime.sessions.snapshot().credentials?.accountId !== attempt.accountId
  )
    throw new ClientError('auth-required', 'Original account is required');
  runtime.pending.assertStored(attempt);
  const result = await runtime.gateway.cancel(
    attempt.requestId,
    attempt.operation,
    attempt.intentHash,
    cancel,
  );
  assertCurrent();
  const settled = runtime.pending.settle(attempt, result.receipt);
  if (settled.outcome !== 'rejected' && settled.operation === 'block')
    runtime.safetyChanges?.invalidate(attempt.accountId);
  return Object.freeze({ ...result, receipt: settled });
}
