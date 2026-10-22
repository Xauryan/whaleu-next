import {
  previewRegionPolicySchema,
  applyRegionPolicySchema,
  configureLocalRegionPolicy,
} from './local-region-policy.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { CommunityMediaBatchPublicationProof } from '../media/batch-publication-proof.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { lockSafetyPolicy } from '../../safety/locks.js';
import {
  lockPublicationCommand,
  requirePublicationNotCancelled,
} from '../publication-cancel-fence.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalJson,
} from '../content-review/contracts.js';
import { TextReviewRuntime } from './runtime.js';
import { approvalPolicyKey } from '../content-review/approval-validation.js';
import type { TextReviewRequest } from './contracts.js';

export const reviewOperatorCommandSchema = z.discriminatedUnion('command', [
  previewRegionPolicySchema,
  applyRegionPolicySchema,
  z.strictObject({
    command: z.literal('init-policy'),
    basis: z.string().trim().min(1).max(1000),
  }),
  z.strictObject({ command: z.literal('list') }),
  z.strictObject({
    command: z.literal('init-source-policy'),
    basis: z.string().trim().min(1).max(1000),
  }),
  z.strictObject({
    command: z.literal('init-related-policy'),
    basis: z.string().trim().min(1).max(1000),
  }),
  z.strictObject({
    command: z.literal('init-feedback'),
    basis: z.string().trim().min(1).max(1000),
  }),
  z.strictObject({
    command: z.literal('expire'),
    limit: z.number().int().min(1).max(32),
  }),
  z.strictObject({
    command: z.literal('show'),
    accountId: z.uuid(),
    requestId: z.uuidv4(),
  }),
  z.strictObject({
    command: z.literal('decide'),
    accountId: z.uuid(),
    requestId: z.uuidv4(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['allow', 'reject']),
    basis: z.string().trim().min(1).max(1000),
  }),
  z.strictObject({
    command: z.literal('withdraw'),
    accountId: z.uuid(),
    requestId: z.uuidv4(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['held', 'revoked']),
    basis: z.string().trim().min(1).max(1000),
  }),
]);
export type ReviewOperatorCommand = z.infer<typeof reviewOperatorCommandSchema>;

