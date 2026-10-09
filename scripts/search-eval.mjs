#!/usr/bin/env node
// Offline synthetic retrieval evaluation. No network, credentials or runtime imports.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value, label) {
  requireThat(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label}: expected object`,
  );
}
function fields(value, keys, label) {
  object(value, label);
  requireThat(
    Object.keys(value).every((key) => keys.includes(key)) &&
      keys.every((key) => Object.hasOwn(value, key)),
    `${label}: unexpected or missing fields`,
  );
}
function nonempty(value, label) {
  requireThat(
    typeof value === 'string' && value.trim().length > 0,
    `${label}: expected nonempty string`,
  );
}
function uniqueRows(rows, label) {
  requireThat(Array.isArray(rows), `${label}: expected array`);
  const map = new Map();
  for (const row of rows) {
    object(row, label);
    nonempty(row.id, `${label}.id`);
    requireThat(!map.has(row.id), `${label}: duplicate ID ${row.id}`);
    map.set(row.id, row);
  }
  return map;
}
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export function datasetDigest(dataset) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(dataset)))
    .digest('hex');
}
export function validateDataset(dataset) {
  fields(
    dataset,
    ['schemaVersion', 'id', 'synthetic', 'description', 'documents', 'queries'],
    'dataset',
  );
  requireThat(
    dataset.schemaVersion === 1 && dataset.synthetic === true,
    'Only v1 explicitly synthetic datasets are supported',
  );
  nonempty(dataset.id, 'dataset.id');
  nonempty(dataset.description, 'dataset.description');
  const documents = uniqueRows(dataset.documents, 'documents');
  const queries = uniqueRows(dataset.queries, 'queries');
  requireThat(
    documents.size > 0 && queries.size > 0,
    'Dataset must contain documents and queries',
  );
  for (const document of documents.values()) {
    fields(
      document,
      ['id', 'kind', 'postId', 'rootCommentId', 'text'],
      'document',
    );
    nonempty(document.text, 'document.text');
    requireThat(
      ['post', 'comment', 'reply'].includes(document.kind),
      'Invalid document kind',
    );
    const post = documents.get(document.postId);
    requireThat(
      post?.kind === 'post',
      `Missing parent post for ${document.id}`,
    );
    if (document.kind === 'post')
      requireThat(
        document.postId === document.id && document.rootCommentId === null,
        'Invalid post ancestry',
      );
    if (document.kind === 'comment')
      requireThat(
        document.rootCommentId === document.id,
        'Invalid comment ancestry',
      );
    if (document.kind === 'reply') {
      const root = documents.get(document.rootCommentId);
      requireThat(
        root?.kind === 'comment' && root.postId === document.postId,
        'Invalid reply ancestry',
      );
    }
  }
  for (const query of queries.values()) {
    fields(query, ['id', 'text', 'tags', 'rationale', 'judgments'], 'query');
    nonempty(query.text, 'query.text');
    nonempty(query.rationale, 'query.rationale');
    requireThat(
      Array.isArray(query.tags) &&
        query.tags.length > 0 &&
        query.tags.every((tag) => typeof tag === 'string' && tag.length > 0),
      'Invalid query tags',
    );
    object(query.judgments, 'judgments');
    requireThat(
      Object.keys(query.judgments).length === documents.size &&
        [...documents.keys()].every((id) => Object.hasOwn(query.judgments, id)),
      'Judgments must cover exactly the entire corpus',
    );
    for (const grade of Object.values(query.judgments))
      requireThat(
        Number.isInteger(grade) && grade >= 0 && grade <= 3,
        'Relevance grade must be 0..3',
      );
  }
  return { documents, queries };
}
function validateProfile(profile) {
  fields(
    profile,
    [
      'id',
      'embeddingModel',
      'embeddingRevision',
      'dimensions',
      'queryInstruction',
      'documentInstruction',
      'normalization',
      'distance',
      'rerankerModel',
      'rerankerRevision',
      'pipelineRevision',
    ],
    'profile',
  );
  for (const key of [
    'id',
    'embeddingModel',
    'embeddingRevision',
    'normalization',
    'distance',
    'pipelineRevision',
  ])
    nonempty(profile[key], `profile.${key}`);
  requireThat(
    !Object.values(profile).some(
      (value) => typeof value === 'string' && value.startsWith('REPLACE_'),
    ),
    'Replace all template profile placeholders before evaluation',
  );
  requireThat(
    Number.isSafeInteger(profile.dimensions) && profile.dimensions > 0,
    'Invalid embedding dimensions',
  );
  for (const key of ['queryInstruction', 'documentInstruction'])
    requireThat(typeof profile[key] === 'string', `Invalid ${key}`);
  requireThat(
    (profile.rerankerModel === null && profile.rerankerRevision === null) ||
      (typeof profile.rerankerModel === 'string' &&
        profile.rerankerModel.trim() &&
        typeof profile.rerankerRevision === 'string' &&
        profile.rerankerRevision.trim()),
    'Reranker model and revision must both be set or null',
  );
}
export function validateRun(dataset, run) {
  const { documents, queries } = validateDataset(dataset);
  fields(
    run,
    ['schemaVersion', 'datasetId', 'datasetSha256', 'profile', 'results'],
    'run',
  );
  requireThat(
    run.schemaVersion === 1 &&
      run.datasetId === dataset.id &&
      run.datasetSha256 === datasetDigest(dataset),
    'Dataset identity/digest mismatch',
  );
  validateProfile(run.profile);
  requireThat(
    Array.isArray(run.results) && run.results.length === queries.size,
    'Missing or extra query results',
  );
  const seenQueries = new Set();
  for (const result of run.results) {
    fields(result, ['queryId', 'hits'], 'result');
    requireThat(
      queries.has(result.queryId) && !seenQueries.has(result.queryId),
      'Unknown or duplicate query ID',
    );
    seenQueries.add(result.queryId);
    requireThat(Array.isArray(result.hits), 'hits must be an array');
    const seenHits = new Set();
    for (const hit of result.hits) {
      fields(hit, ['documentId', 'score'], 'hit');
      requireThat(
        documents.has(hit.documentId) && !seenHits.has(hit.documentId),
        'Unknown or duplicate document ID',
      );
      seenHits.add(hit.documentId);
      requireThat(
        typeof hit.score === 'number' && Number.isFinite(hit.score),
        'Invalid score: expected finite number',
      );
    }
  }
}
function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function evaluate(dataset, run, cutoffs = [1, 5, 10]) {
  validateRun(dataset, run);
  requireThat(
    Array.isArray(cutoffs) &&
      cutoffs.length > 0 &&
      cutoffs.every((k) => Number.isSafeInteger(k) && k > 0) &&
      new Set(cutoffs).size === cutoffs.length,
    'Cutoffs must be distinct positive safe integers',
  );
  const byQuery = new Map(
    run.results.map((result) => [result.queryId, result]),
  );
  const perQuery = dataset.queries.map((query) => {
    const ranked = [...byQuery.get(query.id).hits].sort(
      (a, b) => b.score - a.score || compareIds(a.documentId, b.documentId),
    );
    const grades = ranked.map((hit) => query.judgments[hit.documentId]);
    const ideal = Object.values(query.judgments).sort((a, b) => b - a);
    const relevantCount = ideal.filter((grade) => grade > 0).length;
    const first = grades.findIndex((grade) => grade > 0);
    const dcg = (values, k) =>
      values
        .slice(0, k)
        .reduce(
          (sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2),
          0,
        );
    const at = Object.fromEntries(
      cutoffs.map((k) => [
        k,
        {
          recall: relevantCount
            ? grades.slice(0, k).filter((grade) => grade > 0).length /
              relevantCount
            : null,
          ndcg: relevantCount
            ? Math.min(1, dcg(grades, k) / dcg(ideal, k))
            : null,
        },
      ]),
    );
    return {
      queryId: query.id,
      tags: query.tags,
      relevantCount,
      returnedCount: ranked.length,
      mrr: relevantCount ? (first < 0 ? 0 : 1 / (first + 1)) : null,
      at,
    };
  });
  const eligible = perQuery.filter((query) => query.relevantCount > 0);
  const mean = (values) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    synthetic: true,
    warning:
      'Synthetic annotations only; metrics describe the imported rankings, not real-user quality. No model was called by this evaluator.',
    datasetId: dataset.id,
    datasetSha256: datasetDigest(dataset),
    profile: run.profile,
    profileSha256: datasetDigest(run.profile),
    queryCount: perQuery.length,
    evaluatedQueryCount: eligible.length,
    emptyRelevantQueryCount: perQuery.length - eligible.length,
    macro: {
      mrr: mean(eligible.map((q) => q.mrr)),
      at: Object.fromEntries(
        cutoffs.map((k) => [
          k,
          {
            recall: mean(eligible.map((q) => q.at[k].recall)),
            ndcg: mean(eligible.map((q) => q.at[k].ndcg)),
          },
        ]),
      ),
    },
    perQuery,
  };
}
export function template(dataset) {
  validateDataset(dataset);
  return {
    schemaVersion: 1,
    datasetId: dataset.id,
    datasetSha256: datasetDigest(dataset),
    profile: {
      id: 'REPLACE_WITH_EXACT_PROFILE',
      embeddingModel: 'Qwen3-Embedding-8B',
      embeddingRevision: 'REPLACE_WITH_PINNED_REVISION',
      dimensions: 4096,
      queryInstruction: '',
      documentInstruction: '',
      normalization: 'REPLACE_WITH_ACTUAL_NORMALIZATION',
      distance: 'REPLACE_WITH_ACTUAL_DISTANCE',
      rerankerModel: 'Qwen3-Reranker-8B',
      rerankerRevision: 'REPLACE_WITH_PINNED_REVISION',
      pipelineRevision: 'REPLACE_WITH_PIPELINE_AND_CANDIDATE_CONFIG_REVISION',
    },
    results: dataset.queries.map((query) => ({ queryId: query.id, hits: [] })),
  };
}
export function main(args) {
  const [command, datasetPath, ...runPaths] = args;
  requireThat(
    ['validate', 'template', 'evaluate'].includes(command) && datasetPath,
    'Usage: node scripts/search-eval.mjs validate|template DATASET.json; evaluate DATASET.json RUN.json [RUN.json ...]',
  );
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const dataset = read(datasetPath);
  validateDataset(dataset);
  if (command === 'evaluate') {
    requireThat(runPaths.length > 0, 'At least one run required');
    const runs = runPaths.map(read);
    const identities = new Map();
    for (const run of runs) {
      validateRun(dataset, run);
      const digest = datasetDigest(run.profile);
      requireThat(
        !identities.has(run.profile.id) ||
          identities.get(run.profile.id) === digest,
        'Profile ID reused with different model, dimensions or configuration',
      );
      identities.set(run.profile.id, digest);
    }
    // Reports stay separate. Never pool scores, vectors or metrics across profiles.
    return runs.map((run) => evaluate(dataset, run));
  }
  requireThat(runPaths.length === 0, 'Unexpected arguments');
  return command === 'template'
    ? template(dataset)
    : {
        valid: true,
        synthetic: true,
        datasetId: dataset.id,
        datasetSha256: datasetDigest(dataset),
        documents: dataset.documents.length,
        queries: dataset.queries.length,
      };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
