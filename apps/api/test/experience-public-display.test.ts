import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { AppModule } from '../src/app.module.js';
import { CommunitySerializer } from '../src/community/community-serialization.js';
import type { StoredPost } from '../src/community/community.repository.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { thresholds, titles } from '../src/experience/catalog.js';
import type { PublicExperienceDisplay } from '../src/experience/public-display.contract.js';
import { ExperiencePublicDisplayFacade } from '../src/experience/public-display.facade.js';
import { ExperiencePublicDisplayModule } from '../src/experience/public-display.module.js';
import { AuthorDisplayService } from '../src/profile/author-display.service.js';
import { preferenceDefaults } from '../src/profile/contracts.js';
import type { ProfileRepository } from '../src/profile/profile.repository.js';
import { PublicProfileFacade } from '../src/profile/public-profile.facade.js';

const owner = 'cebd1f8c-1ad2-4cf9-b0a0-bd77686674bc';
const unavailable = { status: 'unavailable', value: null } as const;
const cleared = { status: 'known', value: null } as const;
const absent = {
  appearance_present: false,
  title_key: null as string | null,
  title_owned: false,
  title_name: null as string | null,
  color_id: null as number | null,
  catalog_color_id: null as number | null,
  balance_known: false,
  balance: null as string | null,
};
const selected = {
  ...absent,
  appearance_present: true,
  title_key: 'level_3',
  title_owned: true,
  title_name: '初来乍到',
  color_id: 0,
  catalog_color_id: 0,
};
function fixture(initial: Partial<typeof absent> = {}) {
  const state = { row: { ...absent, ...initial }, error: null as Error | null };
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      if (state.error) throw state.error;
      return { rows: [state.row] };
    },
  } as unknown as PoolClient;
  return { facade: new ExperiencePublicDisplayFacade(), state, calls, tx };
}

test('missing selections and baseline stay independently unavailable without writes', async () => {
  const f = fixture();
  assert.deepEqual(await f.facade.read(owner, f.tx), {
    title: unavailable,
    color: unavailable,
    level: unavailable,
  });
  f.state.row.appearance_present = true;
  assert.deepEqual(await f.facade.read(owner, f.tx), {
    title: cleared,
    color: cleared,
    level: unavailable,
  });
  f.state.row.appearance_present = false;
  f.state.row.balance_known = true;
  f.state.row.balance = '0';
  assert.deepEqual(await f.facade.read(owner, f.tx), {
    title: unavailable,
    color: unavailable,
    level: { status: 'known', value: 1 },
  });
  f.state.row.appearance_present = true;
  assert.deepEqual(await f.facade.read(owner, f.tx), {
    title: cleared,
    color: cleared,
    level: { status: 'known', value: 1 },
  });
});

test('selected proven title needs neither an earned date nor a known current level', async () => {
  const f = fixture(selected);
  assert.deepEqual(await f.facade.read(owner, f.tx), {
    title: { status: 'known', value: { key: 'level_3', name: '初来乍到' } },
    color: { status: 'known', value: 0 },
    level: unavailable,
  });
  f.state.row.balance_known = true;
  f.state.row.balance = '9223372036854775807';
  assert.deepEqual((await f.facade.read(owner, f.tx)).title, {
    status: 'known',
    value: { key: 'level_3', name: '初来乍到' },
  });
  f.state.row.title_key = null;
  assert.deepEqual((await f.facade.read(owner, f.tx)).title, cleared);
});

test('every supported selected title is allowlisted using the trusted catalog', async () => {
  for (const title of titles) {
    const f = fixture({
      ...selected,
      title_key: title.key,
      title_name: title.name,
    });
    assert.deepEqual((await f.facade.read(owner, f.tx)).title, {
      status: 'known',
      value: { key: title.key, name: title.name },
    });
  }
});

test('inconsistent or unsupported title proof affects only that dimension', async () => {
  for (const patch of [
    { title_owned: false },
    { title_key: 'special_admin', title_name: '管理员' },
    { title_name: 'Administrator' },
    { title_name: null },
  ]) {
    const f = fixture({
      ...selected,
      ...patch,
      balance_known: true,
      balance: '15',
    });
    assert.deepEqual(await f.facade.read(owner, f.tx), {
      title: unavailable,
      color: { status: 'known', value: 0 },
      level: { status: 'known', value: 2 },
    });
  }
});

