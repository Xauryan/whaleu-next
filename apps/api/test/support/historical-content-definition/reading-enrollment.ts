/** TEST ONLY. c27 had no reading enrollment. Preserve that absence only for an
 * exact historical, source-free publication which was created in this TX.
 * Every other formatter method remains the current real implementation. */
import assert from 'node:assert/strict';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../../../src/database/database.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalJson,
} from '../../../src/community/content-review/contracts.js';
import { ReadingFormattingRuntime } from '../../../src/community/reading-formatting/runtime.js';
import { ReadingSourceOwner } from '../../../src/community/reading-formatting/source-owner.js';

export const historicalReadingAbsenceSql = `SELECT
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='whaleu_community' AND starts_with(c.relname,'reading_format_'))
  AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='whaleu_community' AND starts_with(p.proname,'reading_format_'))
  AND NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='whaleu_community' AND starts_with(t.tgname,'reading_'))
  AND NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='whaleu_community' AND NOT a.attisdropped AND starts_with(a.attname,'reading_format_'))
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname='whaleu_community' AND starts_with(c.conname,'reading_format_'))
  AND NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='whaleu_community' AND (starts_with(t.typname,'reading_format_') OR starts_with(t.typname,'_reading_format_'))) AS absent`;

export class HistoricalReadingFormattingRuntime extends ReadingFormattingRuntime {
  constructor(
    database: DatabaseService,
    sources: ReadingSourceOwner,
    private readonly requirePrefix: (tx: PoolClient) => Promise<void>,
  ) {
    super(database, sources);
  }

  override async enrollCreated(
    ...[kind, id, requestId, tx]: Parameters<
      ReadingFormattingRuntime['enrollCreated']
    >
  ): Promise<void> {
    z.enum(['post', 'comment', 'reply']).parse(kind);
    z.uuid().parse(id);
    z.uuid().parse(requestId);
    const boundary = async () => {
      await this.requirePrefix(tx);
      const objects = await tx.query<{ absent: boolean }>(
        historicalReadingAbsenceSql,
      );
      assert.equal(
        objects.rows[0]?.absent,
        true,
        'Partial reading-format schema is not a predecessor',
      );
    };
    await boundary();
    const table =
      kind === 'post'
        ? 'posts'
        : kind === 'comment'
          ? 'root_comments'
          : 'replies';
    const transaction =
      kind === 'post'
        ? 'publication_transaction'
        : 'approval_publication_transaction';
    const operation =
      kind === 'post'
        ? 'publish_post'
        : kind === 'comment'
          ? 'publish_comment'
          : 'publish_reply';
    // The actual publication owner has already persisted the exact created
    // receipt before enrollment. Retries return that receipt earlier and never
    // call enrollCreated, so historical retries need no new-TX exemption.
    const row = (
      await tx.query<{
        envelope_version: number;
        envelope: unknown;
        digest: string;
        account_id: string;
        content_account_id: string;
        text: string;
        same_transaction: boolean;
        post_version: number;
        operation: string;
        receipt: {
          requestId?: string;
          operation?: string;
          outcome?: string;
          resourceId?: string;
        } | null;
      }>(
        `SELECT b.envelope_version,b.envelope,b.digest,b.account_id,n.account_id content_account_id,n.text,
       n.${transaction}=pg_current_xact_id() same_transaction,
       ${kind === 'post' ? 'n' : 'p'}.publication_envelope_version post_version,r.operation,r.receipt
       FROM whaleu_community.${table} n
       ${kind === 'post' ? '' : 'JOIN whaleu_community.posts p ON p.id=n.post_id'}
       JOIN whaleu_community.content_approval_bindings b ON b.content_kind=$1 AND b.content_id=n.id AND b.content_version=1
       JOIN whaleu_community.publication_requests r ON r.account_id=n.account_id AND r.client_request_id=$3
       WHERE n.id=$2 FOR SHARE OF n,b,r${kind === 'post' ? '' : ',p'}`,
        [kind, id, requestId],
      )
    ).rows[0];
    assert.ok(
      row,
      'Historical enrollment requires the actual created publication',
    );
    assert.equal(
      row.same_transaction,
      true,
      'Historical enrollment requires this publication transaction',
    );
    assert.ok([1, 2, 3, 4, 5].includes(row.envelope_version));
    assert.ok([1, 2, 3, 4, 5].includes(row.post_version));
    assert.ok(
      row.envelope &&
        typeof row.envelope === 'object' &&
        !Object.hasOwn(row.envelope, 'textSource'),
      'Historical enrollment rejects explicit text sources',
    );
    const envelope = canonicalEnvelope(row.envelope);
    assert.equal(envelope.version, row.envelope_version);
    assert.equal(
      envelope.version,
      kind === 'post' ? row.post_version : row.post_version === 4 ? 4 : 1,
    );
    assert.equal(canonicalJson(envelope), canonicalJson(row.envelope));
    assert.equal(approvalDigest(envelope), row.digest);
    assert.equal(envelope.accountId, row.account_id);
    assert.equal(envelope.accountId, row.content_account_id);
    assert.equal(envelope.text, row.text);
    assert.equal(envelope.purpose, operation);
    assert.equal(row.operation, operation);
    assert.equal(row.receipt?.requestId, requestId);
    assert.equal(row.receipt?.operation, operation);
    assert.equal(row.receipt?.outcome, 'created');
    assert.equal(row.receipt?.resourceId, id);
    await boundary();
  }
}

export function configureHistoricalReadingEnrollment(
  builder: TestingModuleBuilder,
  requirePrefix: (tx: PoolClient) => Promise<void>,
): void {
  builder.overrideProvider(ReadingFormattingRuntime).useFactory({
    inject: [DatabaseService, ReadingSourceOwner],
    factory: (database: DatabaseService, sources: ReadingSourceOwner) =>
      new HistoricalReadingFormattingRuntime(database, sources, requirePrefix),
  });
}
