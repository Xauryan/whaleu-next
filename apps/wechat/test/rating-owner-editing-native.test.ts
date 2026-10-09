import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setup } from './community-helpers';

test('native creator editing page, HTTPS gateway, v7 recovery and rendered WXML close the full loop', async () => {
  const require = createRequire(__filename);
  const {
    smokeRatingOwnerEditing,
  } = require('../scripts/smoke-rating-owner-editing.mjs');
  const s = setup();
  const app = { identity: { sessions: s.sessions }, community: s.runtime };
  const globals = globalThis as typeof globalThis & {
    wx?: unknown;
    Page?: unknown;
    getApp?: unknown;
  };
  const old = { wx: globals.wx, Page: globals.Page, getApp: globals.getApp };
  Object.assign(globals, { wx: {}, getApp: () => app });
  try {
    await smokeRatingOwnerEditing({
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
