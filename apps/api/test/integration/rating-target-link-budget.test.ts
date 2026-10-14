import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../src/http/application-error.js';
import { ratingTargetLinkFixture } from '../support/rating-target-link-fixture.js';
import {
  setRatingReviewState,
  type RatingRuntimeFixture,
} from '../support/rating-runtime-fixture.js';
import {
  prepareSyntheticOpaqueAdoption,
  writeSyntheticOpaqueAdoption,
} from '../support/rating-scoped-adoption-fixture.js';
import { PublicationService } from '../../src/community/publication.service.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { observeExactQueries } from '../support/exact-discovery-counts.js';
import type { ExactQueryObservation } from '../support/exact-discovery-counts.js';
import { ContentReviewCountRepository } from '../../src/community/content-review/count-snapshot.repository.js';
import type { SnapshotReadBudget } from '../../src/community/content-review/count-snapshot.repository.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { DatabaseService } from '../../src/database/database.js';
import {
  ContentReviewCountFacade,
  COUNT_SNAPSHOT_BYTES,
} from '../../src/community/content-review/count-snapshot.facade.js';

/** Trusted immutable source + adoption ingress is prepared before one real
 * activation. The 256 cards still use normal authenticated PublicationService,
 * actual local-manual Review and every publication/binding/causality SQL guard.
 * This boundary test does not replay the separately covered native UI journey. */
