import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { CommunityDistributionService } from '../../src/community/related-sync/service.js';
import { categorySchema } from '../../src/community/contracts.js';
import { reclassificationCategorySchema } from '../../src/community/category-reclassification/contracts.js';
import { CURRENT_CATEGORY_POSTS_SQL } from '../../src/community/current-category-sql.js';
import { readPostCategorySnapshot } from '../../src/community/category-reclassification/read-proof.js';
import { HotRepository } from '../../src/community/hot/repository.js';
import { hotQuerySchema } from '../../src/community/hot/contracts.js';
import { HotScoreMaterializer } from '../../src/community/hot-score/materializer.js';
import { SearchRepository } from '../../src/community/search/repository.js';
import {
  categoryIntentHash,
  categoryPolicyDigest,
  categoryReviewDigest,
} from '../../src/community/category-reclassification/evidence.js';
import type {
  ReclassificationCommand,
  ReclassificationReceipt,
} from '../../src/community/category-reclassification/contracts.js';
import { postPinFixture } from '../support/post-pin-fixture.js';
import {
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  observeExactQueries,
  type ExactQueryObservation,
} from '../support/exact-discovery-counts.js';
import {
  approveEnvelope,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import {
  createRuntimeActor,
  discussionApprovalEnvelope,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';

const causal = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['23514', '23503', '23505', '22P02'].includes(String(error.code));

/** All accepted policy/issuer/Review facts below exist only in disposable PG. */
test(
  'category SQL exact causality, durable authority, source revocation and raw writers',
  { timeout: 240000 },
  async (t) => {
    const f = await postPinFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      admin = await f.actor();
    const grant = await f.grant(
      admin.accountId,
      'school_admin',
      f.scope.home.regionId,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_community.post_category_issuers',
        )
      ).rowCount,
      0,
    );
    const definition = {
      version: 1,
      authorMode: 'named',
      content: 'text_only',
      component: 'none',
      distribution: 'regional',
      sync: 'none',
      anonymousDm: false,
      origin: 'native',
      crosswalk: { pets: 10, scenery: 12 },
      transitions: [
        { from: 'pets', to: 'scenery' },
        { from: 'scenery', to: 'pets' },
      ],
      continueDescendants: true,
      futureChildren: 'original_envelope_plus_reviewed_current_parent',
      descendantMedia: 'text_only',
    };
    type Actor = typeof admin;
    const seedPolicy = async (
      region = f.scope.home.regionId,
      patch: Record<string, unknown> = {},
    ) => {
      const issuerId = randomUUID(),
        policyId = randomUUID(),
        sourceKey = `synthetic:sql-category:${randomUUID()}`;
      const value = { ...definition, ...patch };
      await withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          `INSERT INTO whaleu_community.post_category_issuers(id,source_ref,accepted_at,valid_until)
          VALUES($1,'synthetic:sql-category-issuer',clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '1 hour')`,
          [issuerId],
        );
        await tx.query(
          `INSERT INTO whaleu_community.post_category_policies(id,source_key,revision,source_ref,original_region_id,issuer_id,definition,digest,accepted_at,valid_until)
          VALUES($1,$2,1,'synthetic:sql-category-crosswalk',$3,$4,$5,$6,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
          [
            policyId,
            sourceKey,
            region,
            issuerId,
            value,
            categoryPolicyDigest(value),
          ],
        );
        await tx.query(
          'INSERT INTO whaleu_community.post_category_policy_heads(source_key,policy_id) VALUES($1,$2)',
          [sourceKey, policyId],
        );
      });
      return { issuerId, policyId, sourceKey };
    };
    type Policy = Awaited<ReturnType<typeof seedPolicy>>;
    const policy = await seedPolicy();
    const command = (
      postId: string,
      expectedRevision = 0,
      targetCategory: ReclassificationCommand['targetCategory'] = 'scenery',
    ): ReclassificationCommand => ({
      clientRequestId: randomUUID(),
      postId,
      expectedRevision,
      targetCategory,
    });
    const reviewEnvelope = async (
      body: ReclassificationCommand,
      selectedGrant = grant,
      selectedPolicy = policy,
      actor = admin,
    ) =>
      (
        await f.pool.query<{ envelope: Record<string, unknown> }>(
          'SELECT whaleu_community.post_category_command_envelope($1,$2,$3,$4) envelope',
          [actor.accountId, body, selectedGrant, selectedPolicy.policyId],
        )
      ).rows[0]!.envelope;
    const insertReview = async (
      envelope: Record<string, unknown>,
      selectedPolicy = policy,
      options: {
        result?: string;
        acceptedAt?: Date;
        until?: Date;
        issuerId?: string;
      } = {},
    ) => {
      const id = randomUUID();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_community.post_category_reviews
        (id,issuer_id,policy_id,purpose,envelope,digest,result,accepted_at,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            options.issuerId ?? selectedPolicy.issuerId,
            selectedPolicy.policyId,
            envelope['purpose'],
            envelope,
            categoryReviewDigest(envelope),
            options.result ?? 'allow',
            options.acceptedAt ?? new Date(Date.now() - 1000),
            options.until ?? new Date(Date.now() + 3600000),
          ],
        ),
      );
      return id;
    };
    const issue = async (
      body: ReclassificationCommand,
      selectedGrant = grant,
      selectedPolicy = policy,
      actor = admin,
    ) =>
      insertReview(
        await reviewEnvelope(body, selectedGrant, selectedPolicy, actor),
        selectedPolicy,
      );
    const writeCommand = async (
      tx: PoolClient,
      body: ReclassificationCommand,
      receipt: ReclassificationReceipt,
      actor = admin,
      selectedGrant: string | null = grant,
    ) => {
      await tx.query(
        `INSERT INTO whaleu_community.post_category_commands
        (actor_id,request_id,post_id,session_id,grant_id,intent_hash,command,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          actor.accountId,
          body.clientRequestId,
          body.postId,
          actor.sessionId,
          selectedGrant,
          categoryIntentHash(actor.accountId, body),
          body,
          receipt,
        ],
      );
    };
    const resultBase = (body: ReclassificationCommand) => ({
      requestId: body.clientRequestId,
      postId: body.postId,
      expectedRevision: body.expectedRevision,
      targetCategory: body.targetCategory,
    });
    const mutate = async (
      tx: PoolClient,
      body: ReclassificationCommand,
      reviewId: string,
      options: {
        actor?: Actor;
        grant?: string;
        policy?: Policy;
        omitHead?: boolean;
        zeroCas?: boolean;
        snapshot?: object;
        cutoff?: string;
        recordedAt?: string;
        after?: (tx: PoolClient, eventId: string) => Promise<unknown>;
      } = {},
    ) => {
      const actor = options.actor ?? admin,
        selectedGrant = options.grant ?? grant,
        selectedPolicy = options.policy ?? policy;
      const receipt = {
        ...resultBase(body),
        outcome: 'applied' as const,
        revision: body.expectedRevision + 1,
        eventId: randomUUID(),
        recordedAt: options.recordedAt ?? new Date().toISOString(),
      };
      await writeCommand(tx, body, receipt, actor, selectedGrant);
      await tx.query(
        `INSERT INTO whaleu_community.post_category_events
        (id,post_id,revision,previous_event_id,original_category,previous_category,current_category,original_decision_id,original_digest,
         policy_id,review_id,grant_id,actor_id,request_id,recorded_at,selected_authority,continuation_cutoff)
        SELECT $1,p.id,$3,h.event_id,p.category,coalesce(h.current_category,p.category),$4,b.decision_id,b.digest,$5,$6,$7,$8,$9,$10,$11,coalesce($12::timestamptz,clock_timestamp())
        FROM whaleu_community.posts p JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id
        LEFT JOIN whaleu_community.post_category_heads h ON h.post_id=p.id WHERE p.id=$2`,
        [
          receipt.eventId,
          body.postId,
          receipt.revision,
          body.targetCategory,
          selectedPolicy.policyId,
          reviewId,
          selectedGrant,
          actor.accountId,
          body.clientRequestId,
          receipt.recordedAt,
          options.snapshot ?? null,
          options.cutoff ?? null,
        ],
      );
      if (!options.omitHead) {
        const written =
          body.expectedRevision === 0
            ? await tx.query(
                `INSERT INTO whaleu_community.post_category_heads(post_id,current_category,revision,event_id)
            SELECT $1,$2,$3,$4 WHERE NOT $5::boolean`,
                [
                  body.postId,
                  body.targetCategory,
                  receipt.revision,
                  receipt.eventId,
                  options.zeroCas ?? false,
                ],
              )
            : await tx.query(
                `UPDATE whaleu_community.post_category_heads SET current_category=$2,revision=$3,event_id=$4,mutation_transaction=pg_current_xact_id()
            WHERE post_id=$1 AND revision=$5 AND event_id=(SELECT previous_event_id FROM whaleu_community.post_category_events WHERE id=$4) AND NOT $6::boolean`,
                [
                  body.postId,
                  body.targetCategory,
                  receipt.revision,
                  receipt.eventId,
                  body.expectedRevision,
                  options.zeroCas ?? false,
                ],
              );
        assert.equal(written.rowCount, options.zeroCas ? 0 : 1);
      }
      await options.after?.(tx, receipt.eventId);
      return receipt;
    };
    const apply = (
      body: ReclassificationCommand,
      reviewId: string,
      options: Parameters<typeof mutate>[3] = {},
    ) => inTransaction(f.pool, (tx) => mutate(tx, body, reviewId, options));
    const live = async (postId: string) =>
      (
        await f.pool.query(
          'SELECT * FROM whaleu_community.post_category_live WHERE post_id=$1',
          [postId],
        )
      ).rows[0];
    const emptyCommand = async (body: ReclassificationCommand, actor = admin) =>
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_community.post_category_commands WHERE actor_id=$1 AND request_id=$2',
            [actor.accountId, body.clientRequestId],
          )
        ).rowCount,
        0,
      );

    await t.test(
      'policy accepts only explicitly supplied strict synthetic crosswalk and exact directed transitions',
      async () => {
        const all = {
          discussion: 2,
          confession: 4,
          companions: 99,
          pets: 10,
          internships: 11,
          scenery: 12,
          dorms: 13,
          research: 14,
          deep_sea: 15,
        };
        for (const [category, legacyId] of Object.entries(all)) {
          const value = {
            ...definition,
            crosswalk: { ...all, [category]: legacyId },
          };
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.post_category_policy_definition_valid($1) allowed',
                [value],
              )
            ).rows[0].allowed,
            true,
          );
        }
        for (const patch of [
          { unknown: true },
          { version: '1' },
          { origin: 'imported' },
          { crosswalk: { pets: 11, scenery: 12 } },
          { crosswalk: { pets: 10, scenery: 12, trading: 5 } },
          { transitions: [{ from: 'pets', to: 'scenery', extra: true }] },
          { transitions: [{ from: 'pets', to: 'pets' }] },
          { transitions: [{ from: 'pets', to: 'trading' }] },
          {
            transitions: [definition.transitions[0], definition.transitions[0]],
          },
          { continueDescendants: 'true' },
        ])
          await assert.rejects(
            seedPolicy(f.scope.home.regionId, patch),
            causal,
          );
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_community.post_category_policies
        (id,source_key,revision,source_ref,original_region_id,issuer_id,definition,digest,accepted_at,valid_until)
        SELECT $1,$2,1,p.source_ref,p.original_region_id,p.issuer_id,p.definition,p.digest,i.accepted_at-interval '1 second',p.valid_until
        FROM whaleu_community.post_category_policies p JOIN whaleu_community.post_category_issuers i ON i.id=p.issuer_id WHERE p.id=$3`,
            [randomUUID(), randomUUID(), policy.policyId],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_community.post_category_issuers(id,source_ref,accepted_at,valid_until)
        VALUES($1,'synthetic:unsupported-scheduled-issuer',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 hour')`,
            [randomUUID()],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_community.post_category_policies
        (id,source_key,revision,source_ref,original_region_id,issuer_id,definition,digest,accepted_at,valid_until)
        SELECT $1,$2,1,p.source_ref,p.original_region_id,p.issuer_id,p.definition,p.digest,clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 hour'
        FROM whaleu_community.post_category_policies p WHERE p.id=$3`,
            [randomUUID(), randomUUID(), policy.policyId],
          ),
          causal,
        );
        const foreign = await seedPolicy(f.scope.foreign.regionId);
        await assert.rejects(
          f.pool.query(
            'INSERT INTO whaleu_community.post_category_policy_heads(source_key,policy_id) VALUES($1,$2)',
            [randomUUID(), foreign.policyId],
          ),
          causal,
        );
      },
    );

    await t.test(
      'all nine explicitly synthetic candidate mappings participate in real directed SQL transitions',
      async () => {
        const crosswalk = {
          discussion: 2,
          confession: 4,
          companions: 99,
          pets: 10,
          internships: 11,
          scenery: 12,
          dorms: 13,
          research: 14,
          deep_sea: 15,
        };
        const categories = Object.keys(
          crosswalk,
        ) as ReclassificationCommand['targetCategory'][];
        const transitions = categories.map((from, index) => ({
          from,
          to: categories[(index + 1) % categories.length]!,
        }));
        const selectedPolicy = await seedPolicy(f.scope.home.regionId, {
          crosswalk,
          transitions,
        });
        for (const { from, to } of transitions) {
          const post = await f.publish(owner, f.scope.home.spaceId, from),
            body = command(post.id, 0, to);
          const original = (
            await f.pool.query(
              `SELECT p.category,b.decision_id,b.digest FROM whaleu_community.posts p
          JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id WHERE p.id=$1`,
              [post.id],
            )
          ).rows[0];
          const receipt = await apply(
            body,
            await issue(body, grant, selectedPolicy),
            { policy: selectedPolicy },
          );
          const head = await live(post.id);
          assert.equal(
            head.current_category,
            to,
            `${from} (${crosswalk[from]}) must move to ${to} (${crosswalk[to]}) under the synthetic cycle`,
          );
          assert.equal(head.revision, 1);
          assert.equal(head.event_id, receipt.eventId);
          assert.equal(
            (
              await f.pool.query(
                `SELECT (original_category='trading')=(current_category='trading') preserved
            FROM whaleu_community.post_category_events WHERE id=$1`,
                [receipt.eventId],
              )
            ).rows[0].preserved,
            true,
            'Every accepted candidate transition preserves original/current posts-versus-trading membership',
          );
          assert.deepEqual(
            (
              await f.pool.query(
                `SELECT p.category,b.decision_id,b.digest FROM whaleu_community.posts p
          JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id WHERE p.id=$1`,
                [post.id],
              )
            ).rows[0],
            original,
          );
        }
      },
    );

    await t.test(
      'SQL nine-category boundary preserves posts/trading partitions and rejects raw cross-partition moves',
      async () => {
        // Profile's original-category membership shortcut depends on this exact
        // SQL boundary. A future category expansion must deliberately revisit it.
        const allowed = [
          'discussion',
          'confession',
          'companions',
          'pets',
          'internships',
          'scenery',
          'dorms',
          'research',
          'deep_sea',
        ];
        assert.deepEqual(
          reclassificationCategorySchema.options,
          allowed,
          'Expanding the contract requires an explicit review of the partition shortcut',
        );
        const rejected = [
          ...categorySchema.options.filter(
            (category) => !allowed.includes(category),
          ),
          'future_synthetic_category',
        ];
        const rows = (
          await f.pool.query<{ category: string; allowed: boolean }>(
            'SELECT category,whaleu_community.post_category_candidate(category) allowed FROM unnest($1::text[]) category',
            [[...categorySchema.options, 'future_synthetic_category']],
          )
        ).rows;
        assert.deepEqual(
          rows.filter((row) => row.allowed).map((row) => row.category),
          allowed,
        );
        assert.deepEqual(
          rows.filter((row) => !row.allowed).map((row) => row.category),
          rejected,
        );
        const ordinary = await f.publish(owner, f.scope.home.spaceId, 'pets');
        const trading = await f.publish(owner, f.scope.home.spaceId, 'trading');
        const bodies = [
          command(trading.id, 0, 'pets'),
          {
            ...command(ordinary.id),
            targetCategory: 'trading',
          } as unknown as ReclassificationCommand,
        ];
        for (const body of bodies) {
          await assert.rejects(
            async () => apply(body, await issue(body)),
            causal,
          );
          await emptyCommand(body);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_category_events WHERE post_id=$1',
                [body.postId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=$1',
                [body.postId],
              )
            ).rowCount,
            0,
          );
        }
        assert.equal(
          (
            await f.pool
              .query(`SELECT count(*)::integer n FROM ${CURRENT_CATEGORY_POSTS_SQL} classified
        WHERE (category='trading') IS DISTINCT FROM (current_category='trading')`)
          ).rows[0].n,
          0,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              `SELECT id FROM ${CURRENT_CATEGORY_POSTS_SQL} classified
        WHERE id=ANY($1::uuid[]) AND current_category='trading'`,
              [[ordinary.id, trading.id]],
            )
          ).rows.map((row) => row.id),
          [trading.id],
        );
      },
    );

    await t.test(
      'structural original/head arms are disjoint and a moved-away post never falls back after Review withdrawal',
      async () => {
        const untouched = await f.publish(owner, f.scope.home.spaceId, 'pets');
        const moved = await f.publish(owner, f.scope.home.spaceId, 'pets'),
          body = command(moved.id);
        const review = await issue(body);
        await apply(body, review);
        const ids = [untouched.id, moved.id];
        const structural = async () =>
          (
            await f.pool.query<{
              id: string;
              category: string;
              current_category: string;
            }>(
              `SELECT id,category,current_category FROM ${CURRENT_CATEGORY_POSTS_SQL} classified WHERE id=ANY($1::uuid[]) ORDER BY id`,
              [ids],
            )
          ).rows;
        const before = await structural();
        assert.equal(before.length, 2);
        assert.equal(
          new Set(before.map((row) => row.id)).size,
          2,
          'The original and moved arms cannot duplicate the same post',
        );
        assert.equal(
          before.find((row) => row.id === moved.id)?.category,
          'pets',
        );
        assert.equal(
          before.find((row) => row.id === moved.id)?.current_category,
          'scenery',
        );
        const originalCategory = async () =>
          (
            await f.pool.query<{ id: string }>(
              `SELECT id FROM ${CURRENT_CATEGORY_POSTS_SQL} classified WHERE id=ANY($1::uuid[]) AND current_category='pets'`,
              [ids],
            )
          ).rows.map((row) => row.id);
        assert.deepEqual(await originalCategory(), [untouched.id]);
        await f.pool.query(
          'INSERT INTO whaleu_community.post_category_review_withdrawals(review_id) VALUES($1)',
          [review],
        );
        assert.equal(
          await live(moved.id),
          undefined,
          'The canonical current-classification proof denies the withdrawn exact Review',
        );
        assert.deepEqual(
          await structural(),
          before,
          'Structural metadata retains the one immutable head for later bounded proof',
        );
        assert.deepEqual(
          await originalCategory(),
          [untouched.id],
          'Invalid current proof must never reactivate the original-category arm',
        );
      },
    );

    await t.test(
      'raw command/event/head omissions, zero-row CAS and substituted authority roll back atomically',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
        for (const options of [
          { omitHead: true },
          { zeroCas: true },
          { snapshot: { role: 'super_admin' } },
        ]) {
          const body = command(post.id),
            review = await issue(body);
          await assert.rejects(apply(body, review, options), causal);
          await emptyCommand(body);
        }
        const body = command(post.id);
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            writeCommand(tx, body, {
              ...resultBase(body),
              outcome: 'applied',
              revision: 1,
              eventId: randomUUID(),
              recordedAt: new Date().toISOString(),
            }),
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_community.post_category_heads(post_id,current_category,revision,event_id) VALUES($1,'scenery',1,$2)`,
            [post.id, randomUUID()],
          ),
          causal,
        );
        const extra = { ...body, actorId: owner.accountId };
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            writeCommand(tx, extra, {
              ...resultBase(body),
              outcome: 'rejected',
              code: 'POST_CATEGORY_CANCELLED',
            }),
          ),
          causal,
        );
        const invalid = {
          ...body,
          expectedRevision: '0',
        } as unknown as ReclassificationCommand;
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            writeCommand(tx, invalid, {
              ...resultBase(invalid),
              outcome: 'rejected',
              code: 'POST_CATEGORY_CANCELLED',
            }),
          ),
          causal,
        );
        assert.equal(await live(post.id), undefined);
      },
    );

    await t.test(
      'raw receipt timestamps require native-compatible UTC ISO with zero to three fractional digits',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
        for (const recordedAt of ['today', '2026-01-01T00:00:00.123456Z']) {
          const body = command(post.id, 0, 'pets');
          await assert.rejects(
            inTransaction(f.pool, (tx) =>
              writeCommand(tx, body, {
                ...resultBase(body),
                outcome: 'unchanged',
                revision: 0,
                eventId: null,
                recordedAt,
              }),
            ),
            (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === '23514' &&
              'constraint' in error &&
              error.constraint === 'post_category_causal',
          );
          await emptyCommand(body);
        }
        const seconds = new Date(Date.now() - 1000).toISOString().slice(0, 19);
        for (const fraction of ['', '.1', '.12', '.123']) {
          const body = command(post.id, 0, 'pets'),
            recordedAt = `${seconds}${fraction}Z`;
          await inTransaction(f.pool, (tx) =>
            writeCommand(tx, body, {
              ...resultBase(body),
              outcome: 'unchanged',
              revision: 0,
              eventId: null,
              recordedAt,
            }),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT receipt FROM whaleu_community.post_category_commands WHERE actor_id=$1 AND request_id=$2',
                [admin.accountId, body.clientRequestId],
              )
            ).rows[0].receipt.recordedAt,
            recordedAt,
          );
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.post_category_events WHERE post_id=$1',
              [post.id],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      'selected authority rejects developer, wrong region, expired grant and wrong policy region',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
        const wrong = await f.actor(),
          developer = await f.actor(),
          expired = await f.actor();
        const expiredGrant = randomUUID();
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            `INSERT INTO whaleu_authorization.role_grants
        (id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from,expires_at)
        VALUES($1,$2,'school_admin',$3,$2,'synthetic:expired-category-grant',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 hour')`,
            [expiredGrant, expired.accountId, f.scope.home.regionId],
          ),
        );
        const cases = [
          {
            actor: wrong,
            grant: await f.grant(
              wrong.accountId,
              'school_admin',
              f.scope.foreign.regionId,
            ),
          },
          {
            actor: developer,
            grant: await f.grant(developer.accountId, 'developer'),
          },
          { actor: expired, grant: expiredGrant },
        ];
        for (const item of cases) {
          const body = command(post.id),
            review = await issue(body, item.grant, policy, item.actor);
          await assert.rejects(apply(body, review, item), causal);
          await emptyCommand(body, item.actor);
        }
        const foreign = await seedPolicy(f.scope.foreign.regionId),
          body = command(post.id);
        await assert.rejects(
          apply(body, await issue(body, grant, foreign), { policy: foreign }),
          causal,
        );
      },
    );

    await t.test(
      'ABA and move-back append events; exact no-op and stale same target cannot mint Review or replay publication',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
        const original = async () =>
          (
            await f.pool.query(
              `SELECT to_jsonb(p) post,to_jsonb(b) binding,
        (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM whaleu_community.outbox o WHERE o.resource_id=p.id) outbox
        FROM whaleu_community.posts p JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id WHERE p.id=$1`,
              [post.id],
            )
          ).rows[0];
        const before = await original();
        const first = command(post.id),
          receipt = await apply(first, await issue(first));
        assert.equal((await live(post.id)).current_category, 'scenery');
        const same = command(post.id, 1),
          noOp = {
            ...resultBase(same),
            outcome: 'unchanged' as const,
            revision: 1,
            eventId: receipt.eventId,
            recordedAt: new Date().toISOString(),
          };
        await inTransaction(f.pool, (tx) => writeCommand(tx, same, noOp));
        await assert.rejects(
          issue(command(post.id, 1)),
          causal,
          'A no-op cannot mint a new category approval',
        );
        const stale = command(post.id, 0);
        await inTransaction(f.pool, (tx) =>
          writeCommand(tx, stale, {
            ...resultBase(stale),
            outcome: 'rejected',
            code: 'POST_CATEGORY_STALE',
          }),
        );
        const back = command(post.id, 1, 'pets'),
          second = await apply(back, await issue(back));
        assert.equal(second.revision, 2);
        assert.notEqual(second.eventId, receipt.eventId);
        assert.equal((await live(post.id)).current_category, 'pets');
        await f.pool.query(
          'INSERT INTO whaleu_community.post_category_review_withdrawals(review_id) SELECT review_id FROM whaleu_community.post_category_events WHERE id=$1',
          [receipt.eventId],
        );
        assert.equal(
          (await live(post.id)).current_category,
          'pets',
          'Previous Review is a command-time dependency, not an ongoing dependency of the new head',
        );
        assert.deepEqual(await original(), before);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.post_category_events WHERE post_id=$1',
              [post.id],
            )
          ).rowCount,
          2,
        );
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_community.post_category_events SET current_category=current_category WHERE post_id=$1',
            [post.id],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_community.post_category_heads SET event_id=$2 WHERE post_id=$1',
            [post.id, receipt.eventId],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            'DELETE FROM whaleu_community.post_category_commands WHERE actor_id=$1',
            [admin.accountId],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            'TRUNCATE whaleu_community.post_category_events CASCADE',
          ),
          causal,
        );
      },
    );

    await t.test(
      'fresh stale commands require current selected authority before persisting a terminal receipt',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets'),
          first = command(post.id);
        await apply(first, await issue(first));
        const actor = await f.actor(),
          selected = await f.grant(
            actor.accountId,
            'school_admin',
            f.scope.home.regionId,
          );
        await f.pool.query(
          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$1 WHERE id=$2',
          [actor.accountId, selected],
        );
        for (const authority of [
          { actor: owner, grant: null },
          { actor, grant: selected },
        ]) {
          const stale = command(post.id, 0);
          await assert.rejects(
            inTransaction(f.pool, (tx) =>
              writeCommand(
                tx,
                stale,
                {
                  ...resultBase(stale),
                  outcome: 'rejected',
                  code: 'POST_CATEGORY_STALE',
                },
                authority.actor,
                authority.grant,
              ),
            ),
            causal,
          );
          await emptyCommand(stale, authority.actor);
        }
        const stale = command(post.id, 0),
          receipt = {
            ...resultBase(stale),
            outcome: 'rejected' as const,
            code: 'POST_CATEGORY_STALE' as const,
          };
        await inTransaction(f.pool, (tx) => writeCommand(tx, stale, receipt));
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT receipt FROM whaleu_community.post_category_commands WHERE actor_id=$1 AND request_id=$2',
              [admin.accountId, stale.clientRequestId],
            )
          ).rows[0].receipt,
          receipt,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.post_category_events WHERE post_id=$1',
              [post.id],
            )
          ).rowCount,
          1,
        );
      },
    );

    await t.test(
      'raw deferred commit fences concurrent selected-grant revocation without changing committed authority',
      async () => {
        const actor = await f.actor(),
          selected = await f.grant(
            actor.accountId,
            'school_admin',
            f.scope.home.regionId,
          );
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets'),
          body = command(post.id);
        const review = await issue(body, selected, policy, actor);
        const mutation = await f.pool.connect(),
          revoker = await f.pool.connect();
        try {
          await mutation.query('BEGIN');
          await mutate(mutation, body, review, { actor, grant: selected });
          await revoker.query('BEGIN');
          await revoker.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$1 WHERE id=$2',
            [actor.accountId, selected],
          );
          await assert.rejects(
            mutation.query('COMMIT'),
            (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === '55P03',
            'Raw final proof must fail NOWAIT rather than accept the old committed grant behind its writer',
          );
          await emptyCommand(body, actor);
          assert.equal(await live(post.id), undefined);
        } finally {
          // A failed interleave can idle-timeout either raw transaction. Even
          // then release both checked-out clients so fixture pool.end can finish.
          await Promise.all(
            [mutation, revoker].map(async (client) => {
              let destroy = false;
              try {
                await client.query('ROLLBACK');
              } catch {
                destroy = true;
              } finally {
                client.release(destroy);
              }
            }),
          );
        }
        // Reverse order: the valid raw command acquires its selected grant fence
        // first. Revocation then waits, legitimately serializing after commit.
        const accepted = await f.pool.connect(),
          later = await f.pool.connect();
        let revocation: Promise<unknown> | undefined;
        try {
          await accepted.query('BEGIN');
          const receipt = await mutate(accepted, body, review, {
            actor,
            grant: selected,
          });
          await accepted.query('SET CONSTRAINTS ALL IMMEDIATE');
          await later.query('BEGIN');
          const pid = (
            await later.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          revocation = later.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$1 WHERE id=$2',
            [actor.accountId, selected],
          );
          let blocked = false;
          for (let attempt = 0; attempt < 500; attempt++) {
            blocked = (
              await f.pool.query<{ blocked: boolean }>(
                'SELECT cardinality(pg_blocking_pids($1))>0 blocked',
                [pid],
              )
            ).rows[0]!.blocked;
            if (blocked) break;
            await sleep(10);
          }
          assert.equal(
            blocked,
            true,
            'The second connection must observe the retained selected-grant lock',
          );
          await accepted.query('COMMIT');
          await revocation;
          await later.query('COMMIT');
          assert.equal((await live(post.id)).event_id, receipt.eventId);
          assert.equal((await live(post.id)).current_category, 'scenery');
        } finally {
          await accepted.query('ROLLBACK');
          await revocation?.catch(() => undefined);
          await later.query('ROLLBACK');
          accepted.release();
          later.release();
        }
      },
    );

    await t.test(
      'raw cancellation identity proof fences pending account, session and access-token invalidation',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
        for (const source of ['account', 'session', 'token'] as const) {
          const actor = await f.actor(),
            body = command(post.id);
          const receipt = {
            ...resultBase(body),
            outcome: 'rejected' as const,
            code: 'POST_CATEGORY_CANCELLED' as const,
          };
          const mutation = await f.pool.connect(),
            invalidator = await f.pool.connect();
          try {
            await mutation.query('BEGIN');
            await writeCommand(mutation, body, receipt, actor, null);
            await invalidator.query('BEGIN');
            if (source === 'account')
              await invalidator.query(
                "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
                [actor.accountId],
              );
            else if (source === 'session')
              await invalidator.query(
                "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
                [actor.sessionId],
              );
            else
              await invalidator.query(
                'DELETE FROM whaleu_identity.access_tokens WHERE session_id=$1',
                [actor.sessionId],
              );
            await assert.rejects(
              mutation.query('COMMIT'),
              (error: unknown) =>
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === '55P03',
              `${source}: retained identity row must be fenced NOWAIT before cancellation commits`,
            );
            await emptyCommand(body, actor);
          } finally {
            await mutation.query('ROLLBACK');
            await invalidator.query('ROLLBACK');
            mutation.release();
            invalidator.release();
          }
          await inTransaction(f.pool, (tx) =>
            writeCommand(tx, body, receipt, actor, null),
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT receipt FROM whaleu_community.post_category_commands WHERE actor_id=$1 AND request_id=$2',
                [actor.accountId, body.clientRequestId],
              )
            ).rows[0].receipt,
            receipt,
            'Cancellation still requires no administrative grant',
          );
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.post_category_events WHERE post_id=$1',
              [post.id],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      'latest exact pending/reject/future Review and withdrawal never fall back to an older allow',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
        for (const result of ['pending', 'reject', 'allow']) {
          const body = command(post.id),
            envelope = await reviewEnvelope(body),
            older = await insertReview(envelope);
          const newer = await insertReview(envelope, policy, {
            result,
            acceptedAt: new Date(Date.now() + (result === 'allow' ? 60000 : 0)),
          });
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_category_review_live WHERE id=ANY($1::uuid[])',
                [[older, newer]],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(apply(body, older), causal);
        }
        const body = command(post.id),
          envelope = await reviewEnvelope(body);
        const other = await seedPolicy();
        await assert.rejects(insertReview(envelope, other), causal);
        await assert.rejects(
          insertReview(envelope, policy, { issuerId: other.issuerId }),
          causal,
        );
        await assert.rejects(
          insertReview(envelope, policy, {
            acceptedAt: new Date(Date.now() - 120000),
          }),
          causal,
        );
        await assert.rejects(
          insertReview({ ...envelope, targetCategory: 'pets' }),
          causal,
        );
        const review = await insertReview(envelope);
        await f.pool.query(
          'INSERT INTO whaleu_community.post_category_review_withdrawals(review_id) VALUES($1)',
          [review],
        );
        await assert.rejects(apply(body, review), causal);
      },
    );

    await t.test(
      'accepted event has durable command-time authority; current original and category Review still gate visibility',
      async () => {
        const actor = await f.actor(),
          selected = await f.grant(actor.accountId, 'super_admin');
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets'),
          body = command(post.id);
        const receipt = await apply(
          body,
          await issue(body, selected, policy, actor),
          { actor, grant: selected },
        );
        const snapshot = (
          await f.pool.query(
            'SELECT selected_authority FROM whaleu_community.post_category_events WHERE id=$1',
            [receipt.eventId],
          )
        ).rows[0].selected_authority;
        assert.equal(snapshot.id, selected);
        assert.equal(snapshot.accountId, actor.accountId);
        await f.pool.query(
          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$1 WHERE id=$2',
          [actor.accountId, selected],
        );
        assert.equal((await live(post.id)).current_category, 'scenery');
        const next = command(post.id, 1, 'pets');
        await assert.rejects(
          apply(next, await issue(next, selected, policy, actor), {
            actor,
            grant: selected,
          }),
          causal,
        );
        await setReviewState(f.pool, post.approval.decisionId, 'revoked');
        assert.equal(await live(post.id), undefined);
        await setReviewState(f.pool, post.approval.decisionId, 'allow');
        assert.equal((await live(post.id)).current_category, 'scenery');
        await f.pool.query(
          'INSERT INTO whaleu_community.post_category_review_withdrawals(review_id) SELECT review_id FROM whaleu_community.post_category_events WHERE id=$1',
          [receipt.eventId],
        );
        assert.equal(await live(post.id), undefined);
      },
    );

    await t.test(
      'deferred source and original Review mutation invalidate tentative event/head/receipt',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
        for (const source of [
          'review',
          'policy',
          'issuer',
          'grant',
          'post-hidden',
        ]) {
          const selectedPolicy = await seedPolicy(),
            body = command(post.id),
            review = await issue(body, grant, selectedPolicy);
          await assert.rejects(
            apply(body, review, {
              policy: selectedPolicy,
              after: async (tx) => {
                if (source === 'review')
                  await tx.query(
                    'INSERT INTO whaleu_community.post_category_review_withdrawals(review_id) VALUES($1)',
                    [review],
                  );
                else if (source === 'policy')
                  await tx.query(
                    'INSERT INTO whaleu_community.post_category_policy_withdrawals(policy_id) VALUES($1)',
                    [selectedPolicy.policyId],
                  );
                else if (source === 'issuer')
                  await tx.query(
                    'INSERT INTO whaleu_community.post_category_issuer_withdrawals(issuer_id) VALUES($1)',
                    [selectedPolicy.issuerId],
                  );
                else if (source === 'grant')
                  await tx.query(
                    'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$1 WHERE id=$2',
                    [admin.accountId, grant],
                  );
                else
                  await tx.query(
                    "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                    [post.id],
                  );
              },
            }),
            causal,
          );
          await emptyCommand(body);
        }
        const body = command(post.id),
          envelope = await reviewEnvelope(body);
        const review = await insertReview(envelope, policy, {
          until: new Date(Date.now() + 300),
        });
        await assert.rejects(
          apply(body, review, {
            after: (tx) => tx.query('SELECT pg_sleep(0.4)'),
          }),
          causal,
        );
        await emptyCommand(body);
      },
    );

    await t.test(
      'previous exact Review expiry during a second mutation aborts its deferred commit',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets'),
          first = command(post.id);
        const firstReview = await insertReview(
          await reviewEnvelope(first),
          policy,
          { until: new Date(Date.now() + 1000) },
        );
        const receipt = await apply(first, firstReview);
        const nextPolicy = await seedPolicy(),
          second = command(post.id, 1, 'pets');
        const secondReview = await issue(second, grant, nextPolicy);
        await assert.rejects(
          apply(second, secondReview, {
            policy: nextPolicy,
            after: (tx) => tx.query('SELECT pg_sleep(1.1)'),
          }),
          causal,
        );
        await emptyCommand(second);
        const head = (
          await f.pool.query(
            'SELECT event_id,revision FROM whaleu_community.post_category_heads WHERE post_id=$1',
            [post.id],
          )
        ).rows[0];
        assert.equal(head.event_id, receipt.eventId);
        assert.equal(head.revision, 1);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.post_category_review_live WHERE id=$1',
              [secondReview],
            )
          ).rowCount,
          1,
          'The new approval remains valid; only the exact previous approval crossed its deadline',
        );
      },
    );

    await t.test(
      'two administrators contend on revision zero; only one exact event/head/receipt survives',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets'),
          secondActor = await f.actor();
        const secondGrant = await f.grant(secondActor.accountId, 'super_admin');
        const first = command(post.id),
          second = command(post.id);
        const firstReview = await issue(first),
          secondReview = await issue(second, secondGrant, policy, secondActor);
        const outcomes = await Promise.allSettled([
          apply(first, firstReview),
          apply(second, secondReview, {
            actor: secondActor,
            grant: secondGrant,
          }),
        ]);
        assert.equal(
          outcomes.filter((row) => row.status === 'fulfilled').length,
          1,
        );
        assert.equal(
          outcomes.filter((row) => row.status === 'rejected').length,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.post_category_events WHERE post_id=$1',
              [post.id],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.post_category_commands WHERE post_id=$1',
              [post.id],
            )
          ).rowCount,
          1,
        );
        assert.equal((await live(post.id)).revision, 1);
      },
    );

    await t.test(
      'descendant continuation is explicit and a historical publication request cannot attach new parent context retroactively',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
        const body = {
          clientRequestId: randomUUID(),
          text: 'Synthetic old exact child',
          authorMode: 'named' as const,
          imageAssetIds: [],
        };
        const original = await approveEnvelope(
          f.pool,
          await discussionApprovalEnvelope(
            f.app,
            f.pool,
            owner.accountId,
            post.id,
            body,
          ),
        );
        const published = await request(f.app.getHttpServer())
          .post(`/v1/community/posts/${post.id}/comments`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send(body);
        assert.equal(published.status, 201, JSON.stringify(published.body));
        assert.equal(published.body.outcome, 'created');
        const childId = published.body.resourceId as string;
        const without = await seedPolicy(f.scope.home.regionId, {
          continueDescendants: false,
        });
        const rejected = command(post.id);
        await assert.rejects(
          apply(rejected, await issue(rejected, grant, without), {
            policy: without,
          }),
          causal,
        );
        await emptyCommand(rejected);
        const recordedAt = (
          await f.pool.query<{ instant: string }>(
            `SELECT to_char(date_trunc('milliseconds',bound_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') instant
        FROM whaleu_community.content_approval_bindings WHERE content_kind='comment' AND content_id=$1`,
            [childId],
          )
        ).rows[0]!.instant;
        const move = command(post.id),
          receipt = await apply(move, await issue(move), {
            recordedAt,
            cutoff: '1900-01-01T00:00:00Z',
          });
        const chronology = (
          await f.pool.query(
            `SELECT b.bound_at<e.recorded_at audit_before,b.bound_at<e.continuation_cutoff continuation_before,
        e.continuation_cutoff>'2000-01-01'::timestamptz server_cutoff FROM whaleu_community.post_category_events e
        JOIN whaleu_community.content_approval_bindings b ON b.content_kind='comment' AND b.content_id=$2 WHERE e.id=$1`,
            [receipt.eventId, childId],
          )
        ).rows[0];
        assert.equal(
          chronology.audit_before,
          false,
          'Rounded/backdated receipt is not continuation authority',
        );
        assert.equal(
          chronology.continuation_before,
          true,
          'Server cutoff preserves same-millisecond old child',
        );
        assert.equal(
          chronology.server_cutoff,
          true,
          'Caller cannot inject a continuation cutoff',
        );
        const envelope = (
          await f.pool.query<{ envelope: Record<string, unknown> }>(
            "SELECT whaleu_community.post_category_child_envelope($1,$2,'comment',$3,$4) envelope",
            [
              owner.accountId,
              body.clientRequestId,
              original.decisionId,
              receipt.eventId,
            ],
          )
        ).rows[0]!.envelope;
        const contextReview = await insertReview(envelope);
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_community.post_category_child_bindings
        (content_kind,content_id,post_id,event_id,original_decision_id,original_digest,review_id,actor_id,request_id)
        VALUES('comment',$1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              childId,
              post.id,
              receipt.eventId,
              original.decisionId,
              original.digest,
              contextReview,
              owner.accountId,
              body.clientRequestId,
            ],
          ),
          causal,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.post_category_child_bindings WHERE content_id=$1',
              [childId],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT decision_id FROM whaleu_community.content_approval_bindings WHERE content_id=$1',
              [childId],
            )
          ).rows[0].decision_id,
          original.decisionId,
        );
      },
    );

    await t.test(
      'causally old child with future audit bound_at keeps complete original approval after a move',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
        const body = {
          clientRequestId: randomUUID(),
          text: 'Synthetic causally old child with future audit time',
          authorMode: 'named' as const,
          imageAssetIds: [],
        };
        const approval = await approveEnvelope(
          f.pool,
          await discussionApprovalEnvelope(
            f.app,
            f.pool,
            owner.accountId,
            post.id,
            body,
          ),
        );
        const childId = randomUUID();
        await inTransaction(f.pool, async (tx) => {
          await tx.query(
            `INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode)
          VALUES($1,$2,$3,$4,'named')`,
            [childId, post.id, owner.accountId, body.text],
          );
          await tx.query(
            `INSERT INTO whaleu_community.content_approval_bindings
          (content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope,bound_at)
          SELECT 'comment',$1,1,id,account_id,operation,envelope_version,digest,envelope,envelope->'scope','2100-01-01T00:00:00Z'::timestamptz
          FROM whaleu_community.content_approval_decisions WHERE id=$2`,
            [childId, approval.decisionId],
          );
        });
        const original = (
          await f.pool.query(
            `SELECT decision_id,digest,envelope,bound_at::text FROM whaleu_community.content_approval_bindings
        WHERE content_kind='comment' AND content_id=$1`,
            [childId],
          )
        ).rows[0];
        const read = () =>
          request(f.app.getHttpServer())
            .get(`/v1/community/comments/${childId}`)
            .set('Authorization', `Bearer ${owner.accessToken}`);
        const before = await read();
        assert.equal(before.status, 200, JSON.stringify(before.body));
        assert.equal(
          before.body.id,
          childId,
          'Complete canonical original approval is usable before reclassification',
        );
        const move = command(post.id),
          receipt = await apply(move, await issue(move));
        assert.equal(
          (
            await f.pool.query(
              `SELECT b.bound_at>e.continuation_cutoff future_audit FROM whaleu_community.content_approval_bindings b
        JOIN whaleu_community.post_category_events e ON e.id=$2 WHERE b.content_kind='comment' AND b.content_id=$1`,
              [childId, receipt.eventId],
            )
          ).rows[0].future_audit,
          true,
        );
        assert.equal(
          (
            await f.pool.query(
              `SELECT 1 FROM whaleu_community.post_category_child_bindings WHERE content_kind='comment' AND content_id=$1`,
              [childId],
            )
          ).rowCount,
          0,
        );
        const after = await read();
        assert.equal(after.status, 200, JSON.stringify(after.body));
        assert.equal(
          after.body.id,
          childId,
          'Causal pre-head publication plus explicit continuation preserves the old child',
        );
        assert.deepEqual(
          (
            await f.pool.query(
              `SELECT decision_id,digest,envelope,bound_at::text FROM whaleu_community.content_approval_bindings
        WHERE content_kind='comment' AND content_id=$1`,
              [childId],
            )
          ).rows[0],
          original,
        );
      },
    );

    await t.test(
      'fully bound pre-head children continue after hidden visibility or held Review is restored',
      async () => {
        for (const suspended of ['hidden', 'held'] as const) {
          const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
          const body = {
            clientRequestId: randomUUID(),
            text: `Synthetic fully approved pre-head ${suspended} child`,
            authorMode: 'named' as const,
            imageAssetIds: [],
          };
          const approval = await approveEnvelope(
            f.pool,
            await discussionApprovalEnvelope(
              f.app,
              f.pool,
              owner.accountId,
              post.id,
              body,
            ),
          );
          const published = await request(f.app.getHttpServer())
            .post(`/v1/community/posts/${post.id}/comments`)
            .set('Authorization', `Bearer ${owner.accessToken}`)
            .send(body);
          assert.equal(published.status, 201, JSON.stringify(published.body));
          assert.equal(published.body.outcome, 'created');
          const childId = published.body.resourceId as string;
          const original = (
            await f.pool.query(
              `SELECT decision_id,digest,envelope FROM whaleu_community.content_approval_bindings
          WHERE content_kind='comment' AND content_id=$1`,
              [childId],
            )
          ).rows[0];
          if (suspended === 'hidden')
            await f.pool.query(
              "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=$1",
              [childId],
            );
          else await setReviewState(f.pool, approval.decisionId, 'held');
          const move = command(post.id);
          await apply(move, await issue(move));
          const read = () =>
            request(f.app.getHttpServer())
              .get(`/v1/community/comments/${childId}`)
              .set('Authorization', `Bearer ${owner.accessToken}`);
          assert.equal(
            (await read()).status,
            404,
            'Existing ordinary visibility/Review gates still deny the suspended child',
          );
          if (suspended === 'hidden')
            await f.pool.query(
              "UPDATE whaleu_community.root_comments SET visibility='approved' WHERE id=$1",
              [childId],
            );
          else await setReviewState(f.pool, approval.decisionId, 'allow');
          const restored = await read();
          assert.equal(restored.status, 200, JSON.stringify(restored.body));
          assert.equal(restored.body.id, childId);
          assert.equal(
            (
              await f.pool.query(
                `SELECT 1 FROM whaleu_community.post_category_child_bindings
          WHERE content_kind='comment' AND content_id=$1`,
                [childId],
              )
            ).rowCount,
            0,
          );
          assert.deepEqual(
            (
              await f.pool.query(
                `SELECT decision_id,digest,envelope FROM whaleu_community.content_approval_bindings
          WHERE content_kind='comment' AND content_id=$1`,
                [childId],
              )
            ).rows[0],
            original,
          );
        }
      },
    );

    await t.test(
      'raw post-move children cannot omit their exact original and supplemental publication bindings',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets'),
          body = command(post.id);
        await apply(body, await issue(body));
        const child = randomUUID();
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode)
        VALUES($1,$2,$3,'unbound raw child','named')`,
            [child, post.id, owner.accountId],
          ),
          causal,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.root_comments WHERE id=$1',
              [child],
            )
          ).rowCount,
          0,
        );
        const cancelled = command(post.id, 1, 'pets');
        await inTransaction(f.pool, (tx) =>
          writeCommand(
            tx,
            cancelled,
            {
              ...resultBase(cancelled),
              outcome: 'rejected',
              code: 'POST_CATEGORY_CANCELLED',
            },
            owner,
            null,
          ),
        );
        assert.equal(
          (await live(post.id)).revision,
          1,
          'Cancellation needs no administrative/content grant and changes no category',
        );
      },
    );

    await t.test(
      'two-connection child/move interleaves use parent locks, not transaction time or spoofed bound_at',
      async () => {
        const originalChild = async (postId: string) => {
          const body = {
            clientRequestId: randomUUID(),
            text: `Synthetic child interleave ${randomUUID()}`,
            authorMode: 'named' as const,
            imageAssetIds: [],
          };
          const approval = await approveEnvelope(
            f.pool,
            await discussionApprovalEnvelope(
              f.app,
              f.pool,
              owner.accountId,
              postId,
              body,
            ),
          );
          return { body, approval, id: randomUUID(), postId };
        };
        const insertOriginalChild = async (
          tx: PoolClient,
          child: Awaited<ReturnType<typeof originalChild>>,
        ) => {
          await tx.query(
            `INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,'named')`,
            [child.id, child.postId, owner.accountId, child.body.text],
          );
          // A raw caller deliberately uses old transaction time. It must never
          // turn a post-move child into a pre-move continued child.
          await tx.query(
            `INSERT INTO whaleu_community.content_approval_bindings
          (content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope,bound_at)
          SELECT 'comment',$1,1,id,account_id,operation,envelope_version,digest,envelope,envelope->'scope',transaction_timestamp()
          FROM whaleu_community.content_approval_decisions WHERE id=$2`,
            [child.id, child.approval.decisionId],
          );
        };
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets'),
          child = await originalChild(post.id);
        const late = await f.pool.connect();
        try {
          await late.query('BEGIN');
          await late.query(
            'SELECT pg_current_xact_id(),transaction_timestamp()',
          );
          const move = command(post.id),
            review = await issue(move);
          await apply(move, review);
          await insertOriginalChild(late, child);
          assert.equal(
            (
              await late.query(
                `SELECT b.bound_at<e.continuation_cutoff old_looking FROM whaleu_community.content_approval_bindings b
          JOIN whaleu_community.post_category_events e ON e.post_id=$2 AND e.revision=1 WHERE b.content_kind='comment' AND b.content_id=$1`,
                [child.id, post.id],
              )
            ).rows[0].old_looking,
            true,
          );
          await assert.rejects(
            late.query('COMMIT'),
            (error: unknown) =>
              causal(error) &&
              typeof error === 'object' &&
              error !== null &&
              'constraint' in error &&
              error.constraint === 'post_category_causal',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.root_comments WHERE id=$1',
                [child.id],
              )
            ).rowCount,
            0,
          );
        } finally {
          await late.query('ROLLBACK');
          late.release();
        }

        const beforePost = await f.publish(owner, f.scope.home.spaceId, 'pets'),
          beforeChild = await originalChild(beforePost.id);
        const move = command(beforePost.id),
          review = await issue(move);
        const childTx = await f.pool.connect(),
          moveTx = await f.pool.connect();
        let pending: Promise<ReclassificationReceipt> | undefined;
        try {
          await childTx.query('BEGIN');
          const childPid = (
            await childTx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          await insertOriginalChild(childTx, beforeChild);
          await moveTx.query('BEGIN');
          const movePid = (
            await moveTx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          pending = mutate(moveTx, move, review);
          // Attach a handler immediately so a failed query cannot become an
          // unhandled rejection while observing the explicit database barrier.
          const settled = pending.then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          const deadline = Date.now() + 5000;
          let blocked = false;
          while (Date.now() < deadline) {
            blocked = (
              await f.pool.query<{ blocked: boolean }>(
                'SELECT $1::integer=ANY(pg_blocking_pids($2)) blocked',
                [childPid, movePid],
              )
            ).rows[0]!.blocked;
            if (blocked) break;
            await sleep(10);
          }
          assert.equal(
            blocked,
            true,
            'Move waits behind the exact parent SHARE lock held by the child',
          );
          await childTx.query('COMMIT');
          const result = await settled;
          if ('error' in result) throw result.error;
          await moveTx.query('COMMIT');
          assert.equal(
            (
              await f.pool.query(
                `SELECT b.bound_at<e.continuation_cutoff continued FROM whaleu_community.content_approval_bindings b
          JOIN whaleu_community.post_category_events e ON e.post_id=$2 AND e.revision=1 WHERE b.content_kind='comment' AND b.content_id=$1`,
                [beforeChild.id, beforePost.id],
              )
            ).rows[0].continued,
            true,
          );
          assert.equal((await live(beforePost.id)).revision, 1);
        } finally {
          await childTx.query('ROLLBACK');
          await pending?.catch(() => undefined);
          await moveTx.query('ROLLBACK');
          childTx.release();
          moveTx.release();
        }
      },
    );

    await t.test(
      'raw stronger-isolation and delayed original-binding writers cannot synthesize pre-head continuation',
      async () => {
        const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
        for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
          const tx = await f.pool.connect();
          try {
            await tx.query(`BEGIN ISOLATION LEVEL ${isolation}`);
            await tx.query(
              'SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=$1',
              [post.id],
            );
            await assert.rejects(
              tx.query(
                `INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode)
            VALUES($1,$2,$3,'stale absent head','named')`,
                [randomUUID(), post.id, owner.accountId],
              ),
              causal,
            );
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        }
        const body = {
          clientRequestId: randomUUID(),
          text: 'Delayed first original binding',
          authorMode: 'named' as const,
          imageAssetIds: [],
        };
        const original = await approveEnvelope(
          f.pool,
          await discussionApprovalEnvelope(
            f.app,
            f.pool,
            owner.accountId,
            post.id,
            body,
          ),
        );
        const child = randomUUID();
        await f.pool.query(
          `INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,'named')`,
          [child, post.id, owner.accountId, body.text],
        );
        const move = command(post.id);
        await apply(move, await issue(move));
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_community.content_approval_bindings
        (content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope,bound_at)
        SELECT 'comment',$1,1,id,account_id,operation,envelope_version,digest,envelope,envelope->'scope','1900-01-01'::timestamptz
        FROM whaleu_community.content_approval_decisions WHERE id=$2`,
            [child, original.decisionId],
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_community.root_comments SET approval_publication_transaction=pg_current_xact_id() WHERE id=$1',
            [child],
          ),
          causal,
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_community.content_approval_bindings WHERE content_kind='comment' AND content_id=$1",
              [child],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      'measured scoped candidates preserve results as genuine unrelated moved regions grow',
      async (planTest) => {
        // All fixtures use ordinary native publication, exact Review, and the
        // unchanged per-command SQL guards. Small-table scans are measured, not
        // mistaken for a production-scale regression or forced into an index.
        const planAdmin = await f.actor(),
          planGrant = await f.grant(planAdmin.accountId, 'super_admin');
        const regionalActor = async (location: typeof f.scope.home) => {
          const actor = await createRuntimeActor(f.app);
          const facts = await setRuntimeVerification(
            f.pool,
            actor.accountId,
            f.scope.institutionId,
            location.regionId,
          );
          await appendIdentitySelection(
            f.pool,
            actor.accountId,
            facts,
            f.scope,
            location.campusId,
          );
          return { ...actor, facts };
        };
        const groups = [
          {
            scope: f.scope.home,
            actor: owner,
            initial: 16,
            policy: await seedPolicy(f.scope.home.regionId),
          },
          {
            scope: f.scope.related,
            actor: await regionalActor(f.scope.related),
            initial: 128,
            policy: await seedPolicy(f.scope.related.regionId),
          },
          {
            scope: f.scope.foreign,
            actor: await regionalActor(f.scope.foreign),
            initial: 128,
            policy: await seedPolicy(f.scope.foreign.regionId),
          },
        ];
        const cohort: { id: string; spaceId: string }[] = [];
        const grow = async (group: (typeof groups)[number], count: number) => {
          for (let index = 0; index < count; index++) {
            const post = await f.publish(
                group.actor,
                group.scope.spaceId,
                'pets',
              ),
              body = command(post.id);
            await apply(
              body,
              await issue(body, planGrant, group.policy, planAdmin),
              { actor: planAdmin, grant: planGrant, policy: group.policy },
            );
            assert.ok(
              ['current', 'refreshed'].includes(
                await f.app.get(HotScoreMaterializer).refresh(post.id),
              ),
            );
            cohort.push({ id: post.id, spaceId: group.scope.spaceId });
          }
        };
        for (const group of groups) await grow(group, group.initial);
        const scopedIds = new Set(
          cohort
            .filter((row) => row.spaceId === f.scope.home.spaceId)
            .map((row) => row.id),
        );
        assert.equal(scopedIds.size, 16);
        type PlanNode = {
          'Node Type': string;
          'Relation Name'?: string;
          'Index Name'?: string;
          'Index Cond'?: string;
          Filter?: string;
          'Join Filter'?: string;
          'Actual Rows': number;
          'Actual Loops': number;
          'Rows Removed by Filter'?: number;
          'Rows Removed by Index Recheck'?: number;
          'Shared Hit Blocks'?: number;
          'Shared Read Blocks'?: number;
          Plans?: PlanNode[];
        };
        type PlanDocument = {
          Plan: PlanNode;
          'Planning Time': number;
          'Execution Time': number;
        };
        const flatten = (node: PlanNode): PlanNode[] => [
          node,
          ...(node.Plans ?? []).flatMap(flatten),
        ];
        const measureStage = async (stage: 'small' | 'large') => {
          const distractorIds = new Set(
            cohort
              .filter((row) => row.spaceId !== f.scope.home.spaceId)
              .map((row) => row.id),
          );
          assert.equal(distractorIds.size, stage === 'small' ? 256 : 1024);
          assert.equal(
            (
              await f.pool.query(
                `SELECT min(foreign_head.original_published_at)>max(home_head.original_published_at) later
          FROM whaleu_community.post_category_heads foreign_head CROSS JOIN whaleu_community.post_category_heads home_head
          WHERE foreign_head.post_id=ANY($1::uuid[]) AND home_head.post_id=ANY($2::uuid[])`,
                [[...distractorIds], [...scopedIds]],
              )
            ).rows[0].later,
            true,
            'All distractors are newer than the selected-scope cohort',
          );
          for (const table of [
            'whaleu_community.posts',
            'whaleu_community.post_category_heads',
            'whaleu_community.post_category_events',
            'whaleu_community.post_category_reviews',
            'whaleu_community.post_category_policies',
            'whaleu_community.content_approval_bindings',
            'whaleu_post_hotness.scores',
            'whaleu_post_hotness.subscription_states',
            'whaleu_post_hotness.like_states',
            'whaleu_post_hotness.comment_states',
            'whaleu_post_hotness.view_states',
          ])
            await f.pool.query(`ANALYZE ${table}`);
          const scopedHeads = Number(
            (
              await f.pool.query(
                `SELECT count(*) n FROM whaleu_community.post_category_heads
          WHERE original_space_id=$1`,
                [f.scope.home.spaceId],
              )
            ).rows[0].n,
          );
          const scopedPosts = Number(
            (
              await f.pool.query(
                'SELECT count(*) n FROM whaleu_community.posts WHERE space_id=$1',
                [f.scope.home.spaceId],
              )
            ).rows[0].n,
          );
          // One absence probe per scoped original, then the scoped moved-head
          // pass and either exact-head or separately measured bitmap/heap work.
          const headWorkLimit = scopedPosts + 2 * scopedHeads;
          const planFailures: string[] = [],
            labels: string[] = [];
          const explain = async (
            label: string,
            sql: string,
            values: unknown[],
            options: { scopeIndex?: boolean; noHeads?: boolean } = {},
          ) => {
            const result = await f.pool.query<{ 'QUERY PLAN': PlanDocument[] }>(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
              values,
            );
            const plan = result.rows[0]!['QUERY PLAN'][0]!,
              nodes = flatten(plan.Plan);
            const heads = nodes.filter(
              (node) =>
                node['Relation Name'] === 'post_category_heads' ||
                [
                  'post_category_heads_scope_seek',
                  'post_category_heads_filter',
                  'post_category_heads_pkey',
                ].includes(node['Index Name'] ?? ''),
            );
            const examined = (node: PlanNode) =>
              node['Actual Rows'] +
              (node['Rows Removed by Filter'] ?? 0) +
              (node['Rows Removed by Index Recheck'] ?? 0);
            const headWork = heads.reduce(
              (sum, node) =>
                sum + node['Actual Loops'] * Math.max(1, examined(node)),
              0,
            );
            labels.push(label);
            planTest.diagnostic(
              JSON.stringify({
                stage,
                cohort: {
                  selected: scopedIds.size,
                  irrelevant: distractorIds.size,
                },
                scopedPosts,
                scopedHeads,
                headWorkLimit,
                label,
                planningMs: plan['Planning Time'],
                executionMs: plan['Execution Time'],
                headWork,
                nodes: nodes.map((node) => ({
                  type: node['Node Type'],
                  relation: node['Relation Name'],
                  index: node['Index Name'],
                  indexCond: node['Index Cond'],
                  filter: node.Filter,
                  joinFilter: node['Join Filter'],
                  rows: node['Actual Rows'],
                  loops: node['Actual Loops'],
                  removed: node['Rows Removed by Filter'] ?? 0,
                  rechecks: node['Rows Removed by Index Recheck'] ?? 0,
                  sharedHits: node['Shared Hit Blocks'] ?? 0,
                  sharedReads: node['Shared Read Blocks'] ?? 0,
                })),
              }),
            );
            if (options.noHeads) {
              if (heads.length !== 0)
                planFailures.push(
                  `${label}: category-unfiltered hot structural ordering must not expand category heads`,
                );
            } else {
              if (!heads.some((node) => node['Actual Loops'] > 0))
                planFailures.push(`${label}: expected genuine moved-head work`);
              if (stage === 'large') {
                if (
                  options.scopeIndex &&
                  !heads.some(
                    (node) =>
                      node['Index Name'] === 'post_category_heads_scope_seek' &&
                      node['Actual Loops'] > 0,
                  )
                )
                  planFailures.push(
                    `${label}: larger skew must demonstrate the natural scope/category/seek index`,
                  );
                if (headWork > headWorkLimit)
                  planFailures.push(
                    `${label}: head work ${headWork} exceeds derived scoped allowance ${headWorkLimit}`,
                  );
                if (
                  heads.some(
                    (node) =>
                      node['Actual Loops'] > 0 && examined(node) > scopedHeads,
                  )
                )
                  planFailures.push(
                    `${label}: a head scan examined unrelated-region heads beyond the selected-scope population`,
                  );
              }
            }
            return plan.Plan;
          };
          const firstSql = `SELECT post_id,to_char(original_published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at
          FROM whaleu_community.post_category_heads WHERE current_category=$1 AND original_space_id=$2
          ORDER BY original_published_at DESC,post_id DESC LIMIT 8`;
          const firstValues = ['scenery', f.scope.home.spaceId];
          const first = (
            await f.pool.query<{ post_id: string; at: string }>(
              firstSql,
              firstValues,
            )
          ).rows;
          assert.equal(first.length, 8);
          assert.ok(first.every((row) => scopedIds.has(row.post_id)));
          await explain('scoped-head-first', firstSql, firstValues, {
            scopeIndex: true,
          });
          const last = first.at(-1)!;
          const seekSql = `SELECT post_id FROM whaleu_community.post_category_heads WHERE current_category=$1 AND original_space_id=$2
          AND (original_published_at,post_id)<($3::timestamptz,$4::uuid) ORDER BY original_published_at DESC,post_id DESC LIMIT 8`;
          const seekValues = [...firstValues, last.at, last.post_id];
          const next = (
            await f.pool.query<{ post_id: string }>(seekSql, seekValues)
          ).rows;
          assert.equal(next.length, 8);
          assert.equal(
            new Set([...first, ...next].map((row) => row.post_id)).size,
            16,
          );
          assert.ok(next.every((row) => scopedIds.has(row.post_id)));
          await explain('scoped-head-seek', seekSql, seekValues, {
            scopeIndex: true,
          });

          // Capture ordinary owner SQL and bound values, then explain them
          // unchanged. These are candidate plans, not endpoint-latency claims.
          const observer = observeExactQueries(f.app),
            observed: ExactQueryObservation[] = [];
          observer.setHook(async (event) => {
            if (
              event.sql.includes(CURRENT_CATEGORY_POSTS_SQL) ||
              event.sql.includes('FROM whaleu_post_hotness.scores hs')
            )
              observed.push(event);
          });
          let feedIds: string[], searchIds: string[], hotIds: string[];
          try {
            const feed = await request(f.app.getHttpServer())
              .get('/v1/community/posts')
              .set('Authorization', `Bearer ${owner.accessToken}`)
              .query({
                spaceId: f.scope.home.spaceId,
                category: 'scenery',
                limit: '5',
              });
            assert.equal(feed.status, 200, JSON.stringify(feed.body));
            feedIds = feed.body.items.map((row: { id: string }) => row.id);
            assert.equal(feedIds.length, 5);
            assert.ok(feedIds.every((id) => scopedIds.has(id)));
            const database = f.app.get(DatabaseService),
              repository = f.app.get(CommunityRepository);
            const search = await database.transaction(async (tx) => {
              const space = await repository.space(f.scope.home.spaceId, tx);
              const distribution = await f.app
                .get(CommunityDistributionService)
                .resolveView(space, tx);
              assert.equal(distribution.relatedCampusDistribution, 'complete');
              return f.app.get(SearchRepository).candidates(
                {
                  spaceId: f.scope.home.spaceId,
                  distribution,
                  category: 'scenery',
                  tradingSubtype: null,
                  excludeUrgentTrading: false,
                  types: ['post'],
                  from: null,
                  to: null,
                  postId: null,
                },
                null,
                tx,
              );
            });
            assert.ok(search.length >= scopedIds.size && search.length <= 129);
            assert.ok(
              search.every(
                (row) =>
                  row.spaceId === f.scope.home.spaceId &&
                  !distractorIds.has(row.id),
              ),
            );
            searchIds = search.map((row) => row.id);
            const hot = await database.transaction(async (tx) => {
              const records = f.app.get(HotRepository),
                space = await repository.space(f.scope.home.spaceId, tx);
              const distribution = await f.app
                .get(CommunityDistributionService)
                .resolveView(space, tx);
              assert.equal(distribution.relatedCampusDistribution, 'complete');
              return records.candidates(
                space,
                hotQuerySchema.parse({ spaceId: space.id, range: 'history' }),
                await records.clock(tx),
                null,
                tx,
                distribution,
              );
            });
            assert.equal(hot.length, scopedIds.size);
            assert.ok(hot.every((row) => scopedIds.has(row.id)));
            hotIds = hot.map((row) => row.id);
          } finally {
            observer.restore();
          }
          const captured = [
            {
              label: 'actual-feed-candidates',
              query: observed.find((row) =>
                row.sql.startsWith(
                  'SELECT p.* FROM whaleu_community.posts p JOIN ',
                ),
              ),
              cap: 32,
              noHeads: false,
            },
            {
              label: 'actual-search-candidates',
              query: observed.find((row) =>
                row.sql.startsWith(
                  'SELECT id,kind,"spaceId","postId","rootCommentId",at FROM ',
                ),
              ),
              cap: 129,
              noHeads: false,
            },
            {
              label: 'actual-hot-candidates',
              query: observed.find(
                (row) =>
                  row.sql.startsWith('SELECT p.id,p.space_id AS "spaceId",') &&
                  row.sql.includes('FROM whaleu_post_hotness.scores hs'),
              ),
              cap: 129,
              noHeads: true,
            },
          ];
          for (const { label, query, cap, noHeads } of captured) {
            assert.ok(
              query,
              `${label} must be captured from an actual ordinary owner query`,
            );
            assert.equal(
              query.values[0],
              f.scope.home.spaceId,
              `${label}: actual query binds the single selected home space`,
            );
            const root = await explain(label, query.sql, query.values, {
              noHeads,
            });
            if (!(root['Actual Rows'] > 0 && root['Actual Rows'] <= cap))
              planFailures.push(`${label}: actual candidate output is bounded`);
          }
          // Capture the real bounded live projection without exporting or copying
          // production SQL. The proxy only records and forwards ordinary queries.
          for (const ids of [[...scopedIds].slice(0, 1), [...scopedIds]]) {
            const capturedLive: { sql: string; values: unknown[] }[] = [];
            await inTransaction(f.pool, async (tx) => {
              await tx.query(
                "SET LOCAL statement_timeout='100ms'; SET LOCAL lock_timeout='1ms'",
              );
              const recording = new Proxy(tx, {
                get(target, property, receiver) {
                  if (property !== 'query')
                    return Reflect.get(target, property, receiver);
                  return async (sql: string, values?: unknown[]) => {
                    if (sql.includes('category_read_live'))
                      capturedLive.push({ sql, values: values ?? [] });
                    return target.query(sql, values);
                  };
                },
              });
              const snapshot = await readPostCategorySnapshot(ids, recording);
              assert.equal(snapshot.categories.size, ids.length);
              for (const id of ids)
                assert.equal(snapshot.categories.get(id), 'scenery');
            });
            assert.equal(capturedLive.length, 1);
            const selected = capturedLive[0]!;
            assert.equal(selected.values.length, 1);
            assert.ok(Array.isArray(selected.values[0]));
            assert.deepEqual([...selected.values[0]].sort(), [...ids].sort());
            for (const pass of ['first-explain', 'repeat-explain']) {
              const result = await inTransaction(f.pool, async (tx) => {
                await tx.query(
                  "SET LOCAL statement_timeout='100ms'; SET LOCAL lock_timeout='1ms'",
                );
                return tx.query<{ 'QUERY PLAN': PlanDocument[] }>(
                  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${selected.sql}`,
                  selected.values,
                );
              });
              const document = result.rows[0]!['QUERY PLAN'][0]!;
              planTest.diagnostic(
                JSON.stringify({
                  stage,
                  label: 'actual-category-live-projection',
                  pass,
                  requested: ids.length,
                  statementTimeoutMs: 100,
                  planningMs: document['Planning Time'],
                  executionMs: document['Execution Time'],
                  nodes: flatten(document.Plan).map((node) => ({
                    type: node['Node Type'],
                    relation: node['Relation Name'],
                    index: node['Index Name'],
                    indexCond: node['Index Cond'],
                    filter: node.Filter,
                    joinFilter: node['Join Filter'],
                    rows: node['Actual Rows'],
                    loops: node['Actual Loops'],
                    removed: node['Rows Removed by Filter'] ?? 0,
                    sharedHits: node['Shared Hit Blocks'] ?? 0,
                    sharedReads: node['Shared Read Blocks'] ?? 0,
                  })),
                }),
              );
              assert.equal(document.Plan['Actual Rows'], ids.length);
            }
          }
          assert.equal(labels.length, 5);
          assert.deepEqual(
            planFailures,
            [],
            `${stage}: measured plans must satisfy this stage's correctness and derived-work requirements`,
          );
          return {
            first: first.map((row) => row.post_id),
            next: next.map((row) => row.post_id),
            feedIds,
            searchIds,
            hotIds,
          };
        };
        const small = await measureStage('small');
        // Only unrelated regions grow. The native/SQL path is intentionally kept
        // per publication and per move, preserving established lock/xid causality.
        for (const group of groups.slice(1)) await grow(group, 384);
        const large = await measureStage('large');
        assert.deepEqual(
          large,
          small,
          'Fourfold unrelated-region growth must preserve exact scoped first/seek/feed/search/hot results',
        );
      },
    );

    await t.test(
      'cursor epoch is source-owned and all new sources advance canonical Community and cursor versions',
      async () => {
        const tables = [
          'post_category_issuers',
          'post_category_issuer_withdrawals',
          'post_category_policies',
          'post_category_policy_heads',
          'post_category_policy_withdrawals',
          'post_category_reviews',
          'post_category_review_withdrawals',
          'post_category_heads',
          'post_category_events',
          'post_category_child_bindings',
        ];
        for (const table of tables) {
          const epoch = async () =>
            (
              await f.pool.query(
                `SELECT version::text cursor,(SELECT sum(epoch)::text FROM whaleu_community.discovery_count_epochs) community FROM whaleu_community.post_category_read_epoch`,
              )
            ).rows[0];
          const before = await epoch();
          await f.pool.query(
            `INSERT INTO whaleu_community.${table} SELECT * FROM whaleu_community.${table} WHERE false`,
          );
          const after = await epoch();
          assert.equal(
            BigInt(after.cursor),
            BigInt(before.cursor) +
              ([
                'post_category_reviews',
                'post_category_child_bindings',
              ].includes(table)
                ? 0n
                : 1n),
            table,
          );
          assert.equal(
            BigInt(after.community),
            BigInt(before.community) + 1n,
            table,
          );
        }
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_community.post_category_read_epoch SET version=version+1',
          ),
          causal,
        );
        await assert.rejects(
          f.pool.query('DELETE FROM whaleu_community.post_category_read_epoch'),
          causal,
        );
        await assert.rejects(
          f.pool.query('TRUNCATE whaleu_community.post_category_read_epoch'),
          causal,
        );
      },
    );
  },
);
