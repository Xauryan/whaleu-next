import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('source preview converts native progress/radio and expands scoped includes without leaking native tags', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'whaleu-preview-controls-'));
  try {
    const log = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(__dirname, '../scripts/preview-apple.mjs'),
        '--source',
        '--batch=personal-secondary',
        '--batch=moderation',
        '--batch=rating-management',
        '--batch=school-operations',
        `--output=${output}`,
      ],
      { encoding: 'utf8' },
    );
    assert.match(
      log,
      /personal-secondary semantic validation: all 46 frames passed/,
    );
    assert.match(log, /moderation semantic validation: all 76 frames passed/);
    assert.match(
      log,
      /rating-management semantic validation: all 58 frames passed/,
    );
    assert.match(
      log,
      /school-operations semantic validation: all 100 frames passed/,
    );
    const school = readFileSync(
      path.join(output, 'school-operations-product.html'),
      'utf8',
    );
    assert.match(school, /type=&quot;checkbox&quot;/);
    const personal = readFileSync(
      path.join(output, 'personal-secondary-product.html'),
      'utf8',
    );
    const moderation = readFileSync(
      path.join(output, 'moderation-product.html'),
      'utf8',
    );
    const rating = readFileSync(
      path.join(output, 'rating-management-product.html'),
      'utf8',
    );
    assert.match(personal, /role=&quot;progressbar&quot;/);
    assert.match(moderation, /type=&quot;radio&quot;/);
    for (const html of [personal, moderation, rating, school]) {
      assert.doesNotMatch(
        html,
        /&lt;\/?(?:progress|radio-group|radio|checkbox-group|checkbox|include)\b/,
      );
      assert.doesNotMatch(html, /width:(?:NaN|Infinity|-)\w*%/);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
