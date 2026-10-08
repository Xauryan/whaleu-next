import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  seedDirectoryTaxonomy,
  seedDirectoryCatalog,
  syntheticDirectoryCategory,
  syntheticDirectoryEntry,
} from '../support/directory-catalog-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  directoryCategoryPageSchema,
  directoryEntryPageSchema,
  directoryDetailSchema,
} from '../../src/organizations/directory/contracts.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';

const encoded = (value: unknown) => JSON.stringify(value);
function privateFields(value: unknown, summary = false): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'account_id',
        'createdBy',
        'created_by_user_id',
        'approvedBy',
        'approved_by_user_id',
        'approvalSourceReference',
        'approval_source_reference',
        'source_id',
        'sourceId',
        'source_revision',
        'content_revision',
        'historical_visits',
        'role',
        'roles',
        'grants',
        'reference',
        'references',
        'url',
        'key',
        'isOwner',
        'canManage',
        ...(summary
          ? [
              'qqGroupNumber',
              'qq_number',
              'managers',
              'managerWechatImage',
              'linkedOfficialAccountQr',
            ]
          : []),
      ].includes(key),
      `Directory leaked ${key}`,
    );
    privateFields(child, summary);
  }
}
function success(response: Response) {
  assert.equal(response.status, 200, encoded(response.body));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['vary'], 'Authorization');
  privateFields(response.body);
  return response.body;
}
function failure(response: Response, code?: string) {
  assert.ok(response.status >= 400, encoded(response.body));
  assert.deepEqual(Object.keys(response.body), ['error']);
  if (code) assert.equal(response.body.error.code, code);
}

