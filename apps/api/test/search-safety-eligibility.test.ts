import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SafetySearchEligibilityFacade } from '../src/safety/search-eligibility.facade.js';
import { safetyCountProofOwner } from '../src/safety/count-epochs.js';
import { ApplicationError } from '../src/http/application-error.js';

test('Safety search relation validates trusted identifiers and parameter indices', () => {
  const owner = new SafetySearchEligibilityFacade();
  for (const nodes of [
    'x; DROP TABLE foo',
    'schema.nodes',
    '"nodes"',
    '',
    'x'.repeat(64),
  ])
    assert.throws(
      () => owner.relation({ nodes, viewerParameter: 1 }),
      ApplicationError,
    );
  for (const viewerParameter of [0, -1, 1.5, Infinity, NaN, 65536])
    assert.throws(
      () => owner.relation({ nodes: 'nodes', viewerParameter }),
      ApplicationError,
    );
  const sql = owner.relation({ nodes: 'search_nodes', viewerParameter: 2 });
  assert.match(sql, /FROM "search_nodes"/);
  assert.match(sql, /\$2::uuid/);
  assert.doesNotMatch(sql, /target_reply|\.text|display_snapshot|LIMIT/i);
  assert.equal(owner.proofOwner, safetyCountProofOwner);
});
