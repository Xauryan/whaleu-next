import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import { inTransaction, poolOptions } from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { establishSyntheticExperienceBaseline } from '../support/experience-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} from '../support/experience-native-bridge.js';

const require = createRequire(import.meta.url);
const dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url));
const rankingPath = '/v1/experience/ranking';
interface Item {
  profileId: string;
  displayName: string;
  experienceDisplay: {
    title: { status: string; value: unknown };
    color: { status: string; value: unknown };
    level: { status: string; value: number | null };
  };
}
interface Ranking {
  scope: string;
  population: string;
  populationCompleteness: string;
  selectionStatus: string;
  items: Item[];
}
interface NativePage {
  data: {
    items: Item[];
    busy: boolean;
    loaded: boolean;
    error: string;
    selectionStatus: string | null;
  };
  setData(patch: Record<string, unknown>, callback?: () => void): void;
  onLoad?(query: Record<string, string>): void;
  onShow(): void;
  onRefresh(): void;
  onCancel(): void;
  onProfile(event: { currentTarget: { dataset: { profileId: string } } }): void;
  onHide(): void;
  onUnload(): void;
}
interface ProfilePage {
  data: {
    profile: { status: string; profileId: string } | null;
    items: unknown[];
    busy: boolean;
    loaded: boolean;
    error: string;
  };
  setData(patch: Record<string, unknown>, callback?: () => void): void;
  onLoad(query: { profileId: string }): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
}
interface NativeApp {
  onLaunch(): void;
  onHide(): void;
  identity: {
    sessions: {
      beginLogin(): number;
      completeLogin(epoch: number, credentials: SessionCredentials): void;
      logout(): void;
    };
  };
}
interface WxRequest {
  url: string;
  method: string;
  header: Record<string, string>;
  data?: unknown;
  timeout: number;
  success(response: {
    statusCode: number;
    header: Readonly<Record<string, string>>;
    data: unknown;
  }): void;
  fail(error: { errMsg: string }): void;
}

/** Drain both actual HTTP and native continuation microtasks, without guessing
 * when a Page has settled or replacing its controller/gateway with test doubles. */
class DrainedTransport extends NativeExperienceTransport {
  private readonly pending = new Set<Promise<unknown>>();
  override send(input: Parameters<NativeExperienceTransport['send']>[0]) {
    const operation = super.send(input);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  async idle() {
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.allSettled([...this.pending]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.pending.size === 0) return;
    }
  }
}

