import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { seedExactContent } from '../support/exact-discovery-counts.js';
import { test } from 'node:test';
import { searchHarness } from '../integration/search-fixtures.js';
import { setReviewState } from '../support/community-approval-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import {
  SEARCH_APPROVAL_EXACT_TIME_PREDICATE,
  ContentReviewSearchEligibilityFacade,
  requireSearchContentEligibilityRelation,
} from '../../src/community/content-review/search-eligibility.facade.js';
import type {
  SearchContentCertificate,
  SearchContentEligibilityRelation,
} from '../../src/community/content-review/search-eligibility.facade.js';
import { LocalApprovedContentVisibility } from '../../src/community/content-review/local-approved-content-visibility.js';
import { CampusContentScopeFacade } from '../../src/campus/content-scope.facade.js';
import { createQwenSemanticProfile } from '../../src/community/search/semantic/profile.js';
import { SemanticIndexRepository } from '../../src/community/search/semantic/repository.js';
import { semanticBodyDigest } from '../../src/community/search/semantic/provider.js';
import { semanticFingerprint } from '../../src/community/search/semantic/contracts.js';
import type { SemanticAuthorizedSource } from '../../src/community/search/semantic/contracts.js';
import type {
  SearchCandidate,
  SearchStructuralScope,
} from '../../src/community/search/repository.js';
import type { PoolClient } from 'pg';

const profile = createQwenSemanticProfile({
  providerId: 'offline-fixture',
  deploymentId: 'certificate-fixture',
  deploymentRevision: 'fixture-v1',
  embeddingModelRevision: 'fixture-v1',
  rerankerModelRevision: 'fixture-v1',
});