test('all safe colors, including 0 and retained 25, are independent of level', async () => {
  for (let color = 0; color <= 25; color++) {
    const f = fixture({
      ...selected,
      color_id: color,
      catalog_color_id: color,
    });
    assert.deepEqual((await f.facade.read(owner, f.tx)).color, {
      status: 'known',
      value: color,
    });
    assert.deepEqual((await f.facade.read(owner, f.tx)).level, unavailable);
    f.state.row.balance_known = true;
    f.state.row.balance = '0';
    const display = await f.facade.read(owner, f.tx);
    assert.deepEqual(display.color, { status: 'known', value: color });
    assert.deepEqual(display.level, { status: 'known', value: 1 });
  }
});

test('clearing title and color is independent; invalid colors never become styles or zero', async () => {
  const f = fixture(selected);
  f.state.row.color_id = null;
  assert.deepEqual((await f.facade.read(owner, f.tx)).color, cleared);
  assert.equal((await f.facade.read(owner, f.tx)).title.status, 'known');
  f.state.row.title_key = null;
  f.state.row.color_id = 0;
  assert.deepEqual(await f.facade.read(owner, f.tx), {
    title: cleared,
    color: { status: 'known', value: 0 },
    level: unavailable,
  });
  for (const value of [-1, 26, 1.5, '0', 'color:red', 'https://example.test']) {
    const invalid = fixture({
      ...selected,
      color_id: value as number,
      catalog_color_id: value as number,
    });
    assert.deepEqual(
      (await invalid.facade.read(owner, invalid.tx)).color,
      unavailable,
    );
  }
  f.state.row.catalog_color_id = null;
  assert.deepEqual((await f.facade.read(owner, f.tx)).color, unavailable);
});

for (const [index, threshold] of thresholds.entries())
  test(`public known level ${index + 1} uses exact balance threshold`, async () => {
    const f = fixture({ balance_known: true, balance: String(threshold) });
    assert.deepEqual((await f.facade.read(owner, f.tx)).level, {
      status: 'known',
      value: index + 1,
    });
    if (index > 0) {
      f.state.row.balance = String(threshold - 1);
      assert.deepEqual((await f.facade.read(owner, f.tx)).level, {
        status: 'known',
        value: index,
      });
    }
  });

test('balance needs state-plus-baseline proof and stays out of public JSON', async () => {
  const f = fixture({ ...selected, balance: '9223372036854775807' });
  assert.deepEqual((await f.facade.read(owner, f.tx)).level, unavailable);
  f.state.row.balance_known = true;
  const display = await f.facade.read(owner, f.tx);
  assert.deepEqual(display.level, { status: 'known', value: 30 });
  assert.deepEqual(Object.keys(display).sort(), ['color', 'level', 'title']);
  for (const field of Object.values(display))
    assert.deepEqual(Object.keys(field).sort(), ['status', 'value']);
  assert.doesNotMatch(
    JSON.stringify(display),
    /balance|owner|earned|recorded|revision|origin|coverage|settlement|signin|pending/,
  );
});

test('projection is one parameterized nonlocking statement with exact proof joins and no cache', async () => {
  const f = fixture(selected);
  await f.facade.read(owner, f.tx);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]!;
  assert.deepEqual(call.values, [owner]);
  assert.match(call.sql, /FROM \(VALUES \(\$1::uuid\)\)/);
  assert.match(call.sql, /e.owner_id=a.owner_id AND e.title_key=a.title_key/);
  assert.match(call.sql, /baselines b ON b.owner_id=s.owner_id/);
  assert.equal((call.sql.match(/\bSELECT\b/gi) ?? []).length, 1);
  assert.doesNotMatch(
    call.sql,
    /FOR\s+(?:UPDATE|SHARE|KEY|NO)|pg_advisory|\b(?:INSERT|UPDATE|DELETE|LOCK|GRANT)\b|earned_at|recorded_at|revision|whaleu_experience\.(?:owners|work|records|settlements|requests|enrollments)/i,
  );
  assert.ok(!call.sql.includes(owner));
  f.state.row = { ...absent };
  assert.deepEqual(await f.facade.read(owner, f.tx), {
    title: unavailable,
    color: unavailable,
    level: unavailable,
  });
  assert.equal(
    f.calls.length,
    2,
    'PoolClient reuse cannot retain old selection',
  );
});

test('unexpected database failures propagate instead of becoming unavailable evidence', async () => {
  const f = fixture();
  f.state.error = new Error('Synthetic database failure');
  await assert.rejects(
    f.facade.read(owner, f.tx),
    (error) => error === f.state.error,
  );
});

