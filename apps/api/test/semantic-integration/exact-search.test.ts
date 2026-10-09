import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import { configureHttp } from '../../src/http/http.js';
import { SEMANTIC_MODEL_PROVIDER } from '../../src/community/search/semantic/runtime.js';
import { indexNextSemanticBatch } from '../../src/community/search/semantic/backfill.js';
import { installSemanticSearch } from '../../src/community/search/semantic/install.js';
import { ContentReviewSearchEligibilityFacade } from '../../src/community/content-review/search-eligibility.facade.js';
import { LocalApprovedContentVisibility } from '../../src/community/content-review/local-approved-content-visibility.js';
import { CampusContentScopeFacade } from '../../src/campus/content-scope.facade.js';
import { SafetySearchEligibilityFacade } from '../../src/safety/search-eligibility.facade.js';
import { SemanticCorpusRepository } from '../../src/community/search/semantic/corpus-repository.js';
import { fullCorpusScopeAuthority } from '../../src/community/search/semantic/engine.js';
import {
  childEnvelope,
  seedChildren,
} from '../integration/discussion-search-fixtures.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchHarness } from '../integration/search-fixtures.js';
import { setReviewState } from '../support/community-approval-fixtures.js';
import { SearchService } from '../../src/community/search/service.js';
import { searchQuerySchema } from '../../src/community/search/contracts.js';
import { QwenSemanticProvider } from '../../src/community/search/semantic/provider.js';
import type { QwenSemanticTransport } from '../../src/community/search/semantic/provider.js';
import { createQwenSemanticProfile } from '../../src/community/search/semantic/profile.js';
import { SemanticIndexRepository } from '../../src/community/search/semantic/repository.js';
import {
  SemanticSearchEngine,
  oracleScopeAuthority,
} from '../../src/community/search/semantic/engine.js';
import { ApplicationError } from '../../src/http/application-error.js';

const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'COMMUNITY_UNAVAILABLE';
const vector = (position: number) =>
  Array.from({ length: 4096 }, (_, i) => (i === position ? 1 : 0));
const profile = createQwenSemanticProfile({
  providerId: 'offline-fixture',
  deploymentId: 'synthetic',
  deploymentRevision: 'fixture-v1',
  embeddingModelRevision: 'fixture-v1',
  rerankerModelRevision: 'fixture-v1',
});

