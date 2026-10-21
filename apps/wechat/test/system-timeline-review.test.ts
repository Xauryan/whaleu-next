import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiClient } from '../src/api/client';
import { SafetyChanges } from '../src/community/safety-changes';
import { SystemTimelineController } from '../src/notifications/system-timeline';
import { systemNoticesSetup } from './system-notices-helpers';
const id = '77777777-7777-4777-8777-777777777777';
const api = {
  async request(spec: { path: string }) {
    return spec.path.endsWith('/target')
      ? { status: 'available', target: { applicationId: id, regionId: null } }
      : {
          items: [
            {
              id,
              kind: 'auth_result',
              outcome: 'approved',
              createdAt: '2026-10-01T00:00:00.000Z',
              read: false,
              available: true,
            },
          ],
          page: 1,
          hasNext: false,
        };
  },
} as unknown as ApiClient;
test('aggregate preserves every loaded source during token rotation and unrelated safety events', async () => {
  const h = systemNoticesSetup();
  const safetyChanges = new SafetyChanges();
  const timeline = new SystemTimelineController(
    { ...h.runtime, safetyChanges },
    () => undefined,
    api,
  );
  await timeline.load();
  const keys = timeline.snapshot().items.map((item) => item.key);
  assert.equal(keys.length, 2);
  const owner = h.sessions.snapshot();
  h.sessions.rotate(owner, {
    ...owner.credentials!,
    accessToken: 'rotated-access-token',
  });
  assert.deepEqual(
    timeline.snapshot().items.map((item) => item.key),
    keys,
  );
  safetyChanges.invalidate('99999999-9999-4999-8999-999999999999');
  assert.deepEqual(
    timeline.snapshot().items.map((item) => item.key),
    keys,
  );
  timeline.dispose();
});
test('explicit verification navigation failure is visible without exposing unrelated source failures as a feed error', async () => {
  const h = systemNoticesSetup();
  const timeline = new SystemTimelineController(
    h.runtime,
    () => undefined,
    api,
    async () => {
      throw new Error('native navigation failed');
    },
  );
  await timeline.load();
  assert.equal(timeline.snapshot().error, '');
  assert.ok(timeline.snapshot().sources.some((source) => source.error));
  await timeline.open(`verification:${id}`);
  assert.notEqual(timeline.snapshot().error, '');
  assert.equal(timeline.snapshot().items.length, 2);
  await timeline.load();
  assert.equal(timeline.snapshot().error, '');
  timeline.dispose();
});
