import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setup } from './community-helpers';
test('native category tree page, rendered scope confirmation and v8 HTTPS recovery close the creation loop', async () => {
  const require = createRequire(__filename);
  const {
    smokeRatingCategoryManagement,
  } = require('../scripts/smoke-rating-category-management.mjs');
  const s = setup(),
    app = { identity: { sessions: s.sessions }, community: s.runtime };
  const globals = globalThis as typeof globalThis & {
    wx?: unknown;
    Page?: unknown;
    getApp?: unknown;
  };
  const old = { wx: globals.wx, Page: globals.Page, getApp: globals.getApp };
  Object.assign(globals, { wx: {}, getApp: () => app });
  try {
    await smokeRatingCategoryManagement({
      app,
      dist: path.resolve(__dirname, '../src'),
      extension: 'ts',
      flush: async () => {
        for (let i = 0; i < 160; i++) await Promise.resolve();
      },
    });
  } finally {
    Object.assign(globals, old);
  }
});
