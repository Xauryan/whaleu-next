import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config/config.js';
import { manualProcessingConfig } from '../src/config/manual-processing.js';

const fields = {
  updates: 'COMMUNITY_UPDATES_PROCESSING',
  jury: 'SAFETY_JURY_PROCESSING',
  experience: 'EXPERIENCE_PROCESSING',
} as const;
for (const owner of Object.keys(fields) as (keyof typeof fields)[]) {
  test(`${owner} CLI isolates inherited automatic dispatchers`, () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://dev:test@127.0.0.1:55432/whaleu_test',
      PG_SSL_MODE: 'disable',
      COMMUNITY_UPDATES_PROCESSING: 'automatic',
      SAFETY_JURY_PROCESSING: 'automatic',
      EXPERIENCE_PROCESSING: 'automatic',
    });
    const selected = manualProcessingConfig(config, owner);
    for (const [name, field] of Object.entries(fields)) {
      assert.equal(
        selected[field],
        name === owner ? 'manual_only' : 'disabled',
      );
      assert.equal(config[field], 'automatic');
    }
    assert.equal(selected.DATABASE_URL, config.DATABASE_URL);
    assert.equal(Object.isFrozen(selected), true);
    assert.equal(
      manualProcessingConfig({ ...config, [fields[owner]]: 'disabled' }, owner)[
        fields[owner]
      ],
      'disabled',
    );
  });
}
