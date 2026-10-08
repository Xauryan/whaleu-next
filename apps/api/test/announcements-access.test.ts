import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { AnnouncementsAccessService } from '../src/announcements/access.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { CampusService } from '../src/campus/campus.service.js';
import type { SafetyAnnouncementReadFacade } from '../src/safety/announcement-read.facade.js';
import { ApplicationError } from '../src/http/application-error.js';
function fixture(denied = false) {
  const events: string[] = [];
  let selected: string | undefined;
  const tx = {
    query: async (sql: string) => {
      events.push(
        sql.includes('pg_advisory') ? 'policy-gate' : 'bounded-waits',
      );
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const access = new AnnouncementsAccessService(
    {
      session: async () => {
        events.push('session');
        return {
          accountId: randomUUID(),
          sessionId: randomUUID(),
          expiresAt: 1000,
          refreshExpiresAt: 2000,
        };
      },
    } as unknown as IdentityService,
    {
      requireSelectable: async (id: string) => {
        events.push('campus');
        selected = id;
      },
    } as unknown as CampusService,
    {
      requireAnnouncementReadAllowed: async () => {
        events.push('safety');
        if (denied) throw new ApplicationError('SAFETY_ACTION_RESTRICTED');
      },
    } as unknown as SafetyAnnouncementReadFacade,
  );
  return { access, tx, events, selected: () => selected };
}
test('absent-token public read needs no owner, phone, student or identity-region facts', async () => {
  const f = fixture();
  assert.equal(await f.access.resolve(null, null, f.tx), null);
  await f.access.recheck(null, f.tx);
  assert.deepEqual(f.events, ['bounded-waits', 'policy-gate']);
  assert.equal(f.selected(), undefined);
  const campus = randomUUID();
  await f.access.resolve(null, campus, f.tx);
  assert.equal(f.selected(), campus);
  assert.equal(f.events.at(-1), 'campus');
});
test('signed-in reading requires current session and safety before explicit browsing campus', async () => {
  const f = fixture();
  const campus = randomUUID();
  await f.access.resolve('token', campus, f.tx);
  assert.deepEqual(f.events, [
    'bounded-waits',
    'policy-gate',
    'session',
    'safety',
    'campus',
  ]);
  await f.access.recheck('token', f.tx);
  assert.equal(f.events.at(-1), 'session');
  const blocked = fixture(true);
  await assert.rejects(blocked.access.resolve('token', campus, blocked.tx), {
    code: 'SAFETY_ACTION_RESTRICTED',
  });
  assert.equal(blocked.selected(), undefined);
});
