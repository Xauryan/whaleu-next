import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('production shared Profile CAS callers remain closed and authenticated self APIs carry current credentials', async () => {
  const root = new URL('../src/', import.meta.url);
  const found: string[] = [];
  const walk = async (url: URL, prefix = ''): Promise<void> => {
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory())
        await walk(new URL(entry.name + '/', url), name + '/');
      else if (entry.name.endsWith('.ts')) {
        const source = await readFile(new URL(entry.name, url), 'utf8');
        if (source.includes('.updateInTransaction(')) found.push(name);
      }
    }
  };
  await walk(root);
  assert.deepEqual(found.sort(), [
    'profile/avatar-moderation/service.ts',
    'profile/avatar/service.ts',
    'profile/cover/service.ts',
    'profile/moderation/service.ts',
    'profile/profile.repository.ts',
  ]);
  const controller = await readFile(
    new URL('profile/profile.module.ts', root),
    'utf8',
  );
  assert.equal(
    (
      controller.match(
        /tokenHash: hashToken\(bearerToken\(authorization\)\)/g,
      ) ?? []
    ).length,
    3,
  );
  const repository = await readFile(
    new URL('profile/profile.repository.ts', root),
    'utf8',
  );
  assert.match(repository, /identity: ProfileSelfEditIdentity/);
  assert.match(repository, /INSERT INTO whaleu_profile\.self_edit_causes/);
  assert.ok(
    repository.indexOf('INSERT INTO whaleu_profile.self_edit_causes') <
      repository.indexOf('async updateInTransaction('),
  );
  assert.ok(fileURLToPath(root));
  const cover = await readFile(
    new URL('profile/cover/service.ts', root),
    'utf8',
  );
  assert.match(cover, /authenticateMediaSession\(this\.identity, token, tx\)/);
  assert.match(cover, /return this\.authorized\(token, async \(session, tx\)/);
  assert.match(cover, /const actor = session\.accountId/);
  assert.match(cover, /await lockCoverActor\(actor, tx\)/);
  assert.match(cover, /await this\.actorSafety\.requireAllowed\(actor, tx\)/);
});
