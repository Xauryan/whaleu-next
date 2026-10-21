import { inspectReadingSchema } from './readiness.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ownerFingerprint } from '../../database/required-owner-proof.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerOptionalTransactionProof,
} from '../../database/transaction-deadlines.js';
import {
  textSourceReadSchema,
  sourceDescriptor,
} from '../text-source/protocol.js';
import type { TextSourceRead } from '../text-source/protocol.js';
import { planSchema } from './contracts.js';
import type { ReadingPlan, SourceSnapshot } from './contracts.js';
import { decodeExactPlan } from './formatter.js';
export interface ReadingPresentation {
  status: 'source' | 'formatted';
  plan?: ReadingPlan;
}
export type TextSourceReadV2 = {
  version: 2;
  source: TextSourceRead;
  presentation: ReadingPresentation;
};
export const textSourceReadV2Schema = z
  .strictObject({
    version: z.literal(2),
    source: textSourceReadSchema,
    presentation: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('source') }),
      z.strictObject({ status: z.literal('formatted'), plan: planSchema }),
    ]),
  })
  .superRefine((value, context) => {
    if (value.presentation.status !== 'formatted') return;
    const source = value.source;
    if (
      source.classification !== 'reviewedSource' ||
      !source.readingFormattingEligible ||
      !decodeExactPlan(
        {
          kind: source.kind,
          id: source.id,
          sourceRevision: 1,
          sourceHash: source.textSource.sourceHash,
          publicationRequestId: '00000000-0000-4000-8000-000000000001',
          text: source.text,
          descriptor: sourceDescriptor(source.textSource),
        },
        JSON.stringify(value.presentation.plan),
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid source presentation',
      });
  });

const select = `SELECT r.plan,s.client_request_id,h.source_hash,h.source_revision,h.generation,h.formatter_version,j.job_key,
 jsonb_build_array(to_jsonb(h),h.xmin::text,to_jsonb(j),j.xmin::text,to_jsonb(r),r.xmin::text) evidence,
 (SELECT min(until) FROM (SELECT d.visibility_until until FROM whaleu_community.profile_moderation_nodes($1,$2) n JOIN whaleu_community.content_approval_bindings b ON b.content_kind=n.kind AND b.content_id=n.id JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id UNION ALL SELECT p.valid_until FROM whaleu_community.profile_moderation_nodes($1,$2) n JOIN whaleu_community.content_approval_bindings b ON b.content_kind=n.kind AND b.content_id=n.id JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id UNION ALL SELECT e.valid_until FROM whaleu_community.profile_moderation_nodes($1,$2) n JOIN whaleu_media.bindings mb ON mb.owner_kind='community' AND mb.resource_kind=n.kind AND mb.resource_id=n.id AND mb.detached_at IS NULL JOIN whaleu_media.asset_safety_heads sh ON sh.asset_id=mb.asset_id JOIN whaleu_media.asset_safety_events e ON e.id=sh.event_id) deadlines) until
 FROM whaleu_community.community_text_sources s JOIN whaleu_community.reading_format_heads h USING(content_kind,content_id)
 JOIN whaleu_community.reading_format_jobs j ON (j.content_kind,j.content_id,j.source_revision,j.source_hash,j.publication_request_id,j.formatter_version,j.generation)=(h.content_kind,h.content_id,h.source_revision,h.source_hash,h.publication_request_id,h.formatter_version,h.generation)
 JOIN whaleu_community.reading_format_results r ON r.job_key=j.job_key
 WHERE s.content_kind=$1 AND s.content_id=$2 AND h.state='active' AND j.state='complete' AND h.source_hash=s.source_hash AND h.source_revision=s.source_revision AND h.publication_request_id=s.client_request_id AND whaleu_community.reading_format_source_current($1,$2)`;
/** Called only after mandatory canonical source/access resolution IN THE SAME TX.
 * No writes, worker proof API, reader-derived scheduling or global denial state. */
export async function optionalReadingPresentation(
  source: TextSourceRead,
  tx: PoolClient,
): Promise<TextSourceReadV2> {
  const result: TextSourceReadV2 = {
    version: 2,
    source,
    presentation: { status: 'source' },
  };
  if (
    source.classification !== 'reviewedSource' ||
    !source.readingFormattingEligible
  )
    return result;
  const checkpoint = checkpointTransactionDeadlines(tx);
  await tx.query('SAVEPOINT optional_reading');
  try {
    await tx.query("SET LOCAL lock_timeout='5ms'");
    const schema = await inspectReadingSchema(tx);
    if (schema.status === 'missing') {
      await tx.query('RELEASE SAVEPOINT optional_reading');
      return result;
    }
    const row = (await tx.query(select, [source.kind, source.id])).rows[0];
    if (row) {
      const snapshot: SourceSnapshot = {
        kind: source.kind,
        id: source.id,
        sourceRevision: 1,
        sourceHash: source.textSource.sourceHash,
        publicationRequestId: String(row['client_request_id']),
        text: source.text,
        descriptor: sourceDescriptor(source.textSource),
      };
      const plan = decodeExactPlan(snapshot, JSON.stringify(row['plan']));
      if (plan && row['source_hash'] === snapshot.sourceHash) {
        result.presentation = { status: 'formatted', plan };
        const fingerprint = ownerFingerprint(row['evidence']);
        registerOptionalTransactionProof(tx, {
          until: row['until'] instanceof Date ? row['until'].getTime() : null,
          invalidate: () => {
            result.presentation = { status: 'source' };
          },
          validate: async () => {
            // These are derived-presentation facts only. The original optional
            // finalizer rolls back their fences; rollback failure stays fatal.
            // Mandatory canonical owner proofs are outside this boundary.
            try {
              await tx.query(
                'SELECT whaleu_community.reading_format_source_fence()',
              );
              await tx.query(
                'LOCK TABLE whaleu_community.reading_format_heads,whaleu_community.reading_format_jobs,whaleu_community.reading_format_results,whaleu_community.reading_format_slots IN SHARE MODE NOWAIT',
              );
              const currentSchema = await inspectReadingSchema(tx);
              if (
                currentSchema.status !== 'ready' ||
                currentSchema.catalog !== schema.catalog
              )
                return false;
              const current = (await tx.query(select, [source.kind, source.id]))
                .rows[0];
              return (
                !!current &&
                ownerFingerprint(current['evidence']) === fingerprint
              );
            } catch {
              return false;
            }
          },
        });
      }
    }
    await tx.query('RELEASE SAVEPOINT optional_reading');
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT optional_reading');
    restoreTransactionDeadlines(tx, checkpoint);
    await tx.query('RELEASE SAVEPOINT optional_reading');
    result.presentation = { status: 'source' };
  }
  return result;
}
