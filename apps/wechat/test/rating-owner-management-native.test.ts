import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setup } from './community-helpers';

test('native owner deletion handlers, exact HTTP gateway, durable recovery and WXML form a metadata-only loop', async () => {
  const require = createRequire(__filename);
  const {
    smokeRatingOwnerManagement,
  } = require('../scripts/smoke-rating-owner-management.mjs');
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
    await smokeRatingOwnerManagement({
      app,
      dist: path.resolve(__dirname, '../src'),
      extension: 'ts',
      flush: async () => {
        for (let i = 0; i < 120; i++) await Promise.resolve();
      },
    });
  } finally {
    Object.assign(globals, old);
  }
});
