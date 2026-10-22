import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CommunitySocialSourceCapture } from '../../src/community/social-source/capture.js';
import request from 'supertest';
import { CampusService } from '../../src/campus/campus.service.js';
import { DatabaseService } from '../../src/database/database.js';
import { ReadingFormattingRuntime } from '../../src/community/reading-formatting/runtime.js';
import { ReadingSourceOwner } from '../../src/community/reading-formatting/source-owner.js';
import { HistoricalReadingFormattingRuntime } from '../support/historical-content-definition/reading-enrollment.js';
import { ContentDefinitionRepository } from '../../src/community/content-review/content-definition.repository.js';
import type { ContentScopeSnapshot } from '../../src/community/content-review/contracts.js';
import { HistoricalContentDefinitionRepository } from '../support/historical-content-definition/configure.js';
import {
  accountDeletionFollowSocialFixture,
  deletionRequest,
} from '../support/account-deletion-follow-social-fixture.js';
import type {
  AccountDeletionFollowSocialFixture,
  FollowDeletionActor,
} from '../support/account-deletion-follow-social-fixture.js';
import {
  accountDeletionCapability,
  COOLING_MS,
  INVENTORY_VERSION,
} from '../../src/account-deletion/contracts.js';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
  discoveryScopeHash,
} from '../../src/community/discovery-cursors.js';
import { hashToken } from '../../src/identity/tokens.js';
import type { SocialNotice } from '../../src/notifications/social/contracts.js';
import type { PublishPost } from '../../src/community/contracts.js';
import {
  postApprovalEnvelope,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import {
  appendIdentitySelection,
  seedCommunityScope,
} from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';

const constraint = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['23514', '23503', '55000'].includes(String(error.code));
const auth = (actor: { accessToken: string }) => `Bearer ${actor.accessToken}`;

async function graph(
  f: AccountDeletionFollowSocialFixture,
  ids: readonly string[],
) {
  const result: Record<string, string[]> = {};
  for (const [name, sql] of [
    [
      'sources',
      'SELECT to_jsonb(t)::text row FROM whaleu_community.social_sources t WHERE id=ANY($1::uuid[]) ORDER BY id',
    ],
    [
      'work',
      'SELECT to_jsonb(t)::text row FROM whaleu_notifications.social_work t WHERE source_id=ANY($1::uuid[]) ORDER BY source_id',
    ],
    [
      'receipts',
      'SELECT to_jsonb(t)::text row FROM whaleu_notifications.social_receipts t WHERE source_id=ANY($1::uuid[]) ORDER BY source_id',
    ],
    [
      'notices',
      'SELECT to_jsonb(t)::text row FROM whaleu_notifications.social_notices t WHERE source_id=ANY($1::uuid[]) OR id IN(SELECT notice_id FROM whaleu_notifications.social_receipts WHERE source_id=ANY($1::uuid[])) ORDER BY id',
    ],
  ]) {
    result[name!] = (await f.pool.query<{ row: string }>(sql!, [ids])).rows.map(
      (r) => r.row,
    );
  }
  return result;
}

function unavailable(notice: SocialNotice) {
  assert.equal(notice.status, 'unavailable');
  assert.deepEqual(Object.keys(notice).sort(), [
    'createdAt',
    'noticeId',
    'readAt',
    'status',
  ]);
}

async function closed(
  f: AccountDeletionFollowSocialFixture,
  actor: FollowDeletionActor,
  id: string,
) {
  const rows = (
    await f.pool.query<{ surface: string; n: number }>(
      `SELECT 'edges' surface,count(*)::integer n FROM whaleu_community.user_follows WHERE follower_id=$1 OR followed_id=$1
     UNION ALL SELECT 'heads',count(*)::integer FROM whaleu_community.follow_heads WHERE account_id=$1
     UNION ALL SELECT 'commands',count(*)::integer FROM whaleu_community.follow_requests WHERE account_id=$1
     UNION ALL SELECT 'incoming sources',count(*)::integer FROM whaleu_community.social_sources WHERE recipient_account_id=$1
     UNION ALL SELECT 'incoming work',count(*)::integer FROM whaleu_notifications.social_work WHERE recipient_account_id=$1
     UNION ALL SELECT 'incoming notices',count(*)::integer FROM whaleu_notifications.social_notices WHERE recipient_account_id=$1
     UNION ALL SELECT 'incoming receipts',count(*)::integer FROM whaleu_notifications.social_receipts WHERE recipient_account_id=$1
     UNION ALL SELECT 'notification owner',count(*)::integer FROM whaleu_notifications.owners WHERE account_id=$1
     UNION ALL SELECT 'private cursor bucket',count(*)::integer FROM whaleu_community.discovery_cursors WHERE bucket_hash=$2`,
      [actor.accountId, discoveryCursorBucket(actor.accountId).hash],
    )
  ).rows;
  for (const row of rows)
    assert.equal(row.n, 0, `Required removal: ${row.surface}`);
  assert.equal(
    (
      await f.pool.query<{ complete: boolean }>(
        'SELECT whaleu_account_deletion.follow_social_complete($1) complete',
        [id],
      )
    ).rows[0]?.complete,
    true,
  );
  const receipt = (
    await f.pool.query<{ inventory: string; proof: string }>(
      "SELECT inventory,proof FROM whaleu_account_deletion.owner_receipts WHERE request_id=$1 AND owner='follow-social'",
      [id],
    )
  ).rows;
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0]!.inventory, 'account-deletion-local-0173-v1');
  assert.match(receipt[0]!.proof, /^[a-f0-9]{64}$/);
}

async function revision(
  f: AccountDeletionFollowSocialFixture,
  actor: { accountId: string },
) {
  return BigInt(
    (
      await f.pool.query<{ revision: string }>(
        'SELECT revision::text FROM whaleu_community.follow_heads WHERE account_id=$1',
        [actor.accountId],
      )
    ).rows[0]?.revision ?? '0',
  );
}

