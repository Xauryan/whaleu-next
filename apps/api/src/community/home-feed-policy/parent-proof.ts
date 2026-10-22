import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { ApprovalRepository } from '../content-review/approval.repository.js';
import type { ContentDefinitionRepository } from '../content-review/content-definition.repository.js';
import { definitionMatchesApproval } from '../content-review/definition-validation.js';
import type {
  EffectiveContentEnvelopeV7,
  EffectiveContentEnvelopeV8,
} from '../content-review/contracts.js';

/** This is a current, locked canonical parent proof, not a caller's digest claim.
 * Ordinary content access/relationship/media authorization must already hold in tx.
 * Home distribution never substitutes for that independent access authority. */
export async function requireCurrentHomeParent(
  postId: string,
  tx: PoolClient,
  approvals: Pick<ApprovalRepository, 'binding' | 'current'>,
  definitions: Pick<ContentDefinitionRepository, 'current'>,
  expected?: EffectiveContentEnvelopeV8['homeParent'],
): Promise<{
  envelope: EffectiveContentEnvelopeV7;
  reference: EffectiveContentEnvelopeV8['homeParent'];
}> {
  const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');
  const binding = await approvals.binding('post', postId, tx);
  if (
    !binding ||
    binding.content_kind !== 'post' ||
    binding.content_id !== postId ||
    binding.content_version !== 1 ||
    binding.envelope_version !== 7 ||
    (expected &&
      (expected.postId !== postId ||
        expected.decisionId !== binding.decision_id ||
        expected.digest !== binding.digest))
  )
    throw unavailable();
  const accepted = await approvals.current(binding, tx);
  if (
    accepted.kind !== 'allow' ||
    accepted.value.version !== 7 ||
    accepted.value.envelope.version !== 7 ||
    accepted.value.decisionId !== binding.decision_id ||
    accepted.value.digest !== binding.digest ||
    accepted.value.envelope.accountId !== binding.account_id
  )
    throw unavailable();
  const stored = await definitions.current(
    'post',
    postId,
    accepted.value.envelope.scope,
    tx,
  );
  if (
    stored.kind !== 'allow' ||
    stored.value.envelope.version !== 7 ||
    stored.value.authorAccountId !== binding.account_id ||
    !definitionMatchesApproval(stored.value, accepted.value, true)
  )
    throw unavailable();
  return {
    envelope: accepted.value.envelope,
    reference: {
      postId,
      decisionId: binding.decision_id,
      digest: binding.digest,
    },
  };
}