/** Called only by the OS-owned human-review CLI. Not an automatic or HTTP provider. */
export class TextReviewOperator {
  constructor(
    private readonly runtime: TextReviewRuntime,
    private readonly operator: string,
  ) {}
  async run(command: ReviewOperatorCommand, tx: PoolClient): Promise<unknown> {
    if (
      (!this.runtime.configured() && !this.runtime.sourceConfigured()) ||
      this.runtime.config.COMMUNITY_TEXT_REVIEW_OPERATOR !== this.operator
    )
      throw new Error(
        'Operator or explicit human-review configuration unavailable',
      );
    const config = this.runtime.config;
    const sourceOnly = config.COMMUNITY_TEXT_REVIEW === 'source_manual';
    if (
      sourceOnly &&
      ![
        'init-source-policy',
        'list',
        'show',
        'decide',
        'withdraw',
        'expire',
      ].includes(command.command)
    )
      throw new Error(
        'Source manual review cannot administer unrelated review or scope',
      );

    if (
      command.command === 'preview-region' ||
      command.command === 'apply-region'
    )
      return configureLocalRegionPolicy(command, config, this.operator, tx);
    const databaseActor = (
      await tx.query<{ actor: string }>('SELECT current_user AS actor')
    ).rows[0]!.actor;
    const reference =
      'basis' in command
        ? JSON.stringify({
            basis: command.basis,
            localOperator: this.operator,
            databaseActor,
          })
        : '';
    if (command.command === 'init-feedback') {
      if (!config.COMMUNITY_FEEDBACK_SPACE_ID)
        throw new Error('Explicit feedback space configuration unavailable');
      await lockSafetyPolicy(tx, true);
      await tx.query(
        `INSERT INTO whaleu_community.feedback_topic(topic,space_id,provenance,source_reference) VALUES('feedback',$1,'accepted',$2)`,
        [config.COMMUNITY_FEEDBACK_SPACE_ID, reference],
      );
      return {
        spaceId: config.COMMUNITY_FEEDBACK_SPACE_ID,
        topic: 'feedback',
        initialized: true,
      };
    }
    if (
      command.command === 'init-policy' ||
      command.command === 'init-related-policy' ||
      command.command === 'init-source-policy'
    ) {
      const related = command.command === 'init-related-policy';
      const source = command.command === 'init-source-policy';
      const policyId = source
        ? config.COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID
        : related
          ? config.COMMUNITY_RELATED_REVIEW_POLICY_ID
          : config.COMMUNITY_TEXT_REVIEW_POLICY_ID;
      if (!policyId)
        throw new Error(
          'Explicit related Review policy configuration unavailable',
        );
      await lockSafetyPolicy(tx, true);
      await tx.query(
        `INSERT INTO whaleu_community.content_approval_policies
        (id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from)
        VALUES($1,$4,1,'complete','accepted',$2,$3,clock_timestamp())`,
        [
          policyId,
          this.operator,
          reference,
          source
            ? 'local-text-source-v1'
            : related
              ? 'local-related-v1'
              : 'local-explicit-v1',
        ],
      );
      return {
        policyId,
        initialized: true,
      };
    }
    if (command.command === 'expire') {
      await lockSafetyPolicy(tx, true);
      const rows = (
        await tx.query<TextReviewRequest>(
          `SELECT q.* FROM whaleu_community.text_review_requests q
        JOIN whaleu_community.publication_requests p USING(account_id,client_request_id)
        WHERE ($5::boolean=false OR q.envelope->>'version'='6' OR (q.envelope->>'version' IN ('7','8') AND jsonb_typeof(q.envelope->'textSource')='object')) AND q.expires_at<=clock_timestamp() AND p.receipt IS NULL AND ((q.envelope->>'spaceId'=$1 AND q.envelope->'scope'->>'originalRegionId'=$2) OR (q.envelope->>'spaceId'=$4 AND q.envelope->>'category'='feedback' AND q.envelope->'scope'->'originalRegionId'='null'::jsonb))
        AND NOT EXISTS(SELECT 1 FROM whaleu_community.publication_cancel_fences f WHERE f.account_id=q.account_id AND f.client_request_id=q.client_request_id)
        ORDER BY q.account_id,q.client_request_id LIMIT $3`,
          [
            config.COMMUNITY_TEXT_REVIEW_SPACE_ID,
            config.COMMUNITY_TEXT_REVIEW_REGION_ID,
            command.limit,
            config.COMMUNITY_FEEDBACK_SPACE_ID ?? null,
            sourceOnly,
          ],
        )
      ).rows;
      let cancelled = 0;
      for (const row of rows) {
        await tx.query(
          'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE',
          [row.account_id],
        );
        const result =
          await new CommunityMediaBatchPublicationProof().fenceNonCreated(
            row.account_id,
            {
              clientRequestId: row.client_request_id,
              operation: row.operation,
              intentHash: row.intent_hash,
            },
            tx,
          );
        if (result.outcome === 'cancelled') cancelled++;
      }
      return { expiredRequestsFenced: cancelled };
    }
    if (command.command === 'list') {
      return (
        await tx.query(
          `SELECT q.account_id,q.client_request_id,q.operation,q.digest,q.created_at
        FROM whaleu_community.text_review_requests q JOIN whaleu_community.publication_requests p USING(account_id,client_request_id)
        WHERE ($4::boolean=false OR (q.envelope->>'version'='6' OR (q.envelope->>'version' IN ('7','8') AND jsonb_typeof(q.envelope->'textSource')='object')) AND q.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM whaleu_community.publication_cancel_fences f WHERE f.account_id=q.account_id AND f.client_request_id=q.client_request_id)) AND q.decision_id IS NULL AND p.receipt IS NULL AND ((q.envelope->>'spaceId'=$1 AND q.envelope->'scope'->>'originalRegionId'=$2) OR (q.envelope->>'spaceId'=$3 AND q.envelope->>'category'='feedback' AND q.envelope->'scope'->'originalRegionId'='null'::jsonb)) ORDER BY q.created_at LIMIT 100`,
          [
            config.COMMUNITY_TEXT_REVIEW_SPACE_ID,
            config.COMMUNITY_TEXT_REVIEW_REGION_ID,
            config.COMMUNITY_FEEDBACK_SPACE_ID ?? null,
            sourceOnly,
          ],
        )
      ).rows;
    }
    // Same global safety writer then actor then owner-key ordering as issuance,
    // consumption, cancellation and existing head triggers. Never upgrade a reader.
    if (command.command !== 'show') await lockSafetyPolicy(tx, true);
    const actor = (
      await tx.query(
        `SELECT id FROM whaleu_identity.accounts WHERE id=$1 AND status='active' FOR ${command.command === 'show' ? 'SHARE' : 'UPDATE'}`,
        [command.accountId],
      )
    ).rows[0];
    if (!actor) throw new Error('Account unavailable');
    await lockPublicationCommand(command.accountId, command.requestId, tx);
    const row = (
      await tx.query<TextReviewRequest>(
        `SELECT * FROM whaleu_community.text_review_requests
      WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE`,
        [command.accountId, command.requestId],
      )
    ).rows[0];
    if (!row) throw new Error('Review unavailable');
    const envelope = canonicalEnvelope(row.envelope);
    if (sourceOnly && approvalPolicyKey(envelope) !== 'local-text-source-v1')
      throw new Error('Source manual review requires an exact source envelope');
    if (
      ((envelope.version === 7 || envelope.version === 8) &&
        (row.account_id !== command.accountId ||
          row.account_id !== envelope.accountId ||
          row.client_request_id !== command.requestId ||
          row.operation !== envelope.purpose ||
          (envelope.version === 7 &&
            row.intent_hash !== envelope.home.requestedIntentHash))) ||
      row.digest !== approvalDigest(envelope) ||
      canonicalJson(envelope) !== canonicalJson(row.envelope)
    )
      throw new Error('Review snapshot invalid');
    await this.runtime.requireEnvelope(envelope, tx);
    if (command.command === 'show')
      return {
        accountId: row.account_id,
        requestId: row.client_request_id,
        digest: row.digest,
        envelope,
      };
    if (command.digest !== row.digest)
      throw new Error('Displayed digest changed');
    if (command.command === 'withdraw') {
      if (!row.decision_id) throw new Error('No decision to withdraw');
      const eventId = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_community.content_approval_events
        (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
        VALUES($1,$2,$3,'complete','accepted',$4,$5,clock_timestamp())`,
        [eventId, row.decision_id, command.state, this.operator, reference],
      );
      await tx.query(
        'UPDATE whaleu_community.content_approval_heads SET event_id=$2 WHERE decision_id=$1',
        [row.decision_id, eventId],
      );
      return { requestId: row.client_request_id, state: command.state };
    }
    if (row.decision_id)
      throw new Error('Already decided; decisions cannot be overwritten');
    if (
      !(
        await tx.query(
          'SELECT 1 FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2 AND expires_at>clock_timestamp()',
          [row.account_id, row.client_request_id],
        )
      ).rows[0]
    )
      throw new Error('Review submission expired');
    registerTransactionDeadline(
      tx,
      row.expires_at.getTime(),
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    await requirePublicationNotCancelled(
      row.account_id,
      row.client_request_id,
      row.operation,
      row.intent_hash,
      tx,
    );
    const request = (
      await tx.query<{
        payload_hash: string;
        operation: string;
        receipt: unknown;
      }>(
        `SELECT payload_hash,operation,receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE`,
        [row.account_id, row.client_request_id],
      )
    ).rows[0];
    if (
      !request ||
      request.receipt ||
      request.payload_hash !== row.intent_hash ||
      request.operation !== row.operation
    )
      throw new Error('Original publication no longer pending');
    const id = randomUUID(),
      eventId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.content_approval_decisions
      (id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'complete','accepted',$9,$10,clock_timestamp(),clock_timestamp()+interval '24 hours','durable')`,
      [
        id,
        row.account_id,
        row.operation,
        envelope.version,
        row.digest,
        canonicalJson(envelope),
        this.runtime.policyId(envelope),
        command.decision,
        this.operator,
        reference,
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_community.content_approval_events
      (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
      VALUES($1,$2,'allow','complete','accepted',$3,$4,clock_timestamp())`,
      [eventId, id, this.operator, reference],
    );
    await tx.query(
      'INSERT INTO whaleu_community.content_approval_heads(decision_id,event_id) VALUES($1,$2)',
      [id, eventId],
    );
    await tx.query(
      'UPDATE whaleu_community.text_review_requests SET decision_id=$3 WHERE account_id=$1 AND client_request_id=$2',
      [row.account_id, row.client_request_id, id],
    );
    return {
      requestId: row.client_request_id,
      decision: command.decision,
      decisionId: id,
    };
  }
}