test(
  'canonical no-body certificates cover an entire structural scope and reject stale workers',
  { timeout: 180000 },
  async (t) => {
    const h = await searchHarness();
    let installed = false;
    try {
      await inTransaction(h.pool, async (tx) =>
        tx.query(
          await readFile(
            new URL(
              '../../optional-migrations/semantic-search/0001_pgvector_exact.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      );
      installed = true;
      const facade = new ContentReviewSearchEligibilityFacade(
        h.app.get(LocalApprovedContentVisibility),
        h.app.get(CampusContentScopeFacade),
      );
      const index = new SemanticIndexRepository();
      const w = await h.world();
      await w.seed(129);
      const scope: SearchStructuralScope = {
        spaceId: w.scope.home.spaceId,
        types: ['post'],
        from: null,
        to: null,
        postId: null,
        category: null,
        tradingSubtype: null,
        excludeUrgentTrading: false,
      };
      const read = <T>(operation: (tx: PoolClient) => Promise<T>) =>
        inTransaction(
          h.pool,
          async (tx) => {
            await lockSafetyPolicy(tx);
            return operation(tx);
          },
          { isolationLevel: 'read committed' },
        );
      const collect = () =>
        read(async (tx) => {
          const relation = await facade.prepare(scope, profile, tx);
          requireSearchContentEligibilityRelation(relation, tx);
          const facts = (
            await tx.query<{ id: string; decision: string }>(
              `SELECT id,decision FROM ${relation.tableName} ORDER BY id`,
            )
          ).rows;
          const nodes = (
            await tx.query<{ base_decision: string }>(
              `SELECT base_decision FROM ${relation.nodesTableName}`,
            )
          ).rows;
          return { facts, nodes };
        });
      let firstSource: SemanticAuthorizedSource | undefined,
        firstCertificate: SearchContentCertificate | undefined;
      await t.test(
        '129 potentially visible sources are unknown, not truncated or denied',
        async () => {
          const result = await collect();
          assert.equal(result.facts.length, 129);
          assert.ok(result.facts.every((row) => row.decision === 'unknown'));
        },
      );
      await t.test(
        'exact canonical reconstruction issues certificates; full metadata query reads all 129',
        async () => {
          await read(async (tx) => {
            const rows = (
              await tx.query<SearchCandidate & { text: string }>(
                `SELECT id,'post'::text kind,space_id AS "spaceId",id AS "postId",
          NULL::uuid AS "rootCommentId",to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,text
          FROM whaleu_community.posts WHERE space_id=$1 ORDER BY id FOR SHARE`,
                [scope.spaceId],
              )
            ).rows;
            for (const row of rows) {
              const { text, ...candidate } = row;
              const revision = await index.revision(candidate, tx);
              const source = {
                candidate,
                revision,
                text,
                bodyDigest: semanticBodyDigest(text),
                fingerprint: semanticFingerprint([candidate, revision, text]),
              };
              const certificate = await facade.capture(source, profile, tx);
              await facade.persist(certificate, tx);
              firstSource ??= source;
              firstCertificate ??= certificate;
              assert.ok(!JSON.stringify(certificate).includes(text));
              assert.equal(Object.hasOwn(certificate, 'envelope'), false);
            }
          });
          const result = await collect();
          assert.equal(result.facts.length, 129);
          assert.ok(result.facts.every((row) => row.decision === 'allow'));
          assert.ok(result.nodes.every((row) => row.base_decision === 'allow'));
        },
      );
      await t.test(
        'certificate and relation brands cannot outlive their transaction',
        async () => {
          await assert.rejects(
            read((tx) => facade.persist(firstCertificate!, tx)),
          );
          let handle: SearchContentEligibilityRelation | undefined;
          await read(async (tx) => {
            handle = await facade.prepare(scope, profile, tx);
          });
          await assert.rejects(
            read(async (tx) =>
              requireSearchContentEligibilityRelation(handle!, tx),
            ),
          );
        },
      );
      await t.test(
        'lifecycle delete/restore ABA invalidates certificate and stale capture',
        async () => {
          const id = firstSource!.candidate.id;
          await h.pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [id],
          );
          assert.equal((await collect()).facts.length, 128);
          await h.pool.query(
            "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
            [id],
          );
          assert.equal(
            (await collect()).facts.find((row) => row.id === id)?.decision,
            'unknown',
          );
          await assert.rejects(
            read((tx) => facade.capture(firstSource!, profile, tx)),
          );
        },
      );
      await t.test(
        'current certified review revoke is deny; restore ABA requires recertification',
        async () => {
          const other = (
            await h.pool.query<{ content_id: string; decision_id: string }>(
              'SELECT content_id,decision_id FROM whaleu_community.content_approval_bindings WHERE content_id<>$1 ORDER BY content_id LIMIT 1',
              [firstSource!.candidate.id],
            )
          ).rows[0]!;
          await setReviewState(h.pool, other.decision_id, 'revoked');
          assert.equal(
            (await collect()).facts.find((row) => row.id === other.content_id)
              ?.decision,
            'deny',
          );
          await setReviewState(h.pool, other.decision_id, 'allow');
          assert.equal(
            (await collect()).facts.find((row) => row.id === other.content_id)
              ?.decision,
            'unknown',
          );
        },
      );
      await t.test(
        'mutable-definition TRUNCATE cannot leave persistent certificates valid',
        async () => {
          for (const table of [
            'post_images',
            'poll_options',
            'content_approval_policies',
          ])
            await assert.rejects(
              h.pool.query(`TRUNCATE whaleu_community.${table} CASCADE`),
            );
        },
      );
      await t.test(
        'reply capture persists independent post/root certificates and root withdrawal invalidates descendants',
        async () => {
          const world = await h.world();
          const post = await world.publish({ text: 'certificate parent' });
          const template = await world.envelope();
          const [root] = await seedExactContent(
            h.pool,
            h.policyId,
            'comment',
            1,
            () => ({
              ...template,
              purpose: 'publish_comment',
              postId: post.id,
              rootCommentId: null,
              targetReplyId: null,
              text: 'certificate root',
            }),
          );
          const [reply] = await seedExactContent(
            h.pool,
            h.policyId,
            'reply',
            1,
            () => ({
              ...template,
              purpose: 'publish_reply',
              postId: post.id,
              rootCommentId: root!.id,
              targetReplyId: null,
              text: 'certificate reply',
            }),
          );
          const candidate: SearchCandidate = {
            kind: 'reply',
            id: reply!.id,
            postId: post.id,
            rootCommentId: root!.id,
            spaceId: world.scope.home.spaceId,
            at: new Date(reply!.at).toISOString().replace('.000Z', '.000000Z'),
          };
          await read(async (tx) => {
            const revision = await index.revision(candidate, tx);
            const source = {
              candidate,
              revision,
              text: reply!.envelope.text,
              bodyDigest: semanticBodyDigest(reply!.envelope.text),
              fingerprint: semanticFingerprint([
                candidate,
                revision,
                reply!.envelope.text,
              ]),
            };
            const certificate = await facade.capture(source, profile, tx);
            await facade.persist(certificate, tx);
          });
          const stored = (
            await h.pool.query(
              'SELECT kind,content_id FROM whaleu_semantic.certificates WHERE post_id=$1',
              [post.id],
            )
          ).rows;
          assert.equal(stored.length, 3);
          const get = () =>
            read(async (tx) => {
              const handle = await facade.prepare(
                {
                  ...scope,
                  spaceId: world.scope.home.spaceId,
                  types: ['reply'],
                },
                profile,
                tx,
              );
              return {
                fact: (await tx.query(`SELECT * FROM ${handle.tableName}`))
                  .rows[0],
                nodes: (
                  await tx.query(`SELECT * FROM ${handle.nodesTableName}`)
                ).rows,
              };
            });
          assert.equal((await get()).fact.decision, 'allow');
          await h.pool.query(
            "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=$1",
            [root!.id],
          );
          assert.equal((await get()).fact.decision, 'deny');
          await h.pool.query(
            "UPDATE whaleu_community.root_comments SET visibility='approved' WHERE id=$1",
            [root!.id],
          );
          const restored = await get();
          assert.equal(restored.fact.decision, 'unknown');
          assert.equal(
            restored.nodes.find((row) => row.node_key.startsWith('post:'))
              .base_decision,
            'allow',
          );
          assert.equal(
            restored.nodes.find((row) => row.node_key.startsWith('comment:'))
              .base_decision,
            'unknown',
          );
          // A leaf certificate miss must not hide a known parent role's base fact.
          await h.pool.query(
            "DELETE FROM whaleu_semantic.certificates WHERE kind='reply' AND content_id=$1",
            [reply!.id],
          );
          assert.equal(
            (await get()).nodes.find((row) => row.node_key.startsWith('post:'))
              .base_decision,
            'allow',
          );
        },
      );
      await t.test(
        'uncommitted own-source rows and subtransaction rows cannot be certified',
        async () => {
          for (const subtransaction of [false, true])
            await assert.rejects(
              read(async (tx) => {
                if (subtransaction) await tx.query('SAVEPOINT own_source');
                await tx.query(
                  "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
                  [firstSource!.candidate.id],
                );
                if (subtransaction)
                  await tx.query('RELEASE SAVEPOINT own_source');
                const revision = await index.revision(
                  firstSource!.candidate,
                  tx,
                );
                await facade.capture(
                  { ...firstSource!, revision },
                  profile,
                  tx,
                );
              }),
            );
        },
      );
      await t.test(
        'same-millisecond future and misordered review evidence retain PostgreSQL precision',
        async () => {
          const cases = [
            [
              '2026-01-01T00:00:00.000100Z',
              '2026-01-01T00:00:00.000000Z',
              '2026-01-01T00:00:00.000900Z',
              '2025-01-01T00:00:00Z',
            ],
            [
              '2026-01-01T00:00:00.999999Z',
              '2026-01-01T00:00:00.000900Z',
              '2026-01-01T00:00:00.000100Z',
              '2025-01-01T00:00:00Z',
            ],
            [
              '2026-01-01T00:00:00.999999Z',
              '2026-01-01T00:00:00.000100Z',
              '2026-01-01T00:00:00.000900Z',
              '2026-01-01T00:00:00.000900Z',
            ],
          ];
          for (const values of cases) {
            const result = await h.pool.query(
              `WITH timing AS (SELECT $1::timestamptz now),
          d AS (SELECT $2::timestamptz evaluated_at,'2027-01-01'::timestamptz consume_until,NULL::timestamptz visibility_until),
          e AS (SELECT $3::timestamptz occurred_at), p AS (SELECT $4::timestamptz valid_from,NULL::timestamptz valid_until)
          SELECT ${SEARCH_APPROVAL_EXACT_TIME_PREDICATE} AS valid FROM timing,d,e,p`,
              values,
            );
            assert.equal(result.rows[0].valid, false);
          }
        },
      );
      await t.test(
        'a trigger-swallowed certificate write cannot report success',
        async () => {
          await h.pool
            .query(`CREATE FUNCTION whaleu_semantic.fixture_swallow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
        CREATE TRIGGER fixture_swallow BEFORE INSERT OR UPDATE ON whaleu_semantic.certificates FOR EACH ROW EXECUTE FUNCTION whaleu_semantic.fixture_swallow()`);
          try {
            await assert.rejects(
              read(async (tx) => {
                const revision = await index.revision(
                  firstSource!.candidate,
                  tx,
                );
                const certificate = await facade.capture(
                  { ...firstSource!, revision },
                  profile,
                  tx,
                );
                await facade.persist(certificate, tx);
              }),
            );
          } finally {
            await h.pool.query(
              'DROP TRIGGER fixture_swallow ON whaleu_semantic.certificates; DROP FUNCTION whaleu_semantic.fixture_swallow()',
            );
          }
        },
      );
      await t.test(
        'never-indexed review denial gets canonical certificate-only evidence without a vector',
        async () => {
          const world = await h.world();
          for (const state of ['held', 'revoked'] as const) {
            const post = await world.publish({
              text: `private ${state} certificate fixture`,
            });
            await setReviewState(h.pool, post.approval.decisionId, state);
            const candidate = (
              await h.pool.query<SearchCandidate>(
                `SELECT id,'post'::text kind,space_id AS "spaceId",id AS "postId",
            NULL::uuid AS "rootCommentId",to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at
            FROM whaleu_community.posts WHERE id=$1`,
                [post.id],
              )
            ).rows[0]!;
            await read(async (tx) => {
              const captured = await facade.captureEligibility(
                candidate,
                profile,
                tx,
              );
              assert.equal(captured.decision, 'deny');
              assert.ok(captured.certificate);
              assert.equal(captured.certificate.has_searchable_text, false);
              assert.ok(!JSON.stringify(captured).includes(post.body.text));
              await facade.persist(captured.certificate, tx);
            });
            const decision = await read(async (tx) => {
              const handle = await facade.prepare(
                {
                  ...scope,
                  spaceId: world.scope.home.spaceId,
                  postId: post.id,
                },
                profile,
                tx,
              );
              return (
                await tx.query(`SELECT decision FROM ${handle.tableName}`)
              ).rows[0].decision;
            });
            assert.equal(decision, 'deny');
            assert.equal(
              (
                await h.pool.query(
                  'SELECT count(*)::integer n FROM whaleu_semantic.embeddings WHERE content_id=$1',
                  [post.id],
                )
              ).rows[0].n,
              0,
            );
          }
          const malformed = await world.publish({
            text: 'malformed review denial fixture',
          });
          await h.mutate(async (tx) => {
            const event = randomUUID();
            await tx.query(
              `INSERT INTO whaleu_community.content_approval_events
            (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
            VALUES($1,$2,'revoked','missing','accepted','fixture','fixture',clock_timestamp())`,
              [event, malformed.approval.decisionId],
            );
            await tx.query(
              'UPDATE whaleu_community.content_approval_heads SET event_id=$1 WHERE decision_id=$2',
              [event, malformed.approval.decisionId],
            );
          });
          const candidate = (
            await h.pool.query<SearchCandidate>(
              `SELECT id,'post'::text kind,space_id AS "spaceId",id AS "postId",
          NULL::uuid AS "rootCommentId",to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at
          FROM whaleu_community.posts WHERE id=$1`,
              [malformed.id],
            )
          ).rows[0]!;
          const captured = await read((tx) =>
            facade.captureEligibility(candidate, profile, tx),
          );
          assert.deepEqual(captured, { decision: 'unknown' });
        },
      );
      await t.test(
        'canonical empty and Unicode-whitespace posts cannot bypass the existing owner rules',
        async () => {
          const world = await h.world();
          const template = await world.envelope();
          for (const text of ['', ' \t\n\u2003\uFEFF'])
            await assert.rejects(world.seed(1, () => ({ ...template, text })));
          assert.equal(
            (
              await h.pool.query(
                'SELECT count(*)::integer n FROM whaleu_semantic.certificates WHERE space_id=$1',
                [world.scope.home.spaceId],
              )
            ).rows[0].n,
            0,
          );
        },
      );
    } finally {
      if (installed) await h.pool.query('DROP SCHEMA whaleu_semantic CASCADE');
      await h.close();
    }
  },
);
