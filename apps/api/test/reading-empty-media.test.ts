/** Actual owner/leaf classes with deterministic SQL-result fixtures. This catches
 * wiring/retained-proof bugs but is not PostgreSQL publication evidence. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CurrentContentMediaProof } from '../src/community/content-review/media-proof.js';
import { ReadingSourceOwner } from '../src/community/reading-formatting/source-owner.js';
import {
  canonicalEnvelope,
  approvalDigest,
} from '../src/community/content-review/contracts.js';
import { reviewedTextSource } from '../src/community/text-source/protocol.js';
import type { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import type { ContentDefinitionRepository } from '../src/community/content-review/content-definition.repository.js';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import { IdentityService } from '../src/identity/identity.service.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  let mediaEpoch = 0,
    binding = false;
  const sqls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      sqls.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 32,
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.startsWith('SELECT slot,version,epoch::text'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: String(sql.includes('whaleu_media.') ? mediaEpoch : 0),
          })),
        };
      if (sql.startsWith('SELECT pg_try_advisory_xact_lock_shared'))
        return { rows: Array.from({ length: 128 }, () => ({ locked: true })) };
      if (sql.startsWith('SELECT pg_try_advisory_xact_lock'))
        return { rows: [{ locked: true }] };
      if (sql.startsWith('SELECT id FROM whaleu_media.bindings'))
        return { rows: binding ? [{ id: id(9) }] : [] };
      if (
        sql.startsWith('SELECT * FROM whaleu_community.posts') ||
        sql.startsWith('SELECT id,account_id FROM whaleu_community.posts')
      )
        return { rows: [{ id: id(1), account_id: id(3) }] };
      if (sql.startsWith('SELECT id,status,lifecycle'))
        return {
          rows: [
            {
              id: id(3),
              status: 'active',
              lifecycle: 'active',
              lifecycle_generation: '0',
              xmin: '1',
            },
          ],
        };
      if (sql.includes('COALESCE(v.owner_hidden,false)'))
        return {
          rows: [
            {
              postId: id(1),
              ownerHidden: false,
              version: 0,
              requestId: null,
              xmin: null,
            },
          ],
        };
      if (sql.includes('account_punishment_policy_observation'))
        return {
          rows: [
            {
              fingerprint: 'fixture-current',
              allowed: true,
              suspended: false,
              until: null,
            },
          ],
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    tx,
    sqls,
    insertBinding() {
      binding = true;
      mediaEpoch++;
    },
  };
}
test('actual Media absent leaf proves empty binding set and retains mandatory native Media fence', async () => {
  const f = fixture();
  try {
    assert.equal(
      (await new CurrentContentMediaProof().absent('post', id(1), f.tx)).kind,
      'allow',
    );
    await checkTransactionDeadlines(f.tx);
    assert.ok(
      f.sqls.some(
        (sql) => sql.includes("slot='images'") && sql.includes('LIMIT 1'),
      ),
    );
    assert.ok(
      f.sqls.some((sql) =>
        sql.includes('LOCK TABLE whaleu_media.media_owner_states'),
      ),
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('actual Media absent leaf rejects a current binding, unmanaged lifetime and empty nonempty-descriptor API', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      new CurrentContentMediaProof().current('post', id(1), [], f.tx),
    );
    f.insertBinding();
    await assert.rejects(
      new CurrentContentMediaProof().absent('post', id(1), f.tx),
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
  await assert.rejects(
    new CurrentContentMediaProof().absent('post', id(1), f.tx),
  );
});
test('actual Media negative fact cannot survive empty-to-first-binding epoch change', async () => {
  const f = fixture();
  try {
    await new CurrentContentMediaProof().absent('reply', id(1), f.tx);
    f.insertBinding();
    await assert.rejects(checkTransactionDeadlines(f.tx));
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('actual ReadingSourceOwner resolves eligible v6 text through real empty Media and Identity leaves', async () => {
  const f = fixture();
  try {
    const text = ('鲸'.repeat(119) + '。').repeat(3),
      descriptor = {
        version: 1,
        format: 'plain',
        readingFormatting: 'auto',
      } as const;
    const textSource = reviewedTextSource(text, descriptor, 'post');
    const envelope = canonicalEnvelope({
      version: 6,
      accountId: id(3),
      purpose: 'publish_post',
      spaceId: id(4),
      category: 'discussion',
      authorMode: 'named',
      commentsPolicy: 'open',
      allowAnonymousDm: false,
      postId: null,
      rootCommentId: null,
      targetReplyId: null,
      text,
      images: [],
      component: { kind: 'none' },
      trading: null,
      textSource,
      scope: {
        originalSpaceId: id(4),
        originalRegionId: id(5),
        authorOriginRegionId: id(5),
        identityRegionId: id(5),
        topologySnapshotId: null,
        sync: 'none',
      },
    });
    const digest = approvalDigest(envelope),
      accepted = { decisionId: id(6), digest, envelope };
    const stored = {
      content_kind: 'post',
      content_id: id(1),
      source_revision: 1,
      source_version: 1,
      source_format: 'plain',
      reading_formatting: 'auto',
      source_hash: textSource.sourceHash,
      account_id: id(3),
      client_request_id: id(2),
      requested_author_mode: 'named',
      original_intent_hash: '0'.repeat(64),
      decision_id: id(6),
      approval_digest: digest,
    };
    const approvals = {
      binding: async () => ({ decision_id: id(6) }),
      current: async () => ({ kind: 'allow', value: accepted }),
    } as unknown as ApprovalRepository;
    const definitions = {
      current: async () => ({
        kind: 'allow',
        value: {
          envelope,
          textSource: stored,
          authorAccountId: id(3),
          authorMode: 'named',
          parents: [],
        },
      }),
    } as unknown as ContentDefinitionRepository;
    const identity = new IdentityService(
      {
        exchange: async () => {
          throw new Error('No provider allowed');
        },
      },
      new IdentityRepository({} as DatabaseService),
    );
    const owner = new ReadingSourceOwner(approvals, definitions, identity);
    const expected = {
      kind: 'post' as const,
      id: id(1),
      sourceRevision: 1 as const,
      sourceHash: textSource.sourceHash,
      publicationRequestId: id(2),
    };
    assert.deepEqual(await owner.resolve(expected, f.tx), {
      ...expected,
      text,
      descriptor,
    });
    await checkTransactionDeadlines(f.tx);
    assert.ok(
      f.sqls.some((sql) =>
        sql.startsWith('SELECT id FROM whaleu_media.bindings'),
      ),
    );
    assert.ok(
      f.sqls.some((sql) =>
        sql.includes('LOCK TABLE whaleu_media.media_owner_states'),
      ),
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
