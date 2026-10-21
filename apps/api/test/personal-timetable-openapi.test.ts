import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createPersonalTimetableOpenApiDocument,
  renderPersonalTimetableOpenApiDocument,
} from '../scripts/personal-timetable-openapi-document.js';
test('private timetable OpenAPI has all strict private routes, recovery proof and no payload receipt', async () => {
  const doc = createPersonalTimetableOpenApiDocument();
  assert.equal(Object.keys(doc.paths).length, 5);
  const rendered = await renderPersonalTimetableOpenApiDocument();
  assert.equal(
    await readFile(
      new URL('../../../docs/openapi/personal-timetable.json', import.meta.url),
      'utf8',
    ),
    rendered,
  );
  for (const path of Object.values(doc.paths))
    for (const operation of Object.values(path))
      assert.deepEqual(operation.security, [{ accessToken: [] }]);
  const receipt = doc.components!.schemas!['PersonalTimetableReceipt']!;
  assert.ok('properties' in receipt);
  assert.ok(!('payload' in receipt.properties!));
  for (const field of [
    'intentHash',
    'expectedRevision',
    'resultingRevision',
    'outcome',
    'code',
  ])
    assert.ok(field in receipt.properties!);
  assert.match(rendered, /never rolls back/);
  assert.match(rendered, /never trims/);
  assert.ok(!rendered.includes('"accountId"'));
});
