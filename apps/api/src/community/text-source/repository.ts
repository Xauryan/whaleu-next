import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';
import type {
  AcceptedApproval,
  ContentKind,
} from '../content-review/contracts.js';
import type { SnapshotReadBudget } from '../content-review/count-snapshot.repository.js';
import type { TextSourceDescriptor } from './contracts.js';
import { reviewedTextSource } from './protocol.js';
import type { ReviewedTextSource } from './protocol.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const storedTextSourceSchema = z
  .strictObject({
    content_kind: z.enum(['post', 'comment', 'reply']),
    content_id: z.uuid(),
    source_revision: z.literal(1),
    source_version: z.literal(1),
    source_format: z.enum(['plain', 'markdown']),
    reading_formatting: z.enum(['auto', 'off']).nullable(),
    source_hash: digest,
    account_id: z.uuid(),
    client_request_id: z.uuid(),
    requested_author_mode: z.enum(['named', 'anonymous']),
    original_intent_hash: digest,
    decision_id: z.uuid(),
    approval_digest: digest,
  })
  .superRefine((row, ctx) => {
    if (
      (row.source_format === 'markdown') !==
      (row.reading_formatting === null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid stored reading policy',
      });
  });
export type StoredTextSource = z.infer<typeof storedTextSourceSchema>;
const projection =
  's.content_kind,s.content_id,s.source_revision,s.source_version,s.source_format,s.reading_formatting,s.source_hash,s.account_id,s.client_request_id,s.requested_author_mode,s.original_intent_hash,s.decision_id,s.approval_digest';
export async function readTextSources(
  kinds: ContentKind[],
  ids: string[],
  tx: PoolClient,
  budget?: SnapshotReadBudget,
): Promise<Map<string, StoredTextSource>> {
  if (kinds.length !== ids.length || ids.length > 768)
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  if (!ids.length) return new Map();
  const sql = `SELECT ${projection} FROM unnest($1::text[],$2::uuid[]) wanted(kind,id) JOIN whaleu_community.community_text_sources s ON s.content_kind=wanted.kind AND s.content_id=wanted.id`;
  const rows = budget
    ? await budget.rows<unknown>(tx, sql, [kinds, ids], ids.length)
    : (await tx.query(sql + ' FOR SHARE OF s', [kinds, ids])).rows;
  const result = new Map<string, StoredTextSource>();
  for (const raw of rows) {
    const row = storedTextSourceSchema.safeParse(raw);
    if (!row.success) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const key = `${row.data.content_kind}:${row.data.content_id}`;
    if (result.has(key))
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    result.set(key, row.data);
  }
  return result;
}
export function storedSourceDescriptor(
  row: StoredTextSource,
): TextSourceDescriptor {
  return row.source_format === 'plain'
    ? {
        version: 1,
        format: 'plain',
        readingFormatting: row.reading_formatting!,
      }
    : { version: 1, format: 'markdown' };
}
export function reconstructTextSource(
  row: StoredTextSource,
  kind: ContentKind,
  id: string,
  accountId: string,
  text: string,
): ReviewedTextSource | null {
  const parsed = storedTextSourceSchema.safeParse(row);
  if (
    !parsed.success ||
    row.content_kind !== kind ||
    row.content_id !== id ||
    row.account_id !== accountId
  )
    return null;
  try {
    const source = reviewedTextSource(
      text,
      storedSourceDescriptor(parsed.data),
      kind,
    );
    return source.sourceHash === row.source_hash ? source : null;
  } catch {
    return null;
  }
}
/** Called before Review binding but after canonical content/assets. Deferred SQL
 * closes the independent source, original request, exact binding and receipt together. */
export async function insertTextSource(
  input: {
    kind: ContentKind;
    id: string;
    accountId: string;
    requestId: string;
    requestedAuthorMode: 'named' | 'anonymous';
    originalIntentHash: string;
    text: string;
    source: TextSourceDescriptor | undefined;
    approval: AcceptedApproval | undefined;
  },
  tx: PoolClient,
): Promise<void> {
  if (input.source === undefined) {
    if (input.approval?.version === 6)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return;
  }
  const source = reviewedTextSource(input.text, input.source, input.kind);
  if (
    !input.approval ||
    input.approval.version !== 6 ||
    input.approval.envelope.version !== 6 ||
    input.approval.envelope.textSource.sourceHash !== source.sourceHash
  )
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  await tx.query(
    `INSERT INTO whaleu_community.community_text_sources(content_kind,content_id,source_revision,source_version,source_format,reading_formatting,source_hash,account_id,client_request_id,requested_author_mode,original_intent_hash,decision_id,approval_digest) VALUES($1,$2,1,1,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      input.kind,
      input.id,
      source.format,
      source.format === 'plain' ? source.readingFormatting : null,
      source.sourceHash,
      input.accountId,
      input.requestId,
      input.requestedAuthorMode,
      input.originalIntentHash,
      input.approval.decisionId,
      input.approval.digest,
    ],
  );
}
