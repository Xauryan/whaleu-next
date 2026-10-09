/** Explicit historical 0055/0056 publication. This is not a missing-table
 * compatibility path in current services and never bypasses SQL/Review/effects. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import type { RatingContentEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { AuthorDisplayService } from '../../src/profile/author-display.service.js';
import { RatingEffectsCapture } from '../../src/ratings/effects/capture.js';
import { ratingIso } from '../../src/ratings/repository.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { writeRatingApproval } from './rating-runtime-fixture.js';
export async function publishPreDefinitionRatingRoot(
  runtime: { app: INestApplication; pool: Pool },
  raw: RatingContentEnvelope,
  intent: unknown,
  expectedMigration: 55 | 56,
) {
  const envelope = canonicalRatingEnvelope(raw);
  if (
    envelope.purpose !== 'publish_rating_comment' ||
    envelope.authorMode !== 'named'
  )
    throw new Error('Historical fixture requires a canonical named v1 root');
  return withCommunityScopeWriter(runtime.pool, async (tx) => {
    const prefix = (
      await tx.query<{ name: string }>(
        'SELECT max(name) name FROM whaleu_meta.schema_migrations',
      )
    ).rows[0]!.name;
    assert.match(
      prefix,
      new RegExp(`^00${expectedMigration}_`),
      'Use the explicitly selected real pre-definition migration prefix',
    );
    const id = randomUUID(),
      revision = randomUUID();
    await runtime.app.get(AuthorDisplayService).prepare(envelope.accountId, tx);
    const hash = createHash('sha256')
      .update(
        'whaleu:rating-command:v1\n' +
          canonicalJson({ operation: 'create_comment', intent }),
      )
      .digest('hex');
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_comment',$3)",
      [envelope.accountId, envelope.clientRequestId, hash],
    );
    const occurredAt = (
      await tx.query<{ occurred_at: string }>(
        `INSERT INTO whaleu_ratings.comments(id,target_id,account_id,author_mode,body,revision,request_id,envelope)
      VALUES($1,$2,$3,'named',$4,$5,$6,$7::jsonb) RETURNING ${ratingIso('created_at')} occurred_at`,
        [
          id,
          envelope.targetId,
          envelope.accountId,
          envelope.body,
          revision,
          envelope.clientRequestId,
          canonicalJson(envelope),
        ],
      )
    ).rows[0]!.occurred_at;
    const approval = await writeRatingApproval(tx, envelope);
    await tx.query(
      `INSERT INTO whaleu_community.rating_approval_bindings(kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
      VALUES('comment',$1,1,$2,$3,'publish_rating_comment',1,$4,$5::jsonb,$6::jsonb)`,
      [
        id,
        approval.decisionId,
        envelope.accountId,
        approval.digest,
        canonicalJson(envelope),
        canonicalJson(envelope.scope),
      ],
    );
    await runtime.app
      .get(RatingEffectsCapture)
      .captureCreated(envelope.accountId, envelope.clientRequestId, tx);
    const receipt = {
      requestId: envelope.clientRequestId,
      operation: 'create_comment',
      outcome: 'applied',
      targetId: envelope.targetId,
      subjectId: id,
      revision,
      occurredAt,
    };
    await tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
      [envelope.accountId, envelope.clientRequestId, canonicalJson(receipt)],
    );
    return { id, revision, receipt, approval };
  });
}