test(
  'directory accepted catalog read privacy, literal search, exact revision and bounded pages on PostgreSQL',
  { timeout: 180000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    const actor = await f.actor(),
      other = await f.actor({ campusId: f.scope.related.campusId });
    const region = f.scope.home.regionId,
      remote = f.scope.related.regionId;
    const path = (regionId = region) => `/v1/directory/regions/${regionId}`;
    const get = (endpoint: string, query: object = {}, who = actor) =>
      request(f.app.getHttpServer())
        .get(endpoint)
        .query(query)
        .set('Authorization', `Bearer ${who.accessToken}`);
    const categories = (kind: string, regionId = region, who = actor) =>
      get(`${path(regionId)}/categories`, { kind }, who);
    const entries = (query: object, regionId = region, who = actor) =>
      get(`${path(regionId)}/entries`, query, who);
    const detail = (id: string, regionId = region, who = actor) =>
      get(`${path(regionId)}/entries/${id}`, {}, who);
    const observer = observeDirectoryQueries(f.app);
    try {
      await t.test(
        'startup creates no directory facts or administrator grants',
        async () => {
          for (const table of [
            'directory_catalog_heads',
            'directory_catalog_revisions',
            'directory_taxonomy_heads',
            'directory_taxonomy_revisions',
            'directory_categories',
            'directory_entries',
          ])
            assert.equal(
              (
                await f.pool.query(
                  `SELECT 1 FROM whaleu_organizations.${table}`,
                )
              ).rowCount,
              0,
            );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_authorization.role_grants',
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'missing coverage is unavailable; separately accepted complete empty catalog is genuinely empty',
        async () => {
          failure(await categories('school'), 'DIRECTORY_UNAVAILABLE');
          const tax = await seedDirectoryTaxonomy(f.pool, region, 'school', []);
          failure(await categories('school'), 'DIRECTORY_UNAVAILABLE');
          await seedDirectoryCatalog(f.pool, region, 'school', tax, []);
          assert.deepEqual(success(await categories('school')), {
            items: [],
            continuation: 'end',
            nextCursor: null,
          });
          assert.deepEqual(
            success(await entries({ kind: 'school', q: '无记录' })),
            { items: [], continuation: 'end', nextCursor: null },
          );
          const draftTax = await seedDirectoryTaxonomy(
            f.pool,
            region,
            'org',
            [],
          );
          await seedDirectoryCatalog(f.pool, region, 'org', draftTax, [], {
            sealed: false,
          });
          failure(await categories('org'), 'DIRECTORY_UNAVAILABLE');
        },
      );
      await t.test(
        'category keyset uses numeric accepted ordinals across 9/10 and preserves server order on every page',
        async () => {
          const rows = Array.from({ length: 12 }, (_, ordinal) =>
            syntheticDirectoryCategory({ name: `分类 ${ordinal}`, ordinal }),
          );
          const taxonomy = await seedDirectoryTaxonomy(
            f.pool,
            region,
            'school',
            rows,
          );
          await seedDirectoryCatalog(f.pool, region, 'school', taxonomy, []);
          const found: string[] = [];
          let cursor: string | undefined;
          for (let i = 0; i < 3; i++) {
            const page = success(
              await get(`${path()}/categories`, {
                kind: 'school',
                limit: 5,
                ...(cursor ? { cursor } : {}),
              }),
            );
            directoryCategoryPageSchema.parse(page);
            found.push(...page.items.map((item: { id: string }) => item.id));
            cursor = page.nextCursor;
            if (i === 2) assert.equal(page.continuation, 'end');
          }
          assert.deepEqual(
            found,
            rows.map((row) => row.id),
          );
        },
      );
      const category = syntheticDirectoryCategory({
        name: '长名称不按新建约束截断的社团分类',
      });
      const secondCategory = syntheticDirectoryCategory({
        name: '第二分类',
        ordinal: 1,
      });
      const inactiveCategory = syntheticDirectoryCategory({
        name: '已停用',
        lifecycle: 'inactive',
        ordinal: 2,
      });
      const taxonomy = await seedDirectoryTaxonomy(f.pool, region, 'org', [
        category,
        secondCategory,
        inactiveCategory,
      ]);
      const records = Array.from({ length: 63 }, (_, index) =>
        syntheticDirectoryEntry(category.id, {
          name: `社团 ${String(index).padStart(3, '0')}`,
          ordinal: index,
          searchOrdinal: 1000 - index,
          badge:
            index % 3 === 0
              ? 'official'
              : index % 3 === 1
                ? 'partner'
                : 'normal',
          visits: index % 2 === 0 ? 7 : null,
        }),
      );
      const special = syntheticDirectoryEntry(secondCategory.id, {
        name: 'AbC 中文 100%_\\群',
        intro: '描述独有XYZ不得被搜索',
        ordinal: 100,
        searchOrdinal: 100,
        media: {
          avatar: {
            status: 'referenced',
            reference: 'https://private-media.invalid/avatar-secret',
          },
          mainQr: { status: 'referenced', reference: 'private/qr-secret' },
          managerWechatImage: { status: 'absent', reference: null },
          linkedOfficialAccountQr: {
            status: 'referenced',
            reference: 'private/linked-official-secret',
          },
          introImages: {
            status: 'known',
            references: ['private/gallery-secret'],
          },
        },
      });
      const noNumber = syntheticDirectoryEntry(secondCategory.id, {
        name: '无号码证据',
        ordinal: 101,
        searchOrdinal: 101,
        qqState: 'unknown',
        qqNumber: null,
        badgeState: 'unknown',
        badge: null,
      });
      const knownAbsent = syntheticDirectoryEntry(secondCategory.id, {
        name: '已知未提供号码',
        ordinal: 102,
        searchOrdinal: 102,
        qqNumber: null,
        visits: 0,
        media: {
          ...special.media,
          avatar: { status: 'absent', reference: null },
          mainQr: { status: 'absent', reference: null },
          introImages: { status: 'known', references: [] },
        },
      });
      const wechat = syntheticDirectoryEntry(secondCategory.id, {
        name: '微信平台',
        platform: 'wechat',
        qqState: 'not_applicable',
        qqNumber: null,
        ordinal: 103,
        searchOrdinal: 103,
        media: {
          ...special.media,
          managerWechatImage: {
            status: 'referenced',
            reference: 'private/manager-secret',
          },
        },
      });
      const hidden = (['pending', 'rejected', 'unknown'] as const).map(
        (state, index) =>
          syntheticDirectoryEntry(category.id, {
            name: `私有${state}`,
            state,
            provenance: state === 'unknown' ? 'unknown' : 'accepted',
            ordinal: 200 + index,
            searchOrdinal: 200 + index,
          }),
      );
      const untrusted = syntheticDirectoryEntry(category.id, {
        name: '审批证据缺失',
        provenance: 'unknown',
        ordinal: 203,
        searchOrdinal: 203,
      });
      const inactive = syntheticDirectoryEntry(inactiveCategory.id, {
        name: '停用分类条目',
        ordinal: 204,
        searchOrdinal: 204,
      });
      const all = [
        ...records,
        special,
        noNumber,
        knownAbsent,
        wechat,
        ...hidden,
        untrusted,
        inactive,
      ];
      const revision = await seedDirectoryCatalog(
        f.pool,
        region,
        'org',
        taxonomy,
        all,
      );
      await t.test(
        'strict category and list DTOs keep kind, platform and independent badge axes',
        async () => {
          const body = success(await categories('org'));
          directoryCategoryPageSchema.parse(body);
          assert.deepEqual(
            body.items.map((row: { id: string }) => row.id),
            [category.id, secondCategory.id],
          );
          assert.equal(body.items[0].name, category.name);
          const list = success(
            await entries({ kind: 'org', categoryId: category.id }),
          );
          directoryEntryPageSchema.parse(list);
          privateFields(list, true);
          assert.equal(list.items[0].kind, 'org');
          assert.equal(list.items[0].platform, 'qq');
          assert.deepEqual(list.items[0].badge, {
            status: 'known',
            value: 'official',
          });
          assert.ok(!encoded(list).includes(records[0]!.qqNumber!));
        },
      );
      await t.test(
        '63 accepted entries traverse accepted order beyond 50 with no duplication or hidden ceiling',
        async () => {
          const found: string[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const body = success(
              await entries({
                kind: 'org',
                categoryId: category.id,
                limit: 17,
                ...(cursor ? { cursor } : {}),
              }),
            );
            directoryEntryPageSchema.parse(body);
            found.push(...body.items.map((row: { id: string }) => row.id));
            if (body.continuation === 'end') {
              assert.equal(body.nextCursor, null);
              break;
            }
            assert.notEqual(body.nextCursor, cursor);
            cursor = body.nextCursor;
          }
          assert.deepEqual(
            found,
            records.map((row) => row.id),
          );
          assert.equal(new Set(found).size, 63);
          const search = success(
            await entries({ kind: 'org', q: '社团', limit: 50 }),
          );
          assert.deepEqual(
            search.items.map((row: { id: string }) => row.id),
            records
              .slice()
              .reverse()
              .slice(0, 50)
              .map((row) => row.id),
          );
          const tail = success(
            await entries({
              kind: 'org',
              q: '社团',
              limit: 50,
              cursor: search.nextCursor,
            }),
          );
          assert.equal(tail.items.length, 13);
          assert.equal(tail.continuation, 'end');
        },
      );
      await t.test(
        'trimmed Latin/Chinese and %, _, backslash name searches are literal and intro is never searched',
        async () => {
          for (const q of [
            'AbC',
            'abc',
            'ABC',
            '  中文  ',
            '%',
            '_',
            '\\',
            '100%_\\',
          ]) {
            const body = success(await entries({ kind: 'org', q }));
            assert.deepEqual(
              body.items.map((row: { id: string }) => row.id),
              [special.id],
            );
          }
          for (const q of [
            'zhongwen',
            '描述独有XYZ',
            '私有pending',
            '审批证据缺失',
          ])
            assert.deepEqual(
              success(await entries({ kind: 'org', q })).items,
              [],
            );
          assert.deepEqual(
            success(
              await entries({
                kind: 'org',
                categoryId: category.id,
                q: '中文',
              }),
            ).items,
            [],
          );
        },
      );
      await t.test(
        'QQ detail alone discloses exact digits; every unknown/absence/platform slot remains explicit and private',
        async () => {
          const body = success(await detail(special.id));
          directoryDetailSchema.parse(body);
          assert.deepEqual(body.qqGroupNumber, {
            status: 'known',
            value: special.qqNumber,
          });
          assert.equal(body.introText, special.intro);
          assert.equal(body.createdAt, null);
          assert.equal(body.updatedAt, null);
          for (const key of [
            'avatar',
            'mainQr',
            'linkedOfficialAccountQr',
            'visits',
          ])
            assert.deepEqual(body[key], { status: 'unavailable', value: null });
          assert.deepEqual(body.introImages, {
            status: 'unavailable',
            items: null,
          });
          assert.deepEqual(body.managers, {
            status: 'unavailable',
            items: null,
          });
          assert.deepEqual(body.management, { status: 'unavailable' });
          assert.ok(!encoded(body).includes('secret'));
          assert.ok(!encoded(body).includes('https://'));
          const unknown = success(await detail(noNumber.id));
          assert.deepEqual(unknown.qqGroupNumber, {
            status: 'unavailable',
            value: null,
          });
          assert.deepEqual(unknown.badge, {
            status: 'unavailable',
            value: null,
          });
          const absent = success(await detail(knownAbsent.id));
          assert.deepEqual(absent.visits, {
            status: 'unavailable',
            value: null,
          });
          assert.deepEqual(absent.qqGroupNumber, {
            status: 'known',
            value: null,
          });
          assert.deepEqual(absent.introImages, { status: 'known', items: [] });
          assert.deepEqual(absent.mainQr, { status: 'absent', value: null });
          const wx = success(await detail(wechat.id));
          assert.equal(wx.platform, 'wechat');
          assert.deepEqual(wx.qqGroupNumber, {
            status: 'not_applicable',
            value: null,
          });
          assert.deepEqual(wx.managerWechatImage, {
            status: 'unavailable',
            value: null,
          });
        },
      );
      await t.test(
        'private pending/rejected/unknown/untrusted/inactive targets are indistinguishable from missing detail',
        async () => {
          const missing = await detail(randomUUID());
          failure(missing);
          for (const row of [...hidden, untrusted, inactive]) {
            const result = await detail(row.id);
            failure(result);
            assert.equal(result.status, missing.status);
            assert.equal(result.body.error.code, missing.body.error.code);
          }
        },
      );
      await t.test(
        'strict request shapes reject body fields, unknown filters, kind/category mismatch and bounds',
        async () => {
          for (const query of [
            { kind: 'org' },
            { kind: 'org', q: '' },
            { kind: 'org', q: ' '.repeat(3) },
            { kind: 'org', q: '中'.repeat(101) },
            { kind: 'org', q: 'a', limit: 51 },
            { kind: 'org', q: 'a', limit: 0 },
            { kind: 'org', q: 'a', user_id: actor.accountId },
            { kind: 'org', q: 'a', approved: true },
            { kind: 'org', categoryId: randomUUID() },
            { kind: 'school', categoryId: category.id },
          ])
            failure(await entries(query));
          failure(
            await get(`${path()}/entries/${special.id}`, {
              role: 'super_admin',
            }),
          );
          failure(
            await get(`${path()}/entries`, {
              kind: 'org',
              categoryId: category.id,
            }).send({ admin: true }),
          );
          const unparsed = await get(`${path()}/entries`, {
            kind: 'org',
            categoryId: category.id,
          })
            .type('text')
            .send('private');
          failure(unparsed, 'BAD_REQUEST');
          assert.equal(unparsed.status, 400);
          failure(await get(`${path()}/entries/not-a-uuid`));
        },
      );
      await t.test(
        'sealed categories, entry rows and accepted revisions reject UPDATE, DELETE and late INSERT',
        async () => {
          for (const sql of [
            `UPDATE whaleu_organizations.directory_entries SET intro_text='changed' WHERE catalog_revision_id='${revision}'`,
            `DELETE FROM whaleu_organizations.directory_entries WHERE catalog_revision_id='${revision}'`,
            `INSERT INTO whaleu_organizations.directory_entries SELECT catalog_revision_id,taxonomy_revision_id,'${randomUUID()}'::uuid,category_id,content_revision,platform,name,intro_text,badge_state,badge,media,qq_state,qq_number,publication_state,approval_provenance,approved_content_revision,approval_source_reference,approval_policy_reference,source_created_at,source_updated_at,historical_visits,source_system,'new-source-id',source_revision,99999,99999 FROM whaleu_organizations.directory_entries WHERE catalog_revision_id='${revision}' LIMIT 1`,
            `UPDATE whaleu_organizations.directory_categories SET name='changed' WHERE taxonomy_revision_id='${taxonomy}'`,
            `DELETE FROM whaleu_organizations.directory_categories WHERE taxonomy_revision_id='${taxonomy}'`,
            `INSERT INTO whaleu_organizations.directory_categories SELECT taxonomy_revision_id,'${randomUUID()}'::uuid,name,description,accent,lifecycle,source_system,'new-category',source_revision,accepted_revision,99999 FROM whaleu_organizations.directory_categories WHERE taxonomy_revision_id='${taxonomy}' LIMIT 1`,
            `UPDATE whaleu_organizations.directory_catalog_revisions SET sealed=false WHERE id='${revision}'`,
          ])
            await assert.rejects(
              withCommunityScopeWriter(f.pool, (tx) => tx.query(sql)),
              /immutable/,
            );
          assert.equal(
            success(await detail(special.id)).introText,
            special.intro,
          );
        },
      );
      await t.test(
        'global official taxonomy is shared while region catalog, search, detail and QQ contact stay isolated',
        async () => {
          const officialCategory = syntheticDirectoryCategory({
            name: '官方分类',
          });
          const tax = await seedDirectoryTaxonomy(f.pool, region, 'official', [
            officialCategory,
          ]);
          const local = syntheticDirectoryEntry(officialCategory.id, {
            name: '本校订阅号',
            platform: 'official',
            qqState: 'not_applicable',
            qqNumber: null,
          });
          const foreign = syntheticDirectoryEntry(officialCategory.id, {
            name: '另一校官方分类QQ群',
            qqNumber: '009876543210',
          });
          await seedDirectoryCatalog(f.pool, region, 'official', tax, [local]);
          await seedDirectoryCatalog(f.pool, remote, 'official', tax, [
            foreign,
          ]);
          assert.deepEqual(
            success(await categories('official')).items,
            success(await categories('official', remote, other)).items,
          );
          assert.deepEqual(
            success(
              await entries({
                kind: 'official',
                categoryId: officialCategory.id,
              }),
            ).items.map((r: { id: string }) => r.id),
            [local.id],
          );
          assert.deepEqual(
            success(await entries({ kind: 'official', q: '群' })).items,
            [],
          );
          const own = success(await detail(local.id));
          directoryDetailSchema.parse(own);
          assert.deepEqual(own.linkedOfficialAccountQr, {
            status: 'not_applicable',
            value: null,
          });
          const theirs = success(await detail(foreign.id, remote, other));
          assert.equal(theirs.qqGroupNumber.value, foreign.qqNumber);
          failure(await detail(foreign.id));
          const foreignDetail = await detail(foreign.id, remote);
          failure(foreignDetail, 'DIRECTORY_NOT_FOUND');
          assert.equal(foreignDetail.status, 404);
          assert.equal(
            (
              await f.pool.query(
                "SELECT 1 FROM whaleu_campus.operating_regions WHERE name='999' OR id::text='999'",
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'all successful reads leave domain tables and sequences unchanged; derived request/cursor metadata is bounded',
        async () => {
          const before = await f.snapshot();
          const queries: string[] = [];
          observer.setHook(async ({ sql }) => {
            queries.push(sql);
          });
          try {
            success(await categories('org'));
            success(await entries({ kind: 'org', categoryId: category.id }));
            success(await entries({ kind: 'org', q: '%' }));
            success(await detail(special.id));
          } finally {
            observer.setHook(null);
          }
          assert.deepEqual(
            await f.snapshot(),
            before,
            'No visits, grants, notices, imports, sessions or media writes',
          );
          assert.ok(
            queries.every(
              (sql) =>
                !/^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER)/i.test(
                  sql,
                ) ||
                sql.includes('whaleu_community.discovery_cursors') ||
                sql.includes('whaleu_runtime.request_throttle_counters'),
            ),
          );
        },
      );
      await t.test(
        'cursor binds actor, category, normalized search and region and revision changes require explicit restart',
        async () => {
          const first = success(
            await entries({ kind: 'org', categoryId: category.id, limit: 10 }),
          );
          const provider = (
            await f.pool.query<{ app_id: string; subject: string }>(
              "SELECT app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1 AND provider='wechat'",
              [actor.accountId],
            )
          ).rows[0]!;
          const newAccess = mintToken('access'),
            newRefresh = mintToken('refresh');
          const secondSession = await f.app
            .get(IdentityRepository)
            .createSession(
              {
                provider: 'wechat',
                appId: provider.app_id,
                subject: provider.subject,
              },
              { access: hashToken(newAccess), refresh: hashToken(newRefresh) },
            );
          assert.equal(secondSession.accountId, actor.accountId);
          assert.notEqual(secondSession.sessionId, actor.sessionId);
          failure(
            await entries(
              {
                kind: 'org',
                categoryId: category.id,
                limit: 10,
                cursor: first.nextCursor,
              },
              region,
              { ...actor, ...secondSession, accessToken: newAccess },
            ),
            'DISCOVERY_RESTART_REQUIRED',
          );
          const sameHome = await f.actor();
          failure(
            await entries(
              {
                kind: 'org',
                categoryId: category.id,
                limit: 10,
                cursor: first.nextCursor,
              },
              region,
              sameHome,
            ),
          );
          failure(
            await entries({
              kind: 'org',
              categoryId: secondCategory.id,
              limit: 10,
              cursor: first.nextCursor,
            }),
          );
          failure(
            await entries({
              kind: 'org',
              q: '社团',
              limit: 10,
              cursor: first.nextCursor,
            }),
          );
          const next = [...all].map((row) => ({
            ...row,
            ordinal: row.ordinal + 1,
          }));
          next.push(
            syntheticDirectoryEntry(category.id, {
              name: '新收录',
              ordinal: 0,
              searchOrdinal: 9999,
            }),
          );
          await seedDirectoryCatalog(f.pool, region, 'org', taxonomy, next);
          failure(
            await entries({
              kind: 'org',
              categoryId: category.id,
              limit: 10,
              cursor: first.nextCursor,
            }),
            'DISCOVERY_RESTART_REQUIRED',
          );
          const fresh = success(
            await entries({ kind: 'org', categoryId: category.id }),
          );
          assert.equal(fresh.items[0].name, '新收录');
        },
      );
      await t.test(
        'expired and revoked ordinary navigation cursors fail explicitly instead of silently restarting',
        async () => {
          const query = { kind: 'org', categoryId: category.id, limit: 11 };
          const first = success(await entries(query));
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              `WITH prior AS (DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1 RETURNING *)
          INSERT INTO whaleu_community.discovery_cursors SELECT cursor,scope_hash,bucket_hash,coordinate_hash,position,created_at-interval '25 hours',expires_at-interval '25 hours' FROM prior`,
              [first.nextCursor],
            ),
          );
          failure(
            await entries({ ...query, cursor: first.nextCursor }),
            'DISCOVERY_RESTART_REQUIRED',
          );
          const fresh = success(await entries(query));
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1',
              [fresh.nextCursor],
            ),
          );
          failure(
            await entries({ ...query, cursor: fresh.nextCursor }),
            'DISCOVERY_RESTART_REQUIRED',
          );
        },
      );
      await t.test(
        'derived throttling and cursor storage retain no DTOs or contact and stay within bounded schema',
        async () => {
          const counters = (
            await f.pool.query<{ storage_key: string; total_hits: number }>(
              'SELECT storage_key,total_hits FROM whaleu_runtime.request_throttle_counters',
            )
          ).rows;
          assert.ok(counters.length > 0 && counters.length <= 3);
          for (const counter of counters) {
            assert.match(counter.storage_key, /^[a-f0-9]{64}$/);
            assert.ok(counter.total_hits > 0 && counter.total_hits <= 120);
          }
          const cursors = (
            await f.pool.query<{ position: Record<string, unknown> }>(
              'SELECT position FROM whaleu_community.discovery_cursors',
            )
          ).rows;
          assert.ok(cursors.length <= 256);
          for (const cursor of cursors)
            assert.deepEqual(Object.keys(cursor.position).sort(), [
              'after',
              'catalogRevision',
              'kind',
              'taxonomyRevision',
              'v',
            ]);
          assert.ok(!encoded(cursors).includes(special.qqNumber!));
        },
      );
    } finally {
      observer.restore();
      await f.close();
    }
  },
);