test(
  'optional pgvector exact scope oracle: real source/permission proofs and stub-only model transport',
  { timeout: 180000 },
  async (t) => {
    const h = await searchHarness();
    let installed = false;
    try {
      assert.equal(await installSemanticSearch(h.pool), 'installed');
      installed = true;
      assert.equal(await installSemanticSearch(h.pool), 'already_installed');
      assert.equal(
        (
          await h.pool.query(
            "SELECT extversion FROM pg_extension WHERE extname='vector'",
          )
        ).rows[0]?.extversion,
        '0.8.7',
      );
      const searches = h.app.get(SearchService),
        index = new SemanticIndexRepository();
      const outbound: string[][] = [];
      let duringEmbedding: (() => Promise<void>) | undefined;
      let duringRerank: (() => Promise<void>) | undefined;
      const assertNoSourceLocks = async () => {
        const held = await h.pool.query<{
          n: number;
        }>(`SELECT count(*)::integer n FROM pg_locks WHERE locktype='relation' AND granted
        AND relation IN ('whaleu_community.posts'::regclass,'whaleu_community.root_comments'::regclass,'whaleu_community.replies'::regclass)
        AND mode='RowShareLock'`);
        assert.equal(
          held.rows[0]!.n,
          0,
          'No canonical source transaction may survive into provider I/O',
        );
      };
      const transport: QwenSemanticTransport = {
        embed: async (envelope) => {
          await assertNoSourceLocks();
          await duringEmbedding?.();
          return {
            profileIdentity: envelope.profileIdentity,
            indexSpaceKey: envelope.indexSpaceKey,
            response: {
              model: envelope.request.model,
              data: envelope.request.input.map((text, index) => ({
                index,
                embedding: vector(
                  text.includes('耳机') || text.includes('headphones') ? 0 : 1,
                ),
              })),
            },
          };
        },
        rerank: async (envelope) => {
          await assertNoSourceLocks();
          outbound.push(
            envelope.request.documents.map((document) => document.text),
          );
          assert.ok(
            envelope.request.documents.every((document) =>
              /^candidate-\d+$/.test(document.id),
            ),
          );
          await duringRerank?.();
          return {
            profileIdentity: envelope.profileIdentity,
            indexSpaceKey: envelope.indexSpaceKey,
            response: {
              model: envelope.request.model,
              results: envelope.request.documents.map((doc, index) => ({
                index,
                id: doc.id,
                score: doc.text.includes('耳机') ? 5 : -2,
                text: 'DO NOT RETURN PROVIDER TEXT',
              })),
            },
          };
        },
      };
      const provider = new QwenSemanticProvider(profile, transport);
      const authority = oracleScopeAuthority(searches, index);
      const engine = new SemanticSearchEngine(
        provider,
        index,
        authority,
        'local_fixture',
      );

      const certificates = new ContentReviewSearchEligibilityFacade(
        h.app.get(LocalApprovedContentVisibility),
        h.app.get(CampusContentScopeFacade),
      );
      const corpus = new SemanticCorpusRepository(
        new SafetySearchEligibilityFacade(),
      );
      const full = new SemanticSearchEngine(
        provider,
        index,
        fullCorpusScopeAuthority(
          searches,
          index,
          certificates,
          corpus,
          profile,
        ),
        'local_fixture',
        certificates,
      );

      await t.test(
        'disabled refuses without invoking provider or database',
        async () => {
          const disabled = new SemanticSearchEngine(provider, index, authority);
          await assert.rejects(
            disabled.search(
              null,
              searchQuerySchema.parse({ scope: 'global', q: 'headphones' }),
            ),
            unavailable,
          );
          assert.deepEqual(outbound, []);
        },
      );
      await t.test(
        'full 4096 vectors retrieve an older nonliteral post; excerpts never invent literal highlights',
        async () => {
          const w = await h.world();
          const old = await w.publish({
            text: '图书馆捡到一副耳机，请联系失物招领处',
          });
          await w.publish({ text: '今晚一起去食堂吃饭' });
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            q: 'headphones',
            limit: '1',
          });
          await assert.rejects(
            engine.search(w.reader.accessToken, query),
            unavailable,
            'Missing eligible vectors are not an empty result',
          );
          assert.deepEqual(
            await engine.indexScope(w.reader.accessToken, query),
            { indexed: 2 },
          );
          const result = await engine.search(w.reader.accessToken, query);
          assert.equal(result.items[0]?.contentId, old.id);
          assert.deepEqual(result.items[0]?.snippet.segments, [
            { text: old.body.text, matched: false },
          ]);
          assert.ok(
            !JSON.stringify(result).includes('DO NOT RETURN PROVIDER TEXT'),
          );
          assert.equal(result.mode, 'exact-scope-oracle-v1');
        },
      );
      await t.test(
        'review-denied source needs no vector and never reaches reranker',
        async () => {
          const w = await h.world();
          const hidden = await w.publish({ text: '私人耳机 hidden fixture' });
          const visible = await w.publish({ text: '耳机在服务台' });
          await setReviewState(h.pool, hidden.approval.decisionId, 'revoked');
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            q: 'headphones',
          });
          assert.deepEqual(
            await engine.indexScope(w.reader.accessToken, query),
            { indexed: 1 },
          );
          const result = await engine.search(w.reader.accessToken, query);
          assert.deepEqual(
            result.items.map((item) => item.contentId),
            [visible.id],
          );
          assert.ok(!outbound.at(-1)!.includes(hidden.body.text));
        },
      );
      await t.test(
        'hide/restore during embedding changes incarnation and stale work cannot publish',
        async () => {
          const w = await h.world();
          const post = await w.publish({ text: '耳机 source ABA' });
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            q: 'headphones',
          });
          duringEmbedding = async () => {
            await h.pool.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [post.id],
            );
            await h.pool.query(
              "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
              [post.id],
            );
          };
          try {
            await assert.rejects(
              engine.indexScope(w.reader.accessToken, query),
              unavailable,
            );
          } finally {
            duringEmbedding = undefined;
          }
          assert.equal(
            (
              await h.pool.query(
                'SELECT count(*)::integer n FROM whaleu_semantic.embeddings WHERE content_id=$1',
                [post.id],
              )
            ).rows[0]!.n,
            0,
          );
        },
      );
      await t.test(
        'review revoke/restore during rerank rejects the whole answer',
        async () => {
          const w = await h.world();
          const post = await w.publish({ text: '耳机 review ABA' });
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            q: 'headphones',
          });
          await engine.indexScope(w.reader.accessToken, query);
          duringRerank = async () => {
            await setReviewState(h.pool, post.approval.decisionId, 'revoked');
            await setReviewState(h.pool, post.approval.decisionId, 'allow');
          };
          try {
            await assert.rejects(
              engine.search(w.reader.accessToken, query),
              unavailable,
            );
          } finally {
            duringRerank = undefined;
          }
        },
      );
      await t.test(
        'source generation cannot be preseeded, rewritten, deleted or truncated',
        async () => {
          const w = await h.world();
          const post = await w.publish({ text: 'generation fixture' });
          for (const sql of [
            'UPDATE whaleu_semantic.source_generations SET generation=gen_random_uuid() WHERE content_id=$1',
            'DELETE FROM whaleu_semantic.source_generations WHERE content_id=$1',
            "INSERT INTO whaleu_semantic.source_generations VALUES('post',$1,gen_random_uuid()) ON CONFLICT DO NOTHING",
          ])
            await assert.rejects(h.pool.query(sql, [post.id]));
          await assert.rejects(
            h.pool.query('TRUNCATE whaleu_semantic.source_generations'),
          );
          await assert.rejects(
            h.pool.query('TRUNCATE whaleu_community.poll_options'),
          );
        },
      );
      await t.test(
        'full-corpus exact search indexes bounded source batches and retrieves the oldest of 140 sources',
        async () => {
          const w = await h.world();
          const base = await w.envelope();
          const rows = await w.seed(140, (i) => ({
            ...base,
            text: i === 139 ? '耳机 很早以前的失物招领' : '普通食堂讨论',
          }));
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            q: 'headphones',
            limit: '1',
          });
          await assert.rejects(
            full.search(w.reader.accessToken, query),
            unavailable,
          );
          const first = await indexNextSemanticBatch(
            searches,
            full,
            w.reader.accessToken,
            query,
          );
          assert.equal(first.indexed, 128);
          assert.ok(first.next);
          await assert.rejects(
            indexNextSemanticBatch(
              searches,
              full,
              w.reader.accessToken,
              { ...query, q: 'different' },
              first.next,
            ),
            (error: unknown) =>
              error instanceof ApplicationError &&
              error.code === 'DISCOVERY_RESTART_REQUIRED',
          );
          const second = await indexNextSemanticBatch(
            searches,
            full,
            w.reader.accessToken,
            query,
            first.next,
          );
          assert.equal(second.indexed, 12);
          assert.equal(second.next, null);
          const result = await full.search(w.reader.accessToken, query);
          assert.equal(result.mode, 'exact-full-corpus-v1');
          assert.equal(result.items[0]?.contentId, rows[139]!.id);
          duringRerank = async () => {
            await h.pool.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [rows[50]!.id],
            );
          };
          try {
            await assert.rejects(
              full.search(w.reader.accessToken, query),
              unavailable,
            );
          } finally {
            duringRerank = undefined;
          }
        },
      );
      await t.test(
        'old reply is independently retrieved; parent and root certificates are issued without embedding their context',
        async () => {
          const w = await h.world();
          const post = await w.publish({ text: '大家来讨论校园生活' });
          const rootEnvelope = await childEnvelope(
            h,
            w,
            post.id,
            null,
            w.author,
            '这是普通回复',
          );
          const roots = await seedChildren(h, 'comment', 1, () => rootEnvelope);
          const replyEnvelope = await childEnvelope(
            h,
            w,
            post.id,
            roots[0]!.id,
            w.author,
            '耳机 在老校区图书馆',
          );
          const replies = await seedChildren(
            h,
            'reply',
            1,
            () => replyEnvelope,
          );
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            type: 'reply',
            q: 'headphones',
          });
          assert.deepEqual(
            await full.indexSources(w.reader.accessToken, query, [
              { kind: 'reply', id: replies[0]!.id },
            ]),
            { indexed: 1 },
          );
          const result = await full.search(w.reader.accessToken, query);
          assert.equal(result.items[0]?.contentId, replies[0]!.id);
          assert.equal(result.items[0]?.kind, 'reply');
          assert.deepEqual(outbound.at(-1), [replyEnvelope.text]);
          await h.pool.query(
            "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=$1",
            [roots[0]!.id],
          );
          assert.deepEqual(
            (await full.search(w.reader.accessToken, query)).items,
            [],
          );
        },
      );
      await t.test(
        'full-corpus Safety denies before vector coverage, and denied embeddings cannot influence ranking',
        async () => {
          const w = await h.world();
          const hidden = await w.publish({ text: '私人耳机向量' });
          const other = await w.actor();
          const visible = await w.publish(
            { text: '耳机 可以到服务台领取' },
            other,
          );
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            q: 'headphones',
          });
          await full.indexSources(w.reader.accessToken, query, [
            { kind: 'post', id: hidden.id },
            { kind: 'post', id: visible.id },
          ]);
          await h.writeBlock(w.reader, w.author);
          await h.pool.query(
            'DELETE FROM whaleu_semantic.embeddings WHERE content_id=$1',
            [hidden.id],
          );
          const result = await full.search(w.reader.accessToken, query);
          assert.deepEqual(
            result.items.map((item) => item.contentId),
            [visible.id],
          );
          assert.deepEqual(outbound.at(-1), [visible.body.text]);
        },
      );
      await t.test(
        'never-indexed known review denial gets only a certificate, never model input or an embedding',
        async () => {
          const w = await h.world();
          const denied = await w.publish({ text: '绝不发送给模型的耳机正文' });
          const good = await w.publish({ text: '耳机 在服务台' });
          await setReviewState(h.pool, denied.approval.decisionId, 'revoked');
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            q: 'headphones',
          });
          assert.deepEqual(
            await full.indexSources(w.reader.accessToken, query, [
              { kind: 'post', id: denied.id },
              { kind: 'post', id: good.id },
            ]),
            { indexed: 1 },
          );
          const result = await full.search(w.reader.accessToken, query);
          assert.deepEqual(
            result.items.map((hit) => hit.contentId),
            [good.id],
          );
          assert.deepEqual(outbound.at(-1), [good.body.text]);
          assert.equal(
            (
              await h.pool.query(
                'SELECT count(*)::integer n FROM whaleu_semantic.embeddings WHERE content_id=$1',
                [denied.id],
              )
            ).rows[0]!.n,
            0,
          );
        },
      );
      await t.test(
        'a swallowed embedding upsert cannot report successful backfill',
        async () => {
          const w = await h.world();
          const post = await w.publish({ text: '耳机 vector write guard' });
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            q: 'headphones',
          });
          await h.pool
            .query(`CREATE FUNCTION whaleu_semantic.swallow_embedding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
          CREATE TRIGGER zz_swallow_embedding BEFORE INSERT OR UPDATE ON whaleu_semantic.embeddings FOR EACH ROW EXECUTE FUNCTION whaleu_semantic.swallow_embedding()`);
          try {
            await assert.rejects(
              full.indexSources(w.reader.accessToken, query, [
                { kind: 'post', id: post.id },
              ]),
              unavailable,
            );
          } finally {
            await h.pool.query(
              'DROP TRIGGER zz_swallow_embedding ON whaleu_semantic.embeddings; DROP FUNCTION whaleu_semantic.swallow_embedding()',
            );
          }
          assert.equal(
            (
              await h.pool.query(
                'SELECT count(*)::integer n FROM whaleu_semantic.certificates WHERE content_id=$1',
                [post.id],
              )
            ).rows[0]!.n,
            0,
            'Certificate must roll back too',
          );
        },
      );
      await t.test(
        'enabled HTTP uses the same full-corpus engine, exact contract and shared rate budget with a stub provider',
        async () => {
          const w = await h.world();
          const post = await w.publish({ text: '耳机 在校园服务台' });
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            q: 'headphones',
            limit: '1',
          });
          await full.indexSources(w.reader.accessToken, query, [
            { kind: 'post', id: post.id },
          ]);
          const enabled = loadConfig({
            NODE_ENV: 'test',
            DATABASE_URL: process.env['TEST_DATABASE_URL'],
            PG_SSL_MODE: 'disable',
            LOG_LEVEL: 'silent',
            COMMUNITY_SEMANTIC_SEARCH: 'enabled',
            COMMUNITY_SEMANTIC_TRANSMISSION: 'approved',
            COMMUNITY_SEMANTIC_DEPLOYMENT_REVISION: 'fixture-v1',
            COMMUNITY_SEMANTIC_EMBEDDING_REVISION: 'fixture-v1',
            COMMUNITY_SEMANTIC_RERANKER_REVISION: 'fixture-v1',
          });
          const module = await Test.createTestingModule({
            imports: [AppModule.register(enabled)],
          })
            .overrideProvider(SEMANTIC_MODEL_PROVIDER)
            .useValue(provider)
            .compile();
          const app = module.createNestApplication({ logger: false });
          configureHttp(app);
          await app.init();
          try {
            const before = outbound.length;
            const invalid = await request(app.getHttpServer())
              .get('/v1/community/search/semantic')
              .set('Authorization', 'Bearer invalid-synthetic-token')
              .query({ spaceId: w.scope.home.spaceId, q: 'headphones' });
            assert.equal(invalid.status, 401);
            assert.equal(outbound.length, before);
            for (let i = 0; i < 10; i++) {
              const response = await request(app.getHttpServer())
                .get('/v1/community/search/semantic')
                .set('Authorization', `Bearer ${w.reader.accessToken}`)
                .query({
                  spaceId: w.scope.home.spaceId,
                  q: 'headphones',
                  limit: '1',
                });
              assert.equal(response.status, 200, JSON.stringify(response.body));
              assert.deepEqual(Object.keys(response.body).sort(), [
                'indexStatus',
                'items',
                'mode',
                'ranking',
              ]);
              assert.equal(response.body.mode, 'semantic');
              assert.equal(response.body.indexStatus, 'current');
              assert.equal(response.body.ranking, 'embedding-top32-reranked');
              assert.equal(response.body.items[0].contentId, post.id);
              assert.equal(
                response.body.items[0].snippet.segments[0].matched,
                false,
              );
            }
            const blocked = await request(app.getHttpServer())
              .get('/v1/community/search/semantic')
              .set('Authorization', `Bearer ${w.reader.accessToken}`)
              .query({ spaceId: w.scope.home.spaceId, q: 'headphones' });
            assert.equal(blocked.status, 429);
            assert.equal(blocked.body.error.code, 'RATE_LIMITED');
          } finally {
            await app.close();
          }
        },
      );
      await t.test(
        '129th structural source is unavailable rather than a latest-128 semantic window',
        async () => {
          const w = await h.world();
          await w.seed(129);
          const query = searchQuerySchema.parse({
            spaceId: w.scope.home.spaceId,
            q: 'headphones',
          });
          await assert.rejects(
            engine.indexScope(w.reader.accessToken, query),
            unavailable,
          );
        },
      );
    } finally {
      // Only this suite's optional schema; the preinstalled public extension is
      // deliberately left owned by the test environment, never dropped here.
      if (installed) await h.pool.query('DROP SCHEMA whaleu_semantic CASCADE');
      await h.close();
    }
  },
);