async function fingerprints(
  f: AccountDeletionFollowSocialFixture,
  ids: readonly string[],
) {
  return (
    await f.pool.query<{ source_id: string; source_fingerprint: string }>(
      `SELECT id source_id,whaleu_account_deletion.follow_source_fingerprint(id) source_fingerprint
       FROM whaleu_community.social_sources WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [ids],
    )
  ).rows;
}

async function evidence(
  f: AccountDeletionFollowSocialFixture,
  table:
    | 'follow_source_intents'
    | 'follow_source_retirements'
    | 'follow_source_erasures',
  requestId: string,
  expected: { source_id: string; source_fingerprint: string }[],
) {
  const facts = (
    await f.pool.query<{
      source_id: string;
      source_fingerprint: string;
      generation: string;
    }>(
      `SELECT source_id,source_fingerprint,generation::text FROM whaleu_account_deletion.${table}
      WHERE request_id=$1 ORDER BY source_id`,
      [requestId],
    )
  ).rows;
  assert.deepEqual(
    facts,
    expected.map((fact) => ({ ...fact, generation: '1' })),
  );
}

// Successor acceptance only: the frozen 0172 artifact and baseline fixture
// remain untouched; its live rejection assertion now covers an external peer.
// Run through the centrally serialized disposable PG lane.
test(
  '0173 synthetic follow-social owner: real lineage, bounded erasure and honest retained evidence',
  { timeout: 900000 },
  async (t) => {
    const f = await accountDeletionFollowSocialFixture();
    t.after(() => f.close());
    assert.equal(INVENTORY_VERSION, 'account-deletion-local-0173-v1');
    assert.equal(accountDeletionCapability().status, 'unavailable');

    await t.test(
      'both directions, re-follow, pending settlement, exact cursors and sequential recipient precedence',
      async () => {
        const a = await f.create(),
          b = await f.create(),
          c = await f.create(),
          d = await f.create(),
          e = await f.create();
        const privateData = await f.populate(a),
          pa = privateData.profileId;
        assert.ok(pa);
        const pb = await f.profile(b),
          pc = await f.profile(c),
          pd = await f.profile(d);
        const firstCommand = randomUUID();
        const first = await f.following.set(
          a.accessToken,
          pb,
          true,
          firstCommand,
        );
        assert.equal(first.outcome, 'applied');
        await f.settle((await f.sources(a, b)).map((s) => s.id));
        const original = (
          await f.socialReads.list(b.accessToken, {
            category: 'followers',
            limit: 20,
          })
        ).items[0]!;
        const firstRead = await f.socialReads.markRead(
          b.accessToken,
          original.noticeId,
          'followers',
        );
        const initialRevision = await revision(f, a);
        assert.deepEqual(
          await f.following.set(a.accessToken, pb, true, firstCommand),
          first,
        );
        assert.equal(
          (await f.following.set(a.accessToken, pb, true, randomUUID()))
            .outcome,
          'applied',
        );
        assert.equal((await f.sources(a, b)).length, 1);
        assert.equal(await revision(f, a), initialRevision);
        await f.following.set(a.accessToken, pb, false, randomUUID());
        assert.deepEqual(
          await f.following.set(a.accessToken, pb, true, firstCommand),
          first,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.user_follows WHERE follower_id=$1 AND followed_id=$2',
              [a.accountId, b.accountId],
            )
          ).rowCount,
          0,
        );
        await f.following.set(a.accessToken, pb, true, randomUUID());
        await f.settle((await f.sources(a, b)).map((s) => s.id));
        assert.equal(
          new Set((await f.sources(a, b)).map((s) => s.notice_id)).size,
          1,
        );

        await f.following.set(a.accessToken, pc, true, randomUUID());
        await f.settle((await f.sources(a, c)).map((s) => s.id));
        const unread = (
          await f.socialReads.list(c.accessToken, {
            category: 'followers',
            limit: 20,
          })
        ).items[0]!;
        assert.equal(unread.readAt, null);
        const peerCommand = randomUUID();
        const peerReceipt = await f.following.set(
          b.accessToken,
          pa,
          true,
          peerCommand,
        );
        await f.settle((await f.sources(b, a)).map((s) => s.id));
        await f.following.set(b.accessToken, pa, false, randomUUID());
        await f.following.set(b.accessToken, pa, true, randomUUID());
        await f.settle((await f.sources(b, a)).map((s) => s.id));
        assert.equal(
          new Set((await f.sources(b, a)).map((s) => s.notice_id)).size,
          1,
        );
        await f.following.set(c.accessToken, pa, true, randomUUID());
        await f.following.set(c.accessToken, pb, true, randomUUID());
        await f.following.set(b.accessToken, pc, true, randomUUID());
        await f.settle((await f.sources(c, null)).map((s) => s.id));
        await f.settle((await f.sources(b, c)).map((s) => s.id));
        await f.following.set(a.accessToken, pd, true, randomUUID());
        await f.following.set(e.accessToken, pa, true, randomUUID());
        const outgoingPending = (await f.sources(a, d))[0]!;
        const incomingPending = (await f.sources(e, a))[0]!;
        assert.equal(outgoingPending.state, 'pending');
        assert.equal(incomingPending.state, 'pending');
        assert.equal(
          (
            await f.following.set(
              a.accessToken,
              randomUUID(),
              false,
              randomUUID(),
            )
          ).outcome,
          'applied',
        );
        assert.equal(
          (await f.following.set(a.accessToken, pa, true, randomUUID()))
            .outcome,
          'rejected',
        );
        assert.equal(
          (
            await f.following.set(
              a.accessToken,
              randomUUID(),
              true,
              randomUUID(),
            )
          ).outcome,
          'rejected',
        );

        const aPage = await f.socialReads.list(a.accessToken, {
          category: 'followers',
          limit: 1,
        });
        const bPage = await f.socialReads.list(b.accessToken, {
          category: 'followers',
          limit: 1,
        });
        assert.ok(aPage.nextCursor);
        assert.ok(bPage.nextCursor);
        const bCursors = (
          await f.pool.query(
            'SELECT * FROM whaleu_community.discovery_cursors WHERE bucket_hash=$1 ORDER BY cursor',
            [discoveryCursorBucket(b.accountId).hash],
          )
        ).rows;
        assert.ok(bCursors.length > 0);
        const incomingIds = (await f.sources(null, a)).map((s) => s.id);
        const retainedIds = (await f.sources(a, null))
          .filter((s) => s.state === 'completed')
          .map((s) => s.id);
        const incomingFingerprints = await fingerprints(f, incomingIds);
        const outgoingFingerprints = await fingerprints(f, [
          ...retainedIds,
          outgoingPending.id,
        ]);
        const retained = await graph(f, retainedIds);
        const unrelatedIds = (await f.sources(b, c)).map((s) => s.id);
        const unrelated = await graph(f, unrelatedIds);
        const historicalPeerCommand = (
          await f.pool.query(
            'SELECT * FROM whaleu_community.follow_requests WHERE account_id=$1 AND request_id=$2',
            [b.accountId, peerCommand],
          )
        ).rows;
        const bBefore = await revision(f, b),
          cBefore = await revision(f, c),
          eBefore = await revision(f, e);
        assert.equal(
          (await f.service.eligibility(f.assertion(a))).status,
          'eligible',
        );
        const command = deletionRequest();
        const accepted = await f.service.request(f.assertion(a), command);
        assert.equal(accepted.status.phase, 'cooling');
        assert.deepEqual(
          await graph(f, retainedIds),
          retained,
          'Cooling does not erase history',
        );
        const coolingWork = await f.socialWorker.run({
          mode: 'apply',
          sourceIds: [outgoingPending.id, incomingPending.id],
        });
        assert.equal(coolingWork.materialized, 0);
        assert.equal((await f.sources(a, d))[0]!.state, 'pending');
        assert.equal((await f.sources(e, a))[0]!.state, 'pending');
        await f.advance(COOLING_MS - 1);
        assert.equal((await f.worker.tick(command.requestId)).phase, 'cooling');
        await f.advance(1);
        const completed = await f.complete(command.requestId);
        assert.equal(completed.status.completedAt, f.now());
        await closed(f, a, command.requestId);
        await evidence(
          f,
          'follow_source_intents',
          command.requestId,
          incomingFingerprints,
        );
        await evidence(
          f,
          'follow_source_erasures',
          command.requestId,
          incomingFingerprints,
        );
        await evidence(
          f,
          'follow_source_retirements',
          command.requestId,
          outgoingFingerprints,
        );
        assert.deepEqual(
          await graph(f, retainedIds),
          retained,
          'Materialized outgoing lineage is byte-for-byte retained',
        );
        assert.deepEqual(
          await graph(f, unrelatedIds),
          unrelated,
          'Unrelated B → C graph must not be swept',
        );
        assert.deepEqual(await graph(f, incomingIds), {
          sources: [],
          work: [],
          receipts: [],
          notices: [],
        });
        assert.equal(await revision(f, b), bBefore + 1n);
        assert.equal(await revision(f, c), cBefore + 1n);
        assert.equal(await revision(f, e), eBefore + 1n);
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_community.discovery_cursors WHERE bucket_hash=$1 ORDER BY cursor',
              [discoveryCursorBucket(b.accountId).hash],
            )
          ).rows,
          bCursors,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_notifications.owners WHERE account_id=$1',
              [b.accountId],
            )
          ).rowCount,
          1,
        );
        assert.deepEqual(await f.residue(privateData.sentinels), []);

        const pendingAfter = (await f.sources(a, d))[0]!;
        assert.equal(pendingAfter.state, 'completed');
        assert.equal(pendingAfter.outcome, 'account_deleted');
        assert.equal(pendingAfter.notice_id, null);
        assert.equal(
          (
            await f.socialReads.list(d.accessToken, {
              category: 'followers',
              limit: 20,
            })
          ).items.length,
          0,
        );
        const replay = await f.socialWorker.run({
          mode: 'apply',
          sourceIds: [outgoingPending.id, incomingPending.id, ...retainedIds],
        });
        assert.equal(replay.materialized, 0);
        assert.equal(replay.existing, 0);
        assert.equal(replay.retryable, 0);
        assert.equal(replay.missing, 1);
        assert.equal(replay.alreadyProcessed, retainedIds.length + 1);
        const bAfter = (
          await f.socialReads.list(b.accessToken, {
            category: 'followers',
            limit: 20,
          })
        ).items.find((n) => n.noticeId === original.noticeId)!;
        unavailable(bAfter);
        assert.equal(bAfter.createdAt, original.createdAt);
        assert.equal(bAfter.readAt, firstRead.readAt);
        assert.deepEqual(
          await f.socialReads.target(
            b.accessToken,
            original.noticeId,
            'followers',
          ),
          { noticeId: original.noticeId, status: 'unavailable' },
        );
        assert.equal(
          (
            await f.socialReads.markRead(
              b.accessToken,
              original.noticeId,
              'followers',
            )
          ).readAt,
          firstRead.readAt,
        );
        const cAfter = (
          await f.socialReads.list(c.accessToken, {
            category: 'followers',
            limit: 20,
          })
        ).items.find((n) => n.noticeId === unread.noticeId)!;
        unavailable(cAfter);
        assert.equal(cAfter.readAt, null);
        const laterRead = await f.socialReads.markRead(
          c.accessToken,
          unread.noticeId,
          'followers',
        );
        assert.match(laterRead.readAt, /^\d{4}-.*\.\d{6}Z$/);
        assert.equal(
          (
            await f.socialReads.markRead(
              c.accessToken,
              unread.noticeId,
              'followers',
            )
          ).readAt,
          laterRead.readAt,
        );
        await closed(f, a, command.requestId);
        assert.deepEqual(
          await f.following.set(b.accessToken, pa, true, peerCommand),
          peerReceipt,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_community.follow_requests WHERE account_id=$1 AND request_id=$2',
              [b.accountId, peerCommand],
            )
          ).rows,
          historicalPeerCommand,
        );
        assert.equal(
          (await f.following.set(b.accessToken, pa, true, randomUUID()))
            .outcome,
          'rejected',
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.user_follows WHERE followed_id=$1 OR follower_id=$1',
              [a.accountId],
            )
          ).rowCount,
          0,
        );
        await assert.rejects(
          f.socialReads.list(a.accessToken, {
            category: 'followers',
            limit: 1,
            cursor: aPage.nextCursor!,
          }),
        );
        await assert.rejects(f.identity.authenticate(hashToken(a.accessToken)));
        await assert.rejects(
          f.repository.transaction((tx) =>
            new DiscoveryCursorRepository().create(
              discoveryScopeHash(['synthetic-late-cursor', a.accountId]),
              discoveryCursorBucket(a.accountId),
              { v: 1, index: 1 },
              tx,
            ),
          ),
          /lifecycle|erasure|cursor|account/i,
        );

        // The immutable sender proof must compose with B's later recipient erasure.
        const aReceipt = (
          await f.pool.query(
            "SELECT * FROM whaleu_account_deletion.owner_receipts WHERE request_id=$1 AND owner='follow-social'",
            [command.requestId],
          )
        ).rows;
        const aToB = (await f.sources(a, b)).map((s) => s.id);
        const aToBFingerprints = await fingerprints(f, aToB);
        const next = deletionRequest();
        assert.equal(
          (await f.service.eligibility(f.assertion(b))).status,
          'eligible',
        );
        await f.service.request(f.assertion(b), next);
        await f.advance(COOLING_MS);
        await f.complete(next.requestId);
        await closed(f, b, next.requestId);
        assert.deepEqual(await graph(f, aToB), {
          sources: [],
          work: [],
          receipts: [],
          notices: [],
        });
        const successorFacts = (
          await f.pool.query<{
            source_id: string;
            source_fingerprint: string;
            request_id: string;
          }>(
            'SELECT source_id,source_fingerprint,request_id FROM whaleu_account_deletion.follow_source_erasures WHERE source_id=ANY($1::uuid[]) ORDER BY source_id',
            [aToB],
          )
        ).rows;
        assert.deepEqual(
          successorFacts,
          aToBFingerprints.map((fact) => ({
            ...fact,
            request_id: next.requestId,
          })),
        );
        // Drive the actual positive-edge/receipt/capture transaction, changing
        // only its generated source UUID. Provenance is otherwise fully native;
        // an old worker ID must never be adopted by a fresh graph.
        const freshActor = await f.create(),
          freshRecipient = await f.create();
        const freshTarget = await f.profile(freshRecipient),
          reusedSource = aToB[0]!;
        const freshCommand = randomUUID(),
          capture = f.app.get(CommunitySocialSourceCapture);
        const originalCapture = capture.follow.bind(capture);
        capture.follow = async (actor, recipient, profile, requestId, tx) => {
          let generated: string | undefined;
          const guarded = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === 'query')
                return (sql: string, values?: unknown[]) => {
                  const rewritten = values ? [...values] : undefined;
                  if (
                    sql.includes(
                      'INSERT INTO whaleu_community.social_sources',
                    ) &&
                    rewritten
                  ) {
                    generated = String(rewritten[0]);
                    rewritten[0] = reusedSource;
                  } else if (generated && rewritten?.[0] === generated)
                    rewritten[0] = reusedSource;
                  return target.query(sql, rewritten);
                };
              return Reflect.get(target, property, receiver);
            },
          });
          return originalCapture(actor, recipient, profile, requestId, guarded);
        };
        try {
          await assert.rejects(
            f.following.set(
              freshActor.accessToken,
              freshTarget,
              true,
              freshCommand,
            ),
            /social source identity is permanently reserved/,
          );
        } finally {
          capture.follow = originalCapture;
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.user_follows WHERE follower_id=$1',
              [freshActor.accountId],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.follow_requests WHERE account_id=$1 AND request_id=$2',
              [freshActor.accountId, freshCommand],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.socialWorker.run({
              mode: 'apply',
              sourceIds: [reusedSource],
            })
          ).missing,
          1,
        );

        await closed(f, a, command.requestId);
        assert.deepEqual(
          (
            await f.pool.query(
              "SELECT * FROM whaleu_account_deletion.owner_receipts WHERE request_id=$1 AND owner='follow-social'",
              [command.requestId],
            )
          ).rows,
          aReceipt,
        );
        assert.equal(
          (await f.worker.tick(command.requestId)).phase,
          'completed',
        );
      },
    );

    await t.test(
      '101 edges and own commands, plus 101 receipts sharing one incoming lifetime notice, require real bounded pages',
      async () => {
        const owner = await f.create(),
          target = await f.profile(owner);
        const peers: FollowDeletionActor[] = [];
        for (let i = 0; i < 101; i++) {
          const peer = await f.create();
          peers.push(peer);
          assert.equal(
            (
              await f.following.set(
                peer.accessToken,
                target,
                true,
                randomUUID(),
              )
            ).outcome,
            'applied',
          );
          assert.equal(
            (
              await f.following.set(
                owner.accessToken,
                randomUUID(),
                false,
                randomUUID(),
              )
            ).outcome,
            'applied',
          );
        }
        const repeated = peers[0]!;
        for (let i = 1; i < 101; i++) {
          await f.following.set(
            repeated.accessToken,
            target,
            false,
            randomUUID(),
          );
          await f.following.set(
            repeated.accessToken,
            target,
            true,
            randomUUID(),
          );
        }
        const incoming = await f.sources(null, owner);
        assert.equal(incoming.length, 201);
        const incomingFingerprints = await fingerprints(
          f,
          incoming.map((s) => s.id),
        );
        await f.settle(incoming.map((s) => s.id));
        const repeatedSources = await f.sources(repeated, owner);
        assert.equal(repeatedSources.length, 101);
        assert.equal(new Set(repeatedSources.map((s) => s.notice_id)).size, 1);
        assert.ok(repeatedSources.every((s) => s.state === 'completed'));
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.user_follows WHERE followed_id=$1',
              [owner.accountId],
            )
          ).rowCount,
          101,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.follow_requests WHERE account_id=$1',
              [owner.accountId],
            )
          ).rowCount,
          101,
        );
        const peerCommands = (
          await f.pool.query(
            'SELECT * FROM whaleu_community.follow_requests WHERE account_id=ANY($1::uuid[]) ORDER BY account_id,request_id',
            [peers.map((p) => p.accountId)],
          )
        ).rows;
        const before = new Map<string, bigint>();
        for (const peer of peers)
          before.set(peer.accountId, await revision(f, peer));
        const command = deletionRequest();
        assert.equal(
          (await f.service.eligibility(f.assertion(owner))).status,
          'eligible',
        );
        await f.service.request(f.assertion(owner), command);
        await f.advance(COOLING_MS);
        const result = await f.complete(command.requestId);
        assert.ok(
          result.pages.some((page) =>
            page.pending.includes('OWNER_PAGE_PENDING'),
          ),
          'A >100 owner cannot claim one-page closure',
        );
        await closed(f, owner, command.requestId);
        await evidence(
          f,
          'follow_source_intents',
          command.requestId,
          incomingFingerprints,
        );
        await evidence(
          f,
          'follow_source_erasures',
          command.requestId,
          incomingFingerprints,
        );
        const pages = (
          await f.pool.query<{
            phase: number;
            item_count: number;
            before_boundary: string;
            after_boundary: string;
          }>(
            'SELECT phase,item_count,before_boundary,after_boundary FROM whaleu_account_deletion.follow_pages WHERE request_id=$1 ORDER BY page_number',
            [command.requestId],
          )
        ).rows;
        for (const [phase, counts] of [
          [0, [100, 1]],
          [1, [100, 1]],
          [2, [100, 100, 1]],
          [3, [100, 100, 1]],
          [4, [100, 1]],
          [5, [100, 100, 1]],
          [6, [100, 100, 1]],
        ] as const) {
          const actual = pages.filter(
            (page) => page.phase === phase && page.item_count > 0,
          );
          assert.deepEqual(
            actual.map((page) => page.item_count),
            [...counts],
            `Phase ${phase} is genuinely bounded`,
          );
          for (let i = 0; i < actual.length; i++) {
            assert.equal(
              actual[i]!.before_boundary,
              i === 0 ? '' : actual[i - 1]!.after_boundary,
            );
            assert.ok(actual[i]!.after_boundary > actual[i]!.before_boundary);
          }
        }
        assert.deepEqual(
          await graph(
            f,
            incoming.map((s) => s.id),
          ),
          { sources: [], work: [], receipts: [], notices: [] },
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_community.follow_requests WHERE account_id=ANY($1::uuid[]) ORDER BY account_id,request_id',
              [peers.map((p) => p.accountId)],
            )
          ).rows,
          peerCommands,
        );
        for (const peer of peers)
          assert.equal(
            await revision(f, peer),
            before.get(peer.accountId)! + 1n,
          );
        const replay = await f.socialWorker.run({
          mode: 'apply',
          sourceIds: incoming.slice(0, 50).map((s) => s.id),
        });
        assert.equal(replay.missing, 50);
        assert.equal(replay.materialized, 0);
        assert.equal(replay.retryable, 0);
      },
    );

    await t.test(
      'every destructive phase and its progress roll back together, then resume idempotently',
      async () => {
        const owner = await f.create(),
          first = await f.create(),
          second = await f.create();
        const target = await f.profile(owner),
          peer = await f.profile(first);
        await f.following.set(first.accessToken, target, true, randomUUID());
        await f.following.set(second.accessToken, target, true, randomUUID());
        await f.settle((await f.sources(null, owner)).map((row) => row.id));
        await f.following.set(owner.accessToken, peer, true, randomUUID());
        const cursor = await f.socialReads.list(owner.accessToken, {
          category: 'followers',
          limit: 1,
        });
        assert.ok(cursor.nextCursor);
        const ids = [
          ...(await f.sources(null, owner)),
          ...(await f.sources(owner, null)),
        ].map((row) => row.id);
        const command = deletionRequest();
        await f.service.request(f.assertion(owner), command);
        await f.advance(COOLING_MS);
        const snapshot = async () => ({
          graph: await graph(f, ids),
          scopes: (
            await f.pool.query(
              'SELECT * FROM whaleu_account_deletion.follow_scopes WHERE request_id=$1',
              [command.requestId],
            )
          ).rows,
          pages: (
            await f.pool.query(
              'SELECT * FROM whaleu_account_deletion.follow_pages WHERE request_id=$1 ORDER BY page_number',
              [command.requestId],
            )
          ).rows,
          mutations: (
            await f.pool.query(
              'SELECT * FROM whaleu_account_deletion.follow_mutations WHERE request_id=$1 ORDER BY page_number,row_key',
              [command.requestId],
            )
          ).rows,
          edges: (
            await f.pool.query(
              'SELECT * FROM whaleu_community.user_follows WHERE follower_id=$1 OR followed_id=$1 ORDER BY follower_id,followed_id',
              [owner.accountId],
            )
          ).rows,
          commands: (
            await f.pool.query(
              'SELECT * FROM whaleu_community.follow_requests WHERE account_id=$1 ORDER BY request_id',
              [owner.accountId],
            )
          ).rows,
          heads: (
            await f.pool.query(
              'SELECT * FROM whaleu_community.follow_heads WHERE account_id=ANY($1::uuid[]) ORDER BY account_id',
              [[owner.accountId, first.accountId, second.accountId]],
            )
          ).rows,
          cursors: (
            await f.pool.query(
              'SELECT * FROM whaleu_community.discovery_cursors WHERE bucket_hash=$1 ORDER BY cursor',
              [discoveryCursorBucket(owner.accountId).hash],
            )
          ).rows,
        });
        const phases: number[] = [];
        for (let attempt = 0; attempt < 20; attempt++) {
          const phase =
            (
              await f.pool.query<{ phase: number }>(
                'SELECT phase FROM whaleu_account_deletion.follow_scopes WHERE request_id=$1',
                [command.requestId],
              )
            ).rows[0]?.phase ?? 0;
          if (phase === 11) break;
          phases.push(phase);
          const before = await snapshot();
          await assert.rejects(
            f.repository.transaction(async (tx) => {
              await tx.query(
                "SELECT pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0))",
              );
              await f.repository.lockAccount(tx, owner.accountId);
              let row = await f.repository.request(tx, command.requestId);
              if (row.phase === 'cooling') {
                await tx.query(
                  "UPDATE whaleu_account_deletion.requests SET phase='erasing',revision=revision+1,irreversible_at=$2 WHERE id=$1",
                  [row.id, new Date(f.now())],
                );
                row = await f.repository.request(tx, row.id);
              }
              await f.repository.cause(tx, row, 'follow-social');
              await tx.query(
                'SELECT whaleu_account_deletion.follow_social_page($1)',
                [row.id],
              );
              throw new Error(
                'synthetic failure after phase mutation and progress',
              );
            }),
            /synthetic failure after phase/,
          );
          assert.deepEqual(
            await snapshot(),
            before,
            `Phase ${phase} rolled back graph and progress`,
          );
          await f.worker.tick(command.requestId);
        }
        assert.deepEqual(phases, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        await f.complete(command.requestId);
        await closed(f, owner, command.requestId);
      },
    );

    await t.test(
      'ordinary invariants and forged owner causes fail without touching native lineage',
      async () => {
        const actor = await f.create(),
          peer = await f.create(),
          unrelated = await f.create();
        const target = await f.profile(peer),
          actorProfile = await f.profile(actor);
        const commandId = randomUUID();
        await f.following.set(actor.accessToken, target, true, commandId);
        await f.following.set(
          peer.accessToken,
          actorProfile,
          true,
          randomUUID(),
        );
        const source = (await f.sources(actor, peer))[0]!;
        await f.settle([source.id]);
        const settled = (await f.sources(actor, peer))[0]!;
        assert.ok(settled.notice_id);
        const original = await graph(f, [source.id]);
        for (const [sql, values] of [
          [
            'DELETE FROM whaleu_community.social_sources WHERE id=$1',
            [source.id],
          ],
          [
            'UPDATE whaleu_community.social_sources SET actor_account_id=$2 WHERE id=$1',
            [source.id, unrelated.accountId],
          ],
          [
            'DELETE FROM whaleu_notifications.social_work WHERE source_id=$1',
            [source.id],
          ],
          [
            "UPDATE whaleu_notifications.social_work SET state='pending' WHERE source_id=$1",
            [source.id],
          ],
          [
            'DELETE FROM whaleu_notifications.social_receipts WHERE source_id=$1',
            [source.id],
          ],
          [
            "UPDATE whaleu_notifications.social_receipts SET outcome='existing' WHERE source_id=$1",
            [source.id],
          ],
          [
            'DELETE FROM whaleu_notifications.social_notices WHERE id=$1',
            [settled.notice_id],
          ],
          [
            'UPDATE whaleu_notifications.social_notices SET recipient_account_id=$2 WHERE id=$1',
            [settled.notice_id, unrelated.accountId],
          ],
          [
            'DELETE FROM whaleu_community.follow_requests WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, commandId],
          ],
        ] as const)
          await assert.rejects(f.pool.query(sql, [...values]), constraint);
        // Each attempt is its own rolled-back transaction. TRUNCATE is not a
        // row-trigger bypass even if it includes the complete FK closure.
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            await tx.query(
              'TRUNCATE whaleu_community.social_sources,whaleu_notifications.social_work,whaleu_notifications.social_notices,whaleu_notifications.social_receipts',
            );
          }),
          constraint,
        );
        assert.deepEqual(await graph(f, [source.id]), original);

        const command = deletionRequest();
        await f.service.request(f.assertion(actor), command);
        await assert.rejects(
          f.pool.query(
            "INSERT INTO whaleu_account_deletion.owner_causes(request_id,owner,generation) VALUES($1,'follow-social',1)",
            [command.requestId],
          ),
          constraint,
          'Cooling is not an erasure cause',
        );
        await f.advance(COOLING_MS);
        await f.worker.tick(command.requestId); // Real coordinator enters erasing.
        const snapshot = await graph(f, [source.id]);
        for (const [owner, generation] of [
          ['follow-social', '2'],
          ['not-an-owner', '1'],
        ] as const) {
          await assert.rejects(
            f.pool.query(
              'INSERT INTO whaleu_account_deletion.owner_causes(request_id,owner,generation) VALUES($1,$2,$3)',
              [command.requestId, owner, generation],
            ),
            constraint,
          );
        }
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            const row = await f.repository.request(tx, command.requestId);
            await f.repository.cause(tx, row, 'profile');
            await tx.query(
              'DELETE FROM whaleu_community.follow_requests WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, commandId],
            );
          }),
          constraint,
          'A genuine cause for a different owner grants no social mutation',
        );
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            const row = await f.repository.request(tx, command.requestId);
            await tx.query(
              "INSERT INTO whaleu_account_deletion.owner_causes(request_id,owner,generation) VALUES($1,'follow-social',$2)",
              [row.id, row.generation],
            );
            await tx.query(
              "INSERT INTO whaleu_account_deletion.owner_receipts(request_id,owner,generation,inventory,proof) VALUES($1,'follow-social',$2,'account-deletion-local-0172-v1',repeat('a',64))",
              [row.id, row.generation],
            );
          }),
          constraint,
          'An older inventory may not acquire successor authority',
        );
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            const row = await f.repository.request(tx, command.requestId);
            await tx.query(
              "INSERT INTO whaleu_account_deletion.owner_causes(request_id,owner,generation,mutation_transaction) VALUES($1,'follow-social',$2,1::text::xid8)",
              [row.id, row.generation],
            );
          }),
          constraint,
          'A stale transaction identifier is not current authority',
        );
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            const row = await f.repository.request(tx, command.requestId);
            await tx.query(
              "INSERT INTO whaleu_account_deletion.owner_causes(request_id,owner,generation) VALUES($1,'follow-social',$2)",
              [row.id, row.generation],
            );
            await tx.query(
              'DELETE FROM whaleu_community.follow_requests WHERE account_id=$1',
              [peer.accountId],
            );
          }),
          constraint,
          'Deleting A cannot erase B historical commands',
        );
        assert.deepEqual(await graph(f, [source.id]), snapshot);
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_account_deletion.owner_receipts WHERE request_id=$1 AND owner='follow-social'",
              [command.requestId],
            )
          ).rowCount,
          0,
        );
        await f.complete(command.requestId);
        await closed(f, actor, command.requestId);
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_notifications.social_notices SET read_at=NULL WHERE id=$1',
            [settled.notice_id],
          ),
          constraint,
        );
        const once = await f.socialReads.markRead(
          peer.accessToken,
          settled.notice_id,
          'followers',
        );
        await assert.rejects(
          f.pool.query(
            "UPDATE whaleu_notifications.social_notices SET read_at=read_at+interval '1 microsecond' WHERE id=$1",
            [settled.notice_id],
          ),
          constraint,
        );
        assert.equal(
          (
            await f.socialReads.markRead(
              peer.accessToken,
              settled.notice_id,
              'followers',
            )
          ).readAt,
          once.readAt,
        );
        await closed(f, actor, command.requestId);

        const cancelled = deletionRequest();
        await f.service.request(f.assertion(unrelated), cancelled);
        const grant = await f.service.reauthenticate(
          f.assertion(unrelated),
          cancelled.requestId,
        );
        await f.service.cancel(grant.token, {
          version: 1,
          commandId: randomUUID(),
          requestId: cancelled.requestId,
          expectedRevision: '1',
          action: 'explicitly_cancel_account_deletion',
        });
        await assert.rejects(
          f.pool.query(
            "INSERT INTO whaleu_account_deletion.owner_causes(request_id,owner,generation) VALUES($1,'follow-social',1)",
            [cancelled.requestId],
          ),
          constraint,
          'Cancelled request cannot authorize an active account mutation',
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_identity.accounts WHERE id=$1 AND lifecycle='active'",
              [unrelated.accountId],
            )
          ).rowCount,
          1,
        );
        const current = deletionRequest('1');
        await f.service.request(f.assertion(unrelated), current);
        await f.advance(COOLING_MS);
        await f.worker.tick(current.requestId);
        const beforeCurrent = (
          await f.pool.query(
            'SELECT * FROM whaleu_account_deletion.follow_scopes WHERE request_id=$1',
            [current.requestId],
          )
        ).rows;
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            await f.repository.lockAccount(tx, unrelated.accountId);
            const row = await f.repository.request(tx, current.requestId);
            await f.repository.cause(tx, row, 'follow-social');
            await tx.query(
              'SELECT whaleu_account_deletion.follow_social_page($1)',
              [cancelled.requestId],
            );
          }),
          /Exact synthetic follow cause required/,
          'A current generation cause cannot authorize an older canceled request',
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_account_deletion.follow_scopes WHERE request_id=$1',
              [cancelled.requestId],
            )
          ).rowCount,
          0,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_account_deletion.follow_scopes WHERE request_id=$1',
              [current.requestId],
            )
          ).rows,
          beforeCurrent,
        );
        await f.complete(current.requestId);
        await closed(f, unrelated, current.requestId);
      },
    );
  },
);

test(
  '0173 rejects a real follow graph with a non-admitted peer before irreversible mutation',
  { timeout: 300000 },
  async (t) => {
    const f = await accountDeletionFollowSocialFixture();
    t.after(() => f.close());
    const actor = await f.create(),
      external = await f.createPeer();
    const target = await f.profile(external);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_account_deletion.fixture_accounts WHERE account_id=$1',
          [external.accountId],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await f.following.set(actor.accessToken, target, true, randomUUID()))
        .outcome,
      'applied',
    );
    const ids = (await f.sources(actor, external)).map((s) => s.id);
    assert.equal(ids.length, 1);
    const before = await graph(f, ids);
    const eligibility = await f.service.eligibility(f.assertion(actor));
    assert.equal(eligibility.status, 'blocked');
    assert.ok(eligibility.blockers.length > 0);
    await assert.rejects(
      f.service.request(f.assertion(actor), deletionRequest()),
      /OWNER_COVERAGE_UNAVAILABLE/,
    );
    assert.deepEqual(await graph(f, ids), before);
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM whaleu_identity.accounts WHERE id=$1 AND lifecycle='active'",
          [actor.accountId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_account_deletion.requests WHERE account_id=$1',
          [actor.accountId],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_account_deletion.owner_receipts',
        )
      ).rowCount,
      0,
    );
  },
);

for (const kind of ['like', 'save'] as const) {
  test(
    `0173 keeps genuine ${kind}/content/reward lineage outside the follow-only owner`,
    { timeout: 300000 },
    async (t) => {
      const f = await accountDeletionFollowSocialFixture({
        publication: 'c27_0174',
      });
      t.after(() => f.close());
      const actor = await f.create(),
        owner = await f.create();
      const scope = await seedCommunityScope(f.pool);
      await seedReviewPolicy(f.pool);
      for (const account of [actor, owner]) {
        const facts = await setRuntimeVerification(
          f.pool,
          account.accountId,
          scope.institutionId,
          scope.home.regionId,
        );
        await appendIdentitySelection(
          f.pool,
          account.accountId,
          facts,
          scope,
          scope.home.campusId,
        );
      }
      const body: PublishPost = {
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text: `Unsupported ${kind} deletion fixture ${randomUUID()}`,
        authorMode: 'named',
        commentsPolicy: 'open',
        imageAssetIds: [],
      };
      await approveEnvelope(
        f.pool,
        await postApprovalEnvelope(f.app, f.pool, owner.accountId, body),
      );
      const post = await request(f.http)
        .post('/v1/community/posts')
        .set('Authorization', auth(owner))
        .send(body);
      assert.equal(post.status, 201, JSON.stringify(post.body));
      assert.equal(post.body.outcome, 'created');
      // New 0174 qualification: the genuine publication used the exact injected
      // predecessor reader, not a current-runtime missing-table fallback.
      // Read the actual token as unknown, then prove the replacement class.
      // The current and predecessor classes have distinct private members.
      const definitions: unknown = f.app.get(ContentDefinitionRepository);
      assert.ok(definitions instanceof HistoricalContentDefinitionRepository);
      const postScope = (
        await f.pool.query<{ scope: ContentScopeSnapshot }>(
          "SELECT scope FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=$1",
          [post.body.resourceId],
        )
      ).rows[0]!.scope;
      const database = f.app.get(DatabaseService);
      assert.equal(
        (
          await database.transaction((tx) =>
            definitions.current('post', post.body.resourceId, postScope, tx),
          )
        ).kind,
        'allow',
      );
      await assert.rejects(
        database.transaction((tx) =>
          new ContentDefinitionRepository(f.app.get(CampusService)).current(
            'post',
            post.body.resourceId,
            postScope,
            tx,
          ),
        ),
        { code: '42P01' },
        'Unmodified current reader rejects the deliberately absent 0175 source schema',
      );
      assert.equal(f.app.get(ContentDefinitionRepository), definitions);
      const reading = f.app.get(ReadingFormattingRuntime);
      assert.ok(reading instanceof HistoricalReadingFormattingRuntime);
      // Independent rollback-only probe: the unchanged current enrollment
      // query must reject missing storage, not silently accept a legacy post.
      await assert.rejects(
        database.transaction((tx) =>
          new ReadingFormattingRuntime(
            database,
            f.app.get(ReadingSourceOwner),
          ).enrollCreated(
            'post',
            post.body.resourceId,
            body.clientRequestId,
            tx,
          ),
        ),
        { code: '42P01' },
        'Unmodified current enrollment rejects the deliberately absent source schema',
      );
      assert.equal(f.app.get(ReadingFormattingRuntime), reading);
      const mutation = await request(f.http)
        .put(`/v1/community/posts/${post.body.resourceId}/${kind}`)
        .set('Authorization', auth(actor))
        .send(
          kind === 'like'
            ? { requestId: randomUUID(), liked: true }
            : { clientRequestId: randomUUID() },
        );
      assert.equal(mutation.status, 200, JSON.stringify(mutation.body));
      assert.equal(mutation.body.outcome, 'applied');
      const source = (
        await f.pool.query<{
          id: string;
          kind: string;
          reward_group_id: string | null;
        }>(
          'SELECT id,kind,reward_group_id FROM whaleu_community.social_sources WHERE actor_account_id=$1 AND recipient_account_id=$2',
          [actor.accountId, owner.accountId],
        )
      ).rows;
      assert.equal(source.length, 1);
      assert.equal(source[0]!.kind, kind);
      assert.ok(source[0]!.reward_group_id);
      const before = await graph(
        f,
        source.map((s) => s.id),
      );
      const eligibility = await f.service.eligibility(f.assertion(actor));
      assert.equal(eligibility.status, 'blocked');
      assert.ok(eligibility.blockers.length > 0);
      await assert.rejects(
        f.service.request(f.assertion(actor), deletionRequest()),
        /OWNER_COVERAGE_UNAVAILABLE/,
      );
      assert.deepEqual(
        await graph(
          f,
          source.map((s) => s.id),
        ),
        before,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_identity.accounts WHERE id=$1 AND lifecycle='active'",
            [actor.accountId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_account_deletion.requests WHERE account_id=$1',
            [actor.accountId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_account_deletion.owner_receipts',
          )
        ).rowCount,
        0,
      );
    },
  );
}

test(
  '0174 synthetic deletion cooling denies fresh historical publication before journal writes',
  { timeout: 300000 },
  async (t) => {
    const f = await accountDeletionFollowSocialFixture({
      publication: 'c27_0174',
    });
    t.after(() => f.close());
    // Explicitly synthetic local deletion harness, not production enrollment.
    // This actor has no content; its real deletion owner can accept cooling.
    const actor = await f.create();
    assert.equal(
      (await f.service.eligibility(f.assertion(actor))).status,
      'eligible',
    );
    const command = deletionRequest();
    const accepted = await f.service.request(f.assertion(actor), command);
    assert.equal(accepted.status.phase, 'cooling');
    assert.equal(
      (
        await f.pool.query<{ lifecycle: string }>(
          'SELECT lifecycle FROM whaleu_identity.accounts WHERE id=$1',
          [actor.accountId],
        )
      ).rows[0]?.lifecycle,
      'cooling',
    );
    const writes = async () =>
      (
        await f.pool.query<{ posts: number; requests: number }>(
          `SELECT
           (SELECT count(*)::integer FROM whaleu_community.posts WHERE account_id=$1) posts,
           (SELECT count(*)::integer FROM whaleu_community.publication_requests WHERE account_id=$1) requests`,
          [actor.accountId],
        )
      ).rows[0];
    assert.deepEqual(await writes(), { posts: 0, requests: 0 });
    // Valid command shape. Current session authority must reject before looking
    // up even the space, approval, existing receipt or publication intent.
    const body: PublishPost = {
      clientRequestId: randomUUID(),
      spaceId: randomUUID(),
      category: 'discussion',
      text: 'Synthetic cooling actor must not publish',
      authorMode: 'named',
      commentsPolicy: 'open',
      imageAssetIds: [],
    };
    const denied = await request(f.http)
      .post('/v1/community/posts')
      .set('Authorization', auth(actor))
      .send(body);
    assert.equal(denied.status, 401, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'SESSION_REVOKED');
    assert.deepEqual(await writes(), { posts: 0, requests: 0 });
  },
);

test(
  '0173 rejects null, overflow and impossible-date social cursor coordinates',
  { timeout: 300000 },
  async (t) => {
    const f = await accountDeletionFollowSocialFixture();
    t.after(() => f.close());
    const actor = await f.create(),
      cursors = new DiscoveryCursorRepository();
    for (const position of [
      {
        v: 2,
        kind: 'social-updates',
        head: null,
        beforeOrdinal: null,
        beforeAt: null,
      },
      {
        v: 2,
        kind: 'social-updates',
        head: '9999999999999999999',
        beforeOrdinal: '1',
        beforeAt: '2026-10-21T00:00:00.000000Z',
      },
      {
        v: 2,
        kind: 'social-updates',
        head: '1',
        beforeOrdinal: '9999999999999999999',
        beforeAt: '2026-10-21T00:00:00.000000Z',
      },
      {
        v: 2,
        kind: 'social-updates',
        head: '1',
        beforeOrdinal: '1',
        beforeAt: '2026-99-99T99:99:99.000000Z',
      },
      {
        v: 2,
        kind: 'social-updates',
        head: '1',
        beforeOrdinal: '1',
        beforeAt: '2026-02-30T00:00:00.000000Z',
      },
    ]) {
      const token = await f.repository.transaction((tx) =>
        cursors.create(
          discoveryScopeHash(['malformed-fixture', randomUUID()]),
          discoveryCursorBucket(actor.accountId),
          position,
          tx,
        ),
      );
      const eligibility = await f.service.eligibility(f.assertion(actor));
      assert.equal(eligibility.status, 'blocked');
      assert.ok(
        eligibility.blockers.includes('UNSUPPORTED_FOLLOW_SOCIAL_PARTITION'),
      );
      await assert.rejects(
        f.service.request(f.assertion(actor), deletionRequest()),
        /OWNER_COVERAGE_UNAVAILABLE/,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_account_deletion.requests WHERE account_id=$1',
            [actor.accountId],
          )
        ).rowCount,
        0,
      );
      await f.pool.query(
        'DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1',
        [token],
      );
      assert.equal(
        (await f.service.eligibility(f.assertion(actor))).status,
        'eligible',
        'Each malformed case must independently block, without previous residue',
      );
    }
  },
);