// Synthetic device callbacks only; emitted App/Page, decoder, optional-auth
// client, ordinary HTTP providers and all PostgreSQL owner proofs stay real.
// This is not real-device, real-history or production acceptance.
test(
  'emitted known-participant Page → HTTP → disposable PostgreSQL is bounded, identity-aware and read-only',
  { timeout: 180000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Requires disposable loopback whaleu_test; no skip');
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '12',
      EXPERIENCE_PROCESSING: 'manual_only',
      COMMUNITY_UPDATES_PROCESSING: 'manual_only',
    });
    const pool = new Pool(poolOptions(config));
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = Object.fromEntries(
      ['wx', 'App', 'Page', 'getApp'].map((key) => [key, globals[key]]),
    );
    let server: INestApplication | undefined;
    let suite: PoolClient | undefined;
    let locked = false,
      owns = false;
    let native: NativeApp | undefined;
    const pages = new Set<NativePage>();
    const profilePages = new Set<ProfilePage>();
    let transport: DrainedTransport | undefined;
    const releases: (() => void)[] = [];
    const emittedConfig = require(`${dist}config.js`);
    const previousConfig = emittedConfig.clientConfiguration;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Serialize disposable integration suites');
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
        'Refuse existing application schemas',
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      server = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(server);
      await server.listen(0, '127.0.0.1');
      const bridge = new DrainedTransport(
        Number(new URL(await server.getUrl()).port),
      );
      transport = bridge;
      const platform = platformStorage();
      const navigations: string[] = [];
      const replies: Ranking[] = [];
      const profilePaths = new Set<string>();
      let allowedProfilePath: string | null = null;
      let profileReply: unknown;
      bridge.checkResponse = (path, status, body) => {
        if (path !== rankingPath) {
          assert.equal(
            path,
            allowedProfilePath,
            'Only the exact navigation target is permitted',
          );
          assert.equal(status, 200);
          profileReply = structuredClone(body);
          return;
        }
        if (status !== 200) return;
        const reply = body as Ranking;
        assert.deepEqual(Object.keys(reply).sort(), [
          'items',
          'population',
          'populationCompleteness',
          'scope',
          'selectionStatus',
        ]);
        assert.equal(reply.scope, 'global');
        assert.equal(reply.population, 'known_participants');
        assert.equal(reply.populationCompleteness, 'incomplete');
        assert.ok(reply.items.length <= 50);
        assert.equal(
          new Set(reply.items.map((item) => item.profileId)).size,
          reply.items.length,
        );
        for (const item of reply.items)
          assert.deepEqual(Object.keys(item).sort(), [
            'displayName',
            'experienceDisplay',
            'profileId',
          ]);
        replies.push(structuredClone(reply));
      };
      const wx = {
        ...platform,
        nextTick: queueMicrotask,
        navigateTo(input: { url: string; success(): void }) {
          navigations.push(input.url);
          input.success();
        },
        request(input: WxRequest) {
          const requestUrl = new URL(input.url);
          if (requestUrl.pathname === rankingPath) {
            assert.equal(requestUrl.search, '?limit=50');
          } else {
            assert.equal(
              requestUrl.pathname,
              allowedProfilePath,
              'No avatar bytes, content lists or identity routes',
            );
            assert.equal(requestUrl.search, '');
            assert.ok(
              input.header['Authorization'],
              'Current signed viewer is retained at the destination',
            );
          }
          assert.equal(input.method, 'GET');
          assert.equal(input.data, undefined);
          bridge
            .send({
              url: input.url,
              method: input.method,
              headers: input.header,
              timeoutMs: input.timeout,
            })
            .then(
              (response) =>
                input.success({
                  statusCode: response.status,
                  header: response.headers,
                  data: response.body,
                }),
              () => input.fail({ errMsg: 'request:fail synthetic' }),
            );
          // Late real callbacks still arrive after abort; native fencing must win.
          return { abort() {} };
        },
      };
      emittedConfig.clientConfiguration = Object.freeze({
        apiOrigin: nativeOrigin,
        providerLoginEnabled: true,
      });
      globals['wx'] = wx;
      globals['App'] = (value: NativeApp) => {
        native = value;
      };
      globals['getApp'] = () => native;
      delete require.cache[require.resolve(`${dist}app.js`)];
      require(`${dist}app.js`);
      assert.ok(native, 'Load actual emitted App registration');
      const app = native as NativeApp;
      app.onLaunch();
      const login = (credentials: SessionCredentials) =>
        app.identity.sessions.completeLogin(
          app.identity.sessions.beginLogin(),
          credentials,
        );
      const mount = () => {
        let registered: NativePage | undefined;
        globals['Page'] = (value: NativePage) => {
          registered = value;
        };
        const entry = `${dist}pages/experience-ranking/experience-ranking.js`;
        delete require.cache[require.resolve(entry)];
        require(entry);
        assert.ok(registered, 'Load actual emitted Page registration');
        const page = registered as NativePage;
        page.setData = (patch, callback) => {
          page.data = { ...page.data, ...patch };
          callback?.();
        };
        pages.add(page);
        page.onLoad?.({});
        page.onShow();
        return page;
      };
      const close = (page: NativePage) => {
        page.onHide();
        page.onUnload();
        pages.delete(page);
      };
      const settled = async (page: NativePage) => {
        await bridge.idle();
        assert.equal(page.data.busy, false, page.data.error);
        assert.equal(page.data.loaded, true, page.data.error);
        assert.deepEqual(
          page.data.items.map(
            ({ profileId, displayName, experienceDisplay }) => ({
              profileId,
              displayName,
              experienceDisplay,
            }),
          ),
          replies.at(-1)!.items,
          'Page must preserve exact server order and public fields',
        );
      };
      const seed = async (balance: bigint | null, profile = true) => {
        const accountId = randomUUID(),
          profileId = randomUUID();
        await inTransaction(pool, async (tx) => {
          await tx.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
            [accountId],
          );
          await initializeNativeSafetyAccount(accountId, tx);
          if (balance !== null)
            await establishSyntheticExperienceBaseline(tx, accountId, {
              balance,
            });
          if (profile)
            await tx.query(
              "INSERT INTO whaleu_profile.profiles(account_id,public_id,nickname) VALUES($1,$2,'RankingFixture')",
              [accountId, profileId],
            );
        });
        return { accountId, profileId, balance };
      };
      const addProfile = async (accountId: string) => {
        const profileId = randomUUID();
        await pool.query(
          "INSERT INTO whaleu_profile.profiles(account_id,public_id,nickname) VALUES($1,$2,'ViewerFixture')",
          [accountId, profileId],
        );
        return profileId;
      };
      const snapshot = async () => {
        const tables = (
          await pool.query<{ schema: string; name: string }>(
            "SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname LIKE 'whaleu\\_%' ESCAPE '\\' ORDER BY 1,2",
          )
        ).rows;
        const result: Record<string, unknown> = {};
        for (const { schema, name } of tables) {
          assert.match(schema, /^[a-z_]+$/);
          assert.match(name, /^[a-z_]+$/);
          result[`${schema}.${name}`] = (
            await pool.query(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') data FROM ${schema}.${name} t`,
            )
          ).rows[0].data;
        }
        result['sequences'] = (
          await pool.query(
            "SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname LIKE 'whaleu\\_%' ESCAPE '\\' ORDER BY 1,2",
          )
        ).rows;
        return result;
      };
      const block = async (
        blocker: string,
        blocked: string,
        source: string,
      ) => {
        await inTransaction(pool, async (tx) => {
          const id = randomUUID();
          await tx.query(
            "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,true,1,'Synthetic','profile',$4)",
            [id, blocker, blocked, source],
          );
          await tx.query(
            "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'blocked',1)",
            [randomUUID(), blocker, id],
          );
        });
      };
      const zero = await seed(0n),
        unknown = await seed(null),
        missing = await seed(1000n, false);
      const inactive = await seed(2000n),
        high = await seed(139n),
        tie = await seed(139n),
        low = await seed(138n);
      await pool.query(
        "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
        [inactive.accountId],
      );
      await pool.query(
        "UPDATE whaleu_profile.profiles SET preferences=jsonb_set(preferences,'{hideProfilePosts}','true') WHERE account_id=$1",
        [high.accountId],
      );
      const first = await createRuntimeActor(server),
        second = await createRuntimeActor(server);
      const ownProfile = await addProfile(first.accountId);
      const secondProfile = await addProfile(second.accountId);

      await t.test(
        'guest keeps SQL balance/tie order, known zero and incomplete coverage without initializing historical accounts',
        async () => {
          const before = await snapshot(),
            stored = structuredClone([...platform.storage.values]);
          const page = mount();
          await settled(page);
          const ids = page.data.items.map((item) => item.profileId);
          assert.deepEqual(
            ids.slice(0, 3),
            [
              ...[high, tie].sort((a, b) =>
                a.accountId.localeCompare(b.accountId),
              ),
              low,
            ].map((item) => item.profileId),
          );
          assert.ok(ids.includes(zero.profileId));
          assert.ok(
            ids.includes(high.profileId),
            'hideProfilePosts does not hide experience',
          );
          for (const hidden of [unknown, missing, inactive])
            assert.ok(!ids.includes(hidden.profileId));
          assert.deepEqual(
            page.data.items.find((item) => item.profileId === zero.profileId)!
              .experienceDisplay.level,
            { status: 'known', value: 1 },
          );
          assert.equal(
            replies.at(-1)!.selectionStatus,
            'available_candidates_exhausted',
          );
          assert.deepEqual(
            page.data.items.find((item) => item.profileId === zero.profileId)!
              .experienceDisplay.title,
            { status: 'unavailable', value: null },
          );
          assert.deepEqual(
            page.data.items.find((item) => item.profileId === ownProfile)!
              .experienceDisplay.title,
            { status: 'known', value: null },
          );
          assert.ok(bridge.exchanges.every((exchange) => !exchange.authorized));
          page.onProfile({
            currentTarget: { dataset: { profileId: high.profileId } },
          });
          assert.equal(
            navigations.at(-1),
            `/pages/public-profile/public-profile?profileId=${high.profileId}`,
          );
          page.onRefresh();
          await settled(page);
          const serialized = JSON.stringify(page.data);
          for (const actor of [
            zero,
            unknown,
            missing,
            inactive,
            high,
            tie,
            low,
          ])
            assert.ok(!serialized.includes(actor.accountId));
          close(page);
          assert.deepEqual(
            await snapshot(),
            before,
            'Every table, balance, ledger, baseline, entitlement, reward, notice and sequence is unchanged',
          );
          assert.deepEqual(
            [...platform.storage.values],
            stored,
            'Guest list has no persisted cache',
          );
        },
      );

      await block(first.accountId, high.accountId, high.profileId);
      await block(tie.accountId, first.accountId, ownProfile);
      await block(second.accountId, first.accountId, ownProfile);
      await t.test(
        'signed bilateral blocks, own-profile exception and account replacement never reuse guest or another account results',
        async () => {
          const before = await snapshot();
          login(first);
          const stored = structuredClone([...platform.storage.values]);
          const page = mount();
          await settled(page);
          const ids = page.data.items.map((item) => item.profileId);
          assert.ok(!ids.includes(high.profileId));
          assert.ok(!ids.includes(tie.profileId));
          assert.ok(!ids.includes(secondProfile));
          assert.ok(
            ids.includes(ownProfile),
            'Owner remains visible despite relationships with peers',
          );
          assert.ok(bridge.exchanges.at(-1)!.authorized);
          assert.deepEqual(
            [...platform.storage.values],
            stored,
            'List does not persist signed results',
          );
          const held = bridge.holdNext(rankingPath);
          releases.push(held.release);
          page.onRefresh();
          await held.arrived;
          login(second);
          held.release();
          assert.deepEqual(page.data.items, []);
          await bridge.idle();
          assert.deepEqual(page.data.items, []);
          page.onRefresh();
          await settled(page);
          assert.ok(
            page.data.items.some(
              (item: Item) => item.profileId === high.profileId,
            ),
          );
          assert.ok(
            !page.data.items.some(
              (item: Item) => item.profileId === ownProfile,
            ),
          );
          app.identity.sessions.logout();
          assert.deepEqual(page.data.items, []);
          page.onRefresh();
          await settled(page);
          assert.ok(
            page.data.items.some((item: Item) => item.profileId === ownProfile),
          );
          close(page);
          assert.deepEqual(await snapshot(), before);
        },
      );

      await t.test(
        'a relationship changed after the list read is reauthorized by the actual emitted destination Page',
        async () => {
          login(first);
          for (const [target, direction, status] of [
            [low, 'outgoing', 'blocked_by_you'],
            [zero, 'incoming', 'unavailable'],
          ] as const) {
            const listing = mount();
            await settled(listing);
            assert.ok(
              listing.data.items.some(
                (item) => item.profileId === target.profileId,
              ),
            );
            // Mutate only synthetic fixture evidence after the list snapshot.
            // The old card is not proof of authorization at the destination.
            await block(
              direction === 'outgoing' ? first.accountId : target.accountId,
              direction === 'outgoing' ? target.accountId : first.accountId,
              direction === 'outgoing' ? target.profileId : ownProfile,
            );
            const before = await snapshot();
            listing.onProfile({
              currentTarget: { dataset: { profileId: target.profileId } },
            });
            const destination = navigations.at(-1)!;
            assert.equal(
              destination,
              `/pages/public-profile/public-profile?profileId=${target.profileId}`,
            );
            close(listing);
            const profileId = new URL(
              destination,
              nativeOrigin,
            ).searchParams.get('profileId');
            assert.equal(profileId, target.profileId);
            allowedProfilePath = `/v1/profiles/${profileId}`;
            profilePaths.add(allowedProfilePath);
            profileReply = undefined;
            const count = bridge.exchanges.length;
            let registered: ProfilePage | undefined;
            globals['Page'] = (value: ProfilePage) => {
              registered = value;
            };
            const entry = `${dist}pages/public-profile/public-profile.js`;
            delete require.cache[require.resolve(entry)];
            require(entry);
            assert.ok(
              registered,
              'Capture the real emitted public-profile Page',
            );
            const profile = registered as ProfilePage;
            profile.setData = (patch, callback) => {
              profile.data = { ...profile.data, ...patch };
              callback?.();
            };
            profilePages.add(profile);
            try {
              profile.onLoad({ profileId: target.profileId });
              profile.onShow();
              await bridge.idle();
              assert.equal(profile.data.busy, false, profile.data.error);
              assert.equal(profile.data.loaded, true, profile.data.error);
              assert.equal(profile.data.profile?.status, status);
              assert.deepEqual(profile.data.profile, profileReply);
              assert.deepEqual(profile.data.items, []);
              assert.ok(
                !JSON.stringify(profile.data.profile).includes(
                  'experienceDisplay',
                ),
              );
              assert.ok(
                !JSON.stringify(profile.data.profile).includes(
                  target.accountId,
                ),
              );
              assert.deepEqual(
                bridge.exchanges.slice(count),
                [
                  {
                    path: allowedProfilePath,
                    method: 'GET',
                    authorized: true,
                    status: 200,
                  },
                ],
                'Only a fresh exact-target HTTP authorization read; no avatar or content prefetch',
              );
              assert.deepEqual(await snapshot(), before);
            } finally {
              profile.onHide();
              profile.onUnload();
              profilePages.delete(profile);
              allowedProfilePath = null;
            }
          }
          app.identity.sessions.logout();
        },
      );

      await t.test(
        'real delayed HTTP cancellation, hide and unload cannot repopulate cleared items',
        async () => {
          for (const action of ['cancel', 'hide', 'unload'] as const) {
            const page = mount();
            await settled(page);
            const held = bridge.holdNext(rankingPath);
            releases.push(held.release);
            page.onRefresh();
            await held.arrived;
            const navigationCount = navigations.length;
            page.onProfile({
              currentTarget: { dataset: { profileId: high.profileId } },
            });
            assert.equal(
              navigations.length,
              navigationCount,
              'Refreshing entries cannot navigate',
            );
            if (action === 'cancel') page.onCancel();
            else if (action === 'hide') page.onHide();
            else {
              page.onUnload();
              pages.delete(page);
            }
            held.release();
            assert.deepEqual(page.data.items, []);
            await bridge.idle();
            assert.deepEqual(page.data.items, []);
            if (action !== 'unload') close(page);
          }
        },
      );

      await t.test(
        'revoked signed session errors without a guest fallback',
        async () => {
          const rejected = await createRuntimeActor(server!);
          await pool.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
            [rejected.sessionId],
          );
          login(rejected);
          const before = await snapshot(),
            count = bridge.exchanges.length;
          const page = mount();
          await bridge.idle();
          assert.equal(page.data.loaded, false);
          assert.deepEqual(page.data.items, []);
          assert.ok(page.data.error);
          const reads = bridge.exchanges.slice(count);
          assert.equal(reads.length, 1);
          assert.equal(reads[0]!.authorized, true);
          assert.ok([401, 403].includes(reads[0]!.status));
          close(page);
          assert.deepEqual(await snapshot(), before);
          app.identity.sessions.logout();
        },
      );

      await t.test(
        'native default request caps accepted results at 50',
        async () => {
          const visible = [];
          for (let index = 0; index < 51; index++)
            visible.push(await seed(10000n + BigInt(index)));
          const before = await snapshot();
          const page = mount();
          await settled(page);
          assert.equal(page.data.items.length, 50);
          assert.equal(replies.at(-1)!.selectionStatus, 'limit_reached');
          assert.deepEqual(
            page.data.items.map((item) => item.profileId),
            visible
              .reverse()
              .slice(0, 50)
              .map((item) => item.profileId),
          );
          close(page);
          assert.deepEqual(await snapshot(), before);
        },
      );

      await t.test(
        '257 higher profileless candidates return honest empty scan_limited instead of fabricating an exhausted population',
        async () => {
          for (let index = 0; index < 257; index++)
            await seed(1000000n + BigInt(index), false);
          const before = await snapshot();
          const page = mount();
          await settled(page);
          assert.deepEqual(page.data.items, []);
          assert.equal(replies.at(-1)!.selectionStatus, 'scan_limited');
          assert.equal(page.data.selectionStatus, 'scan_limited');
          close(page);
          assert.deepEqual(await snapshot(), before);
        },
      );
      const registration = JSON.parse(
        readFileSync(`${dist}app.json`, 'utf8'),
      ) as { pages: string[] };
      assert.ok(
        registration.pages.includes(
          'pages/experience-ranking/experience-ranking',
        ),
      );
      const template = readFileSync(
        `${dist}pages/experience-ranking/experience-ranking.wxml`,
        'utf8',
      );
      for (const handler of ['onRefresh', 'onCancel', 'onProfile'])
        assert.ok(template.includes(`bindtap="${handler}"`));
      assert.ok(
        bridge.exchanges.every(
          (exchange) =>
            exchange.method === 'GET' &&
            (exchange.path === `${rankingPath}?limit=50` ||
              profilePaths.has(exchange.path)),
        ),
      );
    } finally {
      for (const release of releases) release();
      for (const page of pages) {
        page.onHide();
        page.onUnload();
      }
      for (const page of profilePages) {
        page.onHide();
        page.onUnload();
      }
      native?.onHide();
      await transport?.idle();
      emittedConfig.clientConfiguration = previousConfig;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globals[key];
        else globals[key] = value;
      }
      try {
        await server?.close();
      } finally {
        try {
          if (owns)
            for (const schema of migrationSchemaNames)
              await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          if (locked)
            await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
              MIGRATION_LOCK[0],
              2,
            ]);
          suite?.release();
          await pool.end();
        }
      }
    }
  },
);