test('ordinary and publication display methods remain separate from named-public cosmetics', async () => {
  const calls: string[] = [];
  const f = fixture(selected);
  let exists = true;
  const profile = { profileId: 'public-profile', displayName: 'Named person' };
  const repository = {
    existingAuthorDisplay: async (id: string, tx: PoolClient) => {
      assert.equal(id, owner);
      assert.equal(tx, f.tx);
      calls.push('find');
      return exists ? { ...profile, privateExtra: 'not-public' } : null;
    },
    authorDisplay: async () => {
      calls.push('prepare');
      return profile;
    },
  } as unknown as ProfileRepository;
  const service = new AuthorDisplayService(repository, f.facade);
  assert.deepEqual(await service.prepare(owner, f.tx), profile);
  assert.deepEqual(await service.find(owner, f.tx), {
    ...profile,
    privateExtra: 'not-public',
  });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await service.findPublic(owner, f.tx), {
    ...profile,
    experienceDisplay: {
      title: { status: 'known', value: { key: 'level_3', name: '初来乍到' } },
      color: { status: 'known', value: 0 },
      level: unavailable,
    },
  });
  assert.equal(f.calls.length, 1);
  exists = false;
  assert.equal(await service.findPublic(owner, f.tx), null);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(calls, ['prepare', 'find', 'find', 'find']);
});

test('public profile lookup does not enrich protected source resolution', async () => {
  const f = fixture(selected);
  const record = {
    accountId: owner,
    profileId: 'profile',
    displayName: 'Named person',
    bio: '',
    preferences: preferenceDefaults,
  };
  const repository = {
    publicProfile: async () => record,
  } as unknown as ProfileRepository;
  const profiles = new PublicProfileFacade(repository, f.facade);
  assert.deepEqual(await profiles.find('profile', f.tx), {
    accountId: owner,
    profileId: 'profile',
    displayName: 'Named person',
    bio: '',
    hideProfilePosts: false,
  });
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await profiles.experienceDisplay(owner, f.tx)).title.status,
    'known',
  );
  assert.equal(f.calls.length, 1);
});

test('serializer enriches only named branches and retains exact anonymous keys', async () => {
  const display: PublicExperienceDisplay = {
    title: cleared,
    color: cleared,
    level: unavailable,
  };
  const calls: string[] = [];
  const profiles = {
    findPublic: async (accountId: string) => {
      calls.push(accountId);
      return {
        profileId: 'profile',
        displayName: 'Named person',
        experienceDisplay: display,
      };
    },
    find: async () => assert.fail('Named serialization must use findPublic'),
  } as unknown as AuthorDisplayService;
  type Dependencies = ConstructorParameters<typeof CommunitySerializer>;
  const serializer = new CommunitySerializer(
    {} as Dependencies[0],
    {} as Dependencies[1],
    profiles,
    {} as Dependencies[3],
    {} as Dependencies[4],
    {} as Dependencies[5],
    {} as Dependencies[6],
    {} as Dependencies[7],
  );
  const tx = {
    query: async () => ({
      rows: [{ id: 'persona', display_name: 'Anonymous whale' }],
    }),
  } as unknown as PoolClient;
  const post = {
    id: 'post',
    account_id: owner,
    author_mode: 'named',
  } as StoredPost;
  assert.deepEqual(await serializer.author(post, post, tx), {
    kind: 'named',
    profileId: 'profile',
    displayName: 'Named person',
    avatar: null,
    experienceDisplay: display,
  });
  post.author_mode = 'anonymous';
  assert.deepEqual(await serializer.author(post, post, tx), {
    kind: 'anonymous',
    personaId: 'persona',
    displayName: 'Anonymous whale',
    avatar: null,
    isPostAuthor: true,
  });
  assert.deepEqual(calls, [owner]);
});

test('ordinary AppModule boots with the public leaf and no dependency cycle', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
  });
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(DatabaseService)
    .useValue({ ready: async () => true })
    .compile();
  const app = module.createNestApplication({ logger: false });
  try {
    await app.init();
    assert.equal(
      app.get(ExperiencePublicDisplayFacade),
      app
        .select(ExperiencePublicDisplayModule)
        .get(ExperiencePublicDisplayFacade, { strict: true }),
    );
    assert.ok(app.get(AuthorDisplayService));
    assert.ok(app.get(PublicProfileFacade));
  } finally {
    await app.close();
  }
});
