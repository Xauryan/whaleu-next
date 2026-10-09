import test from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setup } from './community-helpers';
import { SafetyChanges } from '../src/community/safety-changes';

test('real native handlers and WXML use strict ApiClient random/campus flows and discard stale responses', async () => {
  const require = createRequire(__filename);
  const { smokeRatingsR3R } = require('../scripts/smoke-ratings-r3r.mjs');
  const s = setup();
  const app = {
    identity: { sessions: s.sessions },
    community: {
      ...s.runtime,
      safetyChanges: new SafetyChanges(s.runtime.privateViews),
    },
  };
  const globals = globalThis as typeof globalThis & {
    wx?: unknown;
    Page?: unknown;
    getApp?: unknown;
  };
  const old = { wx: globals.wx, Page: globals.Page, getApp: globals.getApp };
  Object.assign(globals, { wx: {}, getApp: () => app });
  try {
    await smokeRatingsR3R({
      app,
      dist: path.resolve(__dirname, '../src'),
      extension: 'ts',
      flush: async () => {
        for (let i = 0; i < 100; i++) await Promise.resolve();
      },
    });
  } finally {
    Object.assign(globals, old);
  }
});