test(
  'real card dependencies use a complete 4MiB budget: representative allow, 256-card proven overflow and independent oversized Review',
  // This watchdog includes 256 complete authenticated Review/publication journeys.
  // It is fixture setup time only; production proof deadlines and byte limits below are unchanged.
  { timeout: 600000 },
  async (t) => {
    const started = performance.now();
    const checkAbort = () => t.signal.throwIfAborted();
    const progress = (stage: string) => {
      // Node diagnostics may flush only when the test ends. Emit setup phases
      // immediately as well, so a timeout preserves the actual limiting stage.
      const message = `${stage}: ${Math.round(performance.now() - started)}ms`;
      t.diagnostic(message);
      console.info(`[rating-link-budget] ${message}`);
    };
    // Never let a rejected sibling leave owner work running into measurement
    // or fixture cleanup. Each owner call returns its connection before settling.
    const settle = async <T>(
      jobs: readonly (() => Promise<T>)[],
    ): Promise<T[]> => {
      checkAbort();
      const results = await Promise.allSettled(
        jobs.map(async (job) => {
          checkAbort();
          return job();
        }),
      );
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Bounded owner setup phase failed',
        );
      checkAbort();
      return results.map((result) => {
        assert.equal(result.status, 'fulfilled');
        if (result.status !== 'fulfilled') assert.fail();
        return result.value;
      });
    };
    const targets: Awaited<
      ReturnType<RatingRuntimeFixture['catalog']>
    >['targets'] = [];
    const f = await ratingTargetLinkFixture(null, {
      beforeActivation: async (source) => {
        const scopes = [
          `campus:${source.campusA}`,
          `campus:${source.campusB}`,
        ].sort();
        const registry = (
          await source.pool.query<{ id: string; revision: string }>(
            `SELECT s.id,s.revision FROM whaleu_ratings.scoped_source_heads h
             JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
             WHERE h.source_kind='scoped_category_system_registry' AND h.source_key='synthetic-assistance-course'`,
          )
        ).rows[0];
        assert.ok(registry);
        const importedCategories: string[] = [],
          importedCatalogs: string[] = [];
        // Every adoption guard hashes its complete sealed original catalog.
        // Sixteen complete small catalogs avoid repeatedly hashing 256 unrelated
        // targets for each leaf. No digest is cached or guard suppressed. Every
        // imported root has its own identity and real accepted registry binding.
        for (let chunk = 0; chunk < 16; chunk++) {
          checkAbort();
          const legacy = await source.catalog(source.creator, {
            regionId: source.regionId,
            count: 16,
            depth: 3,
            distinctTargetLeaves: true,
            rootSystemKey: 'course',
            // Preserve scope-wide unique ordinals and sibling names. The two
            // existing synthetic categories keep ordinals zero and one.
            ordinalOffset: 2 + chunk * 18,
            namePrefix: `Budget ${chunk + 1}`,
          });
          targets.push(...legacy.targets);
          importedCategories.push(...legacy.categoryIds);
          importedCatalogs.push(legacy.catalogId);
          for (const categoryId of legacy.categoryIds) {
            checkAbort();
            const adoption = await prepareSyntheticOpaqueAdoption(
              source,
              legacy.catalogId,
              categoryId,
              scopes,
              categoryId === legacy.rootId
                ? { ...registry, systemKey: 'course' }
                : undefined,
            );
            checkAbort();
            await withCommunityScopeWriter(source.pool, (tx) =>
              writeSyntheticOpaqueAdoption(tx, adoption),
            );
          }
          if ((chunk + 1) % 4 === 0)
            progress(
              `${targets.length} trusted targets and ${importedCategories.length} exact category adoptions`,
            );
        }
        assert.equal(targets.length, 256);
        assert.equal(new Set(importedCategories).size, 288);
        assert.equal(
          new Set(targets.map((target) => target.approval.envelope.categoryId))
            .size,
          256,
        );
        // Preserve the prior absence declarations; add only the real imported
        // category/target identities and their sealed original catalog.
        for (const scope of scopes) {
          checkAbort();
          const prior = (
            await source.pool.query<{
              payload: {
                categoryIds: string[];
                targetIds: string[];
                legacyCatalogIds: string[];
              };
            }>(
              `SELECT s.payload FROM whaleu_ratings.scoped_source_heads h
             JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
             WHERE h.source_kind='scope_absence' AND h.source_key=$1`,
              [scope],
            )
          ).rows[0];
          assert.ok(prior);
          await source.declareScope(scope, {
            categoryIds: [
              ...prior.payload.categoryIds,
              ...importedCategories,
            ].sort(),
            targetIds: [
              ...prior.payload.targetIds,
              ...targets.map((target) => target.id),
            ].sort(),
            legacyCatalogIds: [
              ...prior.payload.legacyCatalogIds,
              ...importedCatalogs,
            ].sort(),
          });
        }
        checkAbort();
      },
    });
    t.after(() => f.close());
    progress('Single real scoped activation');
    // Actual public capability proves registry inheritance. The remaining
    // revision references are read together, then independently requalified by
    // the ordinary owner at Review submission and publication, never treated as
    // an accepted capability or persisted binding supplied by this fixture.
    assert.equal((await f.linkReference(targets[0]!.id)).systemKey, 'course');
    const references = (
      await f.pool.query<{
        target_id: string;
        target_revision: string;
        category_revision: string;
        source_revision: string;
      }>(
        `SELECT t.id target_id,t.revision target_revision,c.effective_revision category_revision,p.source_revision
       FROM whaleu_ratings.scoped_catalog_heads h
       JOIN whaleu_ratings.scoped_target_memberships m ON m.catalog_id=h.catalog_id
       JOIN whaleu_ratings.targets t ON t.id=m.target_id
       JOIN whaleu_ratings.scoped_categories c ON (c.catalog_id,c.category_id)=(m.catalog_id,m.category_id)
       JOIN whaleu_ratings.target_scope_placements p ON (p.target_id,p.placement_revision)=(m.target_id,m.placement_revision)
       WHERE h.scope_key=$1 AND t.id=ANY($2::uuid[]) ORDER BY t.id`,
        [`campus:${f.campusA}`, targets.map((target) => target.id)],
      )
    ).rows;
    assert.equal(references.length, 256);
    // Each account stays below the unchanged local Review daily bound. Direct
    // service calls remove transport overhead, not owner admission or quotas.
    const actors = await settle(
      Array.from({ length: 4 }, () => () => f.actor()),
    );
    const publications = f.app.get(PublicationService),
      posts: string[] = [];
    for (let offset = 0; offset < references.length; offset += actors.length) {
      checkAbort();
      const wave = references
        .slice(offset, offset + actors.length)
        .map((target, lane) => ({
          actor: actors[lane]!,
          draft: publishPostSchema.parse({
            clientRequestId: randomUUID(),
            spaceId: f.scope.home.spaceId,
            category: 'discussion',
            text: 'Q',
            imageAssetIds: [],
            authorMode: 'named',
            commentsPolicy: 'open',
            component: {
              kind: 'rating_target_link',
              label: 'Q',
              targetId: target.target_id,
              selector: f.linkSelector,
              expectedTargetRevision: target.target_revision,
              expectedCategoryRevision: target.category_revision,
              expectedSourceRevision: target.source_revision,
            },
          }),
        }));
      // Independent actor admissions can run together. The real CLI operator
      // takes the exclusive Safety writer gate, so decisions are deliberately
      // serialized and never overlap a publication's final SHARE NOWAIT fence.
      const queued = await settle(
        wave.map(
          ({ actor, draft }) =>
            () =>
              publications.post(actor.accessToken, draft, true),
        ),
      );
      for (const result of queued) assert.equal(result.status, 'pending');
      for (const { actor, draft } of wave) {
        checkAbort();
        await f.approveLinkCommunity(actor, draft.clientRequestId);
      }
      const receipts = await settle(
        wave.map(
          ({ actor, draft }) =>
            () =>
              publications.post(actor.accessToken, draft),
        ),
      );
      for (const receipt of receipts) {
        assert.equal(receipt.outcome, 'created');
        if (receipt.outcome !== 'created') assert.fail(JSON.stringify(receipt));
        posts.push(receipt.resourceId);
      }
      if (posts.length % 32 === 0)
        progress(`${posts.length} actual Review publications`);
    }
    checkAbort();
    progress('All setup owner calls settled before count measurement');
    assert.deepEqual(
      (
        await f.pool.query(
          `SELECT count(*)::int cards,count(DISTINCT component->>'targetId')::int targets,
          count(DISTINCT component->'binding'->>'categoryId')::int leaves,
          sum(jsonb_array_length(component->'binding'->'ancestry'))::int paths
         FROM whaleu_community.post_rating_target_links
         WHERE post_id=ANY($1::uuid[]) AND jsonb_array_length(component->'binding'->'ancestry')=3`,
          [posts],
        )
      ).rows[0],
      { cards: 256, targets: 256, leaves: 256, paths: 768 },
    );
    // This scalar-only integrity read proves the fully constructed fixture has
    // 256 distinct live leaves and 768 actual ancestry occurrences. It is not a
    // Count evaluation and never substitutes for the Count owner's byte budget.
    const fixturePaths = (
      await f.pool.query<{
        leaves: number;
        paths: number;
        minimum: number;
        maximum: number;
        valid: boolean;
      }>(
        `WITH RECURSIVE wanted AS MATERIALIZED (
          SELECT DISTINCT m.catalog_id,m.category_id
          FROM whaleu_ratings.scoped_catalog_heads h
          JOIN whaleu_ratings.scoped_target_memberships m ON m.catalog_id=h.catalog_id
          WHERE h.scope_key=$1 AND m.target_id=ANY($2::uuid[])
        ), path AS (
          SELECT c.catalog_id,c.category_id,c.parent_id,c.level,c.category_id leaf_id,1 depth
          FROM wanted w JOIN whaleu_ratings.scoped_categories c
            ON (c.catalog_id,c.category_id)=(w.catalog_id,w.category_id)
          UNION ALL
          SELECT c.catalog_id,c.category_id,c.parent_id,c.level,p.leaf_id,p.depth+1
          FROM path p JOIN whaleu_ratings.scoped_categories c
            ON (c.catalog_id,c.category_id)=(p.catalog_id,p.parent_id)
          WHERE p.depth<3
        ), leaves AS (
          SELECT leaf_id,count(*)::int n,count(DISTINCT category_id)::int unique_nodes,
            min(level) first_level,max(level) last_level,
            count(*) FILTER(WHERE parent_id IS NULL)::int roots
          FROM path GROUP BY leaf_id
        ) SELECT count(*)::int leaves,sum(n)::int paths,min(n)::int minimum,max(n)::int maximum,
          bool_and(n=3 AND unique_nodes=3 AND first_level=1 AND last_level=3 AND roots=1) valid
          FROM leaves`,
        [`campus:${f.campusA}`, targets.map((target) => target.id)],
      )
    ).rows[0];
    assert.deepEqual(fixturePaths, {
      leaves: 256,
      paths: 768,
      minimum: 3,
      maximum: 3,
      valid: true,
    });
    t.diagnostic(JSON.stringify({ fixturePaths }));
    checkAbort();
    // Keep the exact owner-created ledger and PoolClient. A test-only pass-through
    // consume wrapper records numeric attempted/accepted charges, invokes the
    // original method with its original receiver and rethrows the same error.
    // No read, debit, reset, proof suppression or replacement ledger is added.
    type ChargeObservation = {
      requestedBytes: number;
      remainingBefore: number;
      remainingAfter: number;
      rejected: boolean;
      errorCode: ApplicationError['code'] | null;
    };
    const records = f.app.get(ContentReviewCountRepository),
      originalRead = records.read;
    const captured: {
      budget: SnapshotReadBudget;
      tx: PoolClient;
      originalConsume: SnapshotReadBudget['consume'];
      baseRemainingBytes: number;
      receiversMatch: boolean;
      charges: ChargeObservation[];
    }[] = [];
    records.read = async (
      ...args: Parameters<ContentReviewCountRepository['read']>
    ) => {
      const snapshot = await originalRead.apply(records, args);
      const budget = snapshot.budget;
      const observation = {
        budget,
        tx: args[1],
        originalConsume: budget.consume,
        baseRemainingBytes: budget.remainingBytes(),
        receiversMatch: true,
        charges: [] as ChargeObservation[],
      };
      budget.consume = function (this: SnapshotReadBudget, bytes: number) {
        observation.receiversMatch &&= this === budget;
        const remainingBefore = budget.remainingBytes();
        try {
          observation.originalConsume.call(this, bytes);
          observation.charges.push({
            requestedBytes: bytes,
            remainingBefore,
            remainingAfter: budget.remainingBytes(),
            rejected: false,
            errorCode: null,
          });
        } catch (error) {
          observation.charges.push({
            requestedBytes: bytes,
            remainingBefore,
            remainingAfter: budget.remainingBytes(),
            rejected: true,
            errorCode: error instanceof ApplicationError ? error.code : null,
          });
          throw error;
        }
      };
      captured.push(observation);
      return snapshot;
    };
    t.after(() => {
      records.read = originalRead;
      for (const observation of captured)
        observation.budget.consume = observation.originalConsume;
    });
    const budgetReports: {
      baseRetainedBytes: number;
      dependencyRetainedBytes: number;
      retainedBytes: number;
      remainingBytes: number;
      charges: ChargeObservation[];
    }[] = [];
    const observer = observeExactQueries(f.app);
    t.after(() => observer.restore());
    const queries: Pick<
      ExactQueryObservation,
      'sql' | 'rows' | 'bytes' | 'budget'
    >[] = [];
    observer.setHook(async (event) => {
      // Do not retain event.values: those can contain full owner envelopes.
      queries.push({
        sql: event.sql,
        rows: event.rows,
        bytes: event.bytes,
        ...(event.budget ? { budget: event.budget } : {}),
      });
    });
    const queryDiagnostics = () =>
      queries.map(({ sql, rows, bytes, budget }) => ({
        source:
          sql.match(/(?:FROM|INTO|UPDATE)\s+(whaleu_\w+\.\w+)/i)?.[1] ??
          'owner',
        rows,
        bytes,
        ...(budget ? { budget } : {}),
      }));
    const counts = async (ids: string[]) => {
      checkAbort();
      const start = captured.length;
      let client: PoolClient | undefined;
      const value = await f.app.get(DatabaseService).transaction((tx) => {
        client = tx;
        return f.app
          .get(ContentReviewCountFacade)
          .evaluatePosts(ids, f.creator.accountId, tx);
      });
      assert.equal(
        captured.length,
        start + 1,
        'One actual owner ledger per snapshot',
      );
      const observation = captured[start]!;
      assert.equal(
        observation.tx,
        client,
        'The original transaction client is retained',
      );
      assert.equal(
        observation.receiversMatch,
        true,
        'Every debit uses the original ledger',
      );
      const remainingBytes = observation.budget.remainingBytes();
      let expectedRemaining = observation.baseRemainingBytes;
      for (const charge of observation.charges) {
        assert.equal(charge.remainingBefore, expectedRemaining);
        assert.ok(
          Number.isSafeInteger(charge.requestedBytes) &&
            charge.requestedBytes >= 0,
        );
        if (charge.rejected) {
          assert.ok(charge.requestedBytes > charge.remainingBefore);
          assert.equal(charge.errorCode, 'COMMUNITY_UNAVAILABLE');
          assert.equal(charge.remainingAfter, charge.remainingBefore);
        } else {
          assert.equal(charge.errorCode, null);
          assert.equal(
            charge.remainingAfter,
            charge.remainingBefore - charge.requestedBytes,
          );
          expectedRemaining -= charge.requestedBytes;
        }
      }
      assert.equal(
        remainingBytes,
        expectedRemaining,
        'All accepted dependency debits reconcile exactly',
      );
      assert.ok(
        Number.isSafeInteger(remainingBytes) &&
          remainingBytes >= 0 &&
          remainingBytes <= observation.baseRemainingBytes,
      );
      budgetReports.push({
        baseRetainedBytes:
          COUNT_SNAPSHOT_BYTES - observation.baseRemainingBytes,
        dependencyRetainedBytes:
          observation.baseRemainingBytes - remainingBytes,
        retainedBytes: COUNT_SNAPSHOT_BYTES - remainingBytes,
        remainingBytes,
        charges: observation.charges,
      });
      return value;
    };
    const small = await observer.measure('one real 3-level card', () =>
      counts(posts.slice(0, 1)),
    );
    assert.deepEqual(
      [...small.value.facts.values()].map((fact) => fact.decision),
      ['allow'],
    );
    const smallBudget = budgetReports.at(-1)!;
    assert.equal(
      smallBudget.charges.some((charge) => charge.rejected),
      false,
    );
    queries.length = 0;
    const representativeSize = 32;
    const representative = await observer.measure(
      '32 real distinct 3-level cards within the complete budget',
      () => counts(posts.slice(0, representativeSize)),
    );
    const representativeBudget = budgetReports.at(-1)!;
    const representativeStates = [...representative.value.facts.values()].map(
      (fact) => fact.decision,
    );
    const representativeDiagnostics = {
      small: small.measurement,
      representative: representative.measurement,
      smallBudget,
      representativeBudget,
      states: representativeStates,
      queries: queryDiagnostics(),
    };
    t.diagnostic(JSON.stringify(representativeDiagnostics));
    assert.equal(representative.value.facts.size, representativeSize);
    assert.ok(
      representativeStates.every((state) => state === 'allow'),
      JSON.stringify(representativeDiagnostics),
    );
    assert.ok(
      representativeBudget.retainedBytes > 0 &&
        representativeBudget.retainedBytes <= COUNT_SNAPSHOT_BYTES &&
        representativeBudget.charges.every((charge) => !charge.rejected) &&
        queries.every((query) => !query.budget?.rejected),
      JSON.stringify(representativeDiagnostics),
    );
    const ancestry = queries.filter((q) =>
      q.sql.includes('WITH RECURSIVE path AS'),
    );
    assert.equal(
      ancestry.length,
      1,
      'One ancestry vector, never one read per leaf',
    );
    assert.match(ancestry[0]!.sql, /__dependency_count::bigint<=768/);
    assert.equal(
      ancestry[0]!.rows,
      representativeSize * 3,
      JSON.stringify(representativeDiagnostics),
    );
    assert.equal(
      ancestry[0]!.budget?.requestedRows,
      representativeSize * 3,
      JSON.stringify(representativeDiagnostics),
    );
    assert.ok(
      queries.filter((q) =>
        q.sql.includes(
          "registry.source_kind='scoped_category_system_registry'",
        ),
      ).length <= 1,
    );
    assert.ok(
      queries.filter(
        (q) =>
          q.sql.includes('wanted AS MATERIALIZED') &&
          q.sql.includes('rating_approval_decisions'),
      ).length <= 12,
      'Review owner chunks are bounded independent of leaf count',
    );
    assert.ok(
      representative.measurement.queries < small.measurement.queries + 40,
      `${small.measurement.queries} → ${representative.measurement.queries} queries`,
    );
    assert.ok(representative.measurement.maxQueryBytes <= COUNT_SNAPSHOT_BYTES);

    // The 256-card cardinality bound does not grant a separate or larger proof
    // budget. This fully constructed fixture's exact common scope proof exceeds
    // its remaining ledger after Community facts, so only a witnessed byte
    // rejection can justify unknown; unrelated failures must fail this test.
    queries.length = 0;
    const full = await observer.measure(
      '256 cards with proven complete-budget overflow',
      () => counts(posts),
    );
    const fullBudget = budgetReports.at(-1)!;
    const fullStates = [...full.value.facts.values()].map(
      (fact) => fact.decision,
    );
    const fullDiagnostics = {
      full: full.measurement,
      fullBudget,
      states: fullStates,
      queries: queryDiagnostics(),
    };
    t.diagnostic(JSON.stringify(fullDiagnostics));
    assert.equal(full.value.facts.size, 256);
    const rejectedCharges = fullBudget.charges.filter(
      (charge) => charge.rejected,
    );
    assert.ok(rejectedCharges.length > 0, JSON.stringify(fullDiagnostics));
    assert.ok(
      rejectedCharges.every(
        (charge) =>
          Number.isSafeInteger(charge.requestedBytes) &&
          charge.requestedBytes > 0 &&
          charge.requestedBytes > charge.remainingBefore &&
          charge.remainingAfter === charge.remainingBefore &&
          charge.errorCode === 'COMMUNITY_UNAVAILABLE',
      ),
      JSON.stringify(fullDiagnostics),
    );
    assert.ok(
      fullStates.every((state) => state === 'unknown'),
      JSON.stringify(fullDiagnostics),
    );
    assert.ok(fullBudget.retainedBytes <= COUNT_SNAPSHOT_BYTES);
    assert.ok(queries.every((query) => !query.budget?.rejected));
    assert.ok(full.measurement.queries < small.measurement.queries + 40);
    assert.ok(full.measurement.maxQueryBytes <= COUNT_SNAPSHOT_BYTES);
    await assert.rejects(counts([...posts, posts[0]!]));
    // Issue an oversized exact target Review event proof, rather than its small
    // public body: the complete dependency budget must include this hidden row.
    const firstTarget = targets.find(
      (target) => target.id === references[0]!.target_id,
    );
    assert.ok(firstTarget);
    try {
      await setRatingReviewState(
        f.pool,
        firstTarget.approval.decisionId,
        'allow',
        {
          provenanceReference: 'x'.repeat(COUNT_SNAPSHOT_BYTES + 1),
        },
      );
      queries.length = 0;
      const oversized = await observer.measure(
        'oversized exact Review dependency',
        () => counts(posts.slice(0, 1)),
      );
      assert.equal(oversized.value.facts.get(posts[0]!)?.decision, 'unknown');
      assert.ok(
        oversized.measurement.maxQueryBytes <= COUNT_SNAPSHOT_BYTES,
        'Oversized proof bytes never cross PostgreSQL wire',
      );
      assert.ok(oversized.measurement.queries < small.measurement.queries + 40);
      const oversizedBudget = budgetReports.at(-1)!;
      const rejectedReview = queries.filter(
        (query) =>
          query.sql.includes('rating_approval_decisions') &&
          query.budget?.kind === 'dependency' &&
          query.budget.rejected &&
          query.budget.requestedRows <= query.budget.rowLimit &&
          query.budget.requestedBytes > query.budget.remainingBytes,
      );
      const oversizedDiagnostics = {
        measurement: oversized.measurement,
        budget: oversizedBudget,
        queries: queryDiagnostics(),
      };
      t.diagnostic(JSON.stringify(oversizedDiagnostics));
      assert.ok(
        rejectedReview.length > 0,
        JSON.stringify(oversizedDiagnostics),
      );
      assert.ok(
        rejectedReview.every((query) => query.bytes <= COUNT_SNAPSHOT_BYTES),
        JSON.stringify(oversizedDiagnostics),
      );
    } finally {
      await setRatingReviewState(
        f.pool,
        firstTarget.approval.decisionId,
        'allow',
      );
    }
    assert.equal(
      (await counts(posts.slice(0, 1))).facts.get(posts[0]!)?.decision,
      'allow',
    );
  },
);
