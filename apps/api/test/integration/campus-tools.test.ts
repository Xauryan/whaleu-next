import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { IdentityService } from '../../src/identity/identity.service.js';
import { CampusToolsAdmission } from '../../src/campus-tools/admission.js';
import { runCampusToolsCli } from '../../src/campus-tools/cli.js';
import {
  campusToolsFixture,
  syntheticToolsCatalog,
  syntheticMapEntry,
} from '../support/campus-tools-fixture.js';
import { sealToolCatalog } from '../../src/campus-tools/contracts.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

test(
  'trusted runner admits real synthetic catalog and Media through current HTTP; no roles, legacy seed or guest downgrade',
  { timeout: 240000 },
  async (t) => {
    const f = await campusToolsFixture();
    t.after(() => f.close());
    const campusId = f.scope.home.campusId,
      base = `/v1/campuses/${campusId}/tools`,
      http = f.app.getHttpServer();
    assert.equal((await request(http).get(base)).body.state, 'unknown');
    const image = await f.image(),
      map = syntheticMapEntry();
    const catalog = syntheticToolsCatalog(campusId, {
      entries: [
        map,
        {
          id: randomUUID(),
          sourceId: 'shuttle',
          ordinal: 1,
          revision: randomUUID(),
          title: 'Synthetic shuttle',
          state: 'enabled',
          kind: 'shuttle',
          groups: [
            { id: 'bus', title: 'Bus', slots: [image] },
            { id: 'empty', title: 'Known empty group', slots: [] },
          ],
        },
        {
          id: randomUUID(),
          sourceId: 'research',
          ordinal: 2,
          revision: randomUUID(),
          title: 'Synthetic research',
          state: 'enabled',
          kind: 'research',
          description: 'Synthetic resource',
          compatibility: null,
          image: null,
          link: { action: 'copy', url: 'https://example.com/resource' },
        },
      ],
      linkPolicy: {
        id: randomUUID(),
        version: 1,
        rules: [
          { action: 'copy', host: 'example.com', path: '/resource', query: [] },
        ],
      },
    });
    const sealed = f.register(catalog),
      directory = await mkdtemp(join(tmpdir(), 'campus-tools-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'manifest.json');
    await writeFile(path, sealed.canonical);
    const before = (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_campus_tools.catalogs',
      )
    ).rows[0].n;
    assert.equal(
      ((await runCampusToolsCli(['validate', path])) as { state: string })
        .state,
      'candidate',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_campus_tools.catalogs',
        )
      ).rows[0].n,
      before,
    );
    await assert.rejects(
      runCampusToolsCli(['apply', path, randomUUID()]),
      /UNCONFIGURED/,
    );
    const key = randomUUID(),
      receipt = await runCampusToolsCli(['apply', path, key], {
        database: f.database,
        runtime: f.runtime,
      });
    assert.equal(f.processCalls(), 1);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_campus_tools.media_attempts',
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_campus_tools.media_results',
        )
      ).rows[0].n,
      1,
    );
    assert.deepEqual(await f.admission.apply(sealed.canonical, key), receipt);
    assert.equal(f.processCalls(), 1, 'historical replay does not reprocess');
    await assert.rejects(
      f.admission.apply(
        sealToolCatalog({ ...catalog, id: randomUUID() }).canonical,
        key,
      ),
    );
    const response = await request(http).get(base);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.state, 'ready');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.entries[2].link.state, 'available');
    assert.ok(!JSON.stringify(response.body).includes('https://'));
    const active = await f.actor();
    assert.equal(
      (
        await request(http)
          .get(base)
          .set('Authorization', `Bearer ${active.accessToken}`)
      ).status,
      200,
    );
    assert.equal(
      (await request(http).get(base).set('Authorization', 'Bearer invalid'))
        .status,
      401,
    );
    await f.app.get(IdentityService).logout(active.accessToken);
    assert.equal(
      (
        await request(http)
          .get(base)
          .set('Authorization', `Bearer ${active.accessToken}`)
      ).status,
      401,
    );
    assert.equal((await request(http).get(base)).body.state, 'ready');
    assert.equal(
      (await request(http).get(base).query({ url: 'https://evil.org' })).status,
      400,
    );
    assert.equal(
      (
        await request(http)
          .get(`${base}/${map.id}`)
          .query({ catalogId: randomUUID() })
      ).status,
      409,
    );
    const research = catalog.entries[2]!;
    const copied = await request(http)
      .get(`${base}/${research.id}/link`)
      .query({ catalogId: catalog.id, action: 'copy' });
    assert.equal(copied.status, 200);
    assert.equal(copied.body.url, 'https://example.com/resource');
    assert.notEqual(
      (
        await request(http)
          .get(`${base}/${research.id}/link`)
          .query({ catalogId: catalog.id, action: 'webview' })
      ).status,
      200,
    );
    const shuttle = catalog.entries[1]!,
      mediaPath = `/v3/media/campus-tools/${campusId}/${catalog.id}/${shuttle.id}/${image.bindingId}`;
    const descriptor = await request(http).get(mediaPath);
    assert.equal(descriptor.status, 200, JSON.stringify(descriptor.body));
    assert.equal(descriptor.body.manifestDigest, image.manifestDigest);
    assert.equal(
      (await request(http).get(`${mediaPath}/display-v1`)).status,
      200,
    );
    assert.equal(
      (
        await request(http)
          .get(`${mediaPath}/display-v1`)
          .set('Authorization', 'Bearer invalid')
      ).status,
      401,
    );
    assert.notEqual(
      (
        await request(http)
          .get(`${mediaPath}/display-v1`)
          .set('Range', 'bytes=0-10')
      ).status,
      200,
    );
    assert.notEqual(
      (
        await request(http).get(
          mediaPath.replace(campusId, f.scope.foreign.campusId),
        )
      ).status,
      200,
    );
    await assert.rejects(
      new CampusToolsAdmission(f.database, null).apply(
        sealed.canonical,
        randomUUID(),
      ),
    );
    await assert.rejects(
      f.pool.query(
        'UPDATE whaleu_campus_tools.catalogs SET digest=$2 WHERE id=$1',
        [catalog.id, 'b'.repeat(64)],
      ),
    );
    await assert.rejects(
      f.pool.query('DELETE FROM whaleu_campus_tools.heads WHERE campus_id=$1', [
        campusId,
      ]),
    );
    await assert.rejects(
      f.pool.query(
        'UPDATE whaleu_campus_tools.media_bindings SET entry_id=$2 WHERE id=$1',
        [image.bindingId, randomUUID()],
      ),
    );
    const empty = syntheticToolsCatalog(campusId, { expectedHead: catalog.id });
    await f.admit(empty);
    assert.equal((await request(http).get(base)).body.state, 'known_empty');
    assert.notEqual(
      (await request(http).get(`${mediaPath}/display-v1`)).status,
      200,
    );
    const notApplicable = syntheticToolsCatalog(campusId, {
      expectedHead: empty.id,
      applicability: 'not_applicable',
    });
    await f.admit(notApplicable);
    assert.equal((await request(http).get(base)).body.state, 'not_applicable');
    const withdrawn = syntheticToolsCatalog(campusId, {
      expectedHead: notApplicable.id,
      status: 'withdrawn',
    });
    await f.admit(withdrawn);
    assert.equal(
      (await request(http).get(base)).body.reason,
      'CATALOG_WITHDRAWN',
    );
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
        [campusId],
      ),
    );
    assert.notEqual((await request(http).get(base)).status, 200);
  },
);

test(
  'admission CAS, trusted scope, partial quarantine, rollback and immutable detached binding constraints',
  { timeout: 180000 },
  async (t) => {
    const f = await campusToolsFixture();
    t.after(() => f.close());
    const campus = f.scope.home.campusId;
    const a = syntheticToolsCatalog(campus),
      b = syntheticToolsCatalog(campus);
    f.register(a);
    f.register(b);
    const results = await Promise.allSettled([
      f.admission.apply(sealToolCatalog(a).canonical, randomUUID()),
      f.admission.apply(sealToolCatalog(b).canonical, randomUUID()),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    const head = (
      await f.pool.query(
        'SELECT catalog_id FROM whaleu_campus_tools.heads WHERE campus_id=$1',
        [campus],
      )
    ).rows[0].catalog_id;
    const partial = syntheticToolsCatalog(campus, {
      expectedHead: head,
      coverage: 'partial',
    });
    f.register(partial);
    await assert.rejects(
      f.admission.apply(sealToolCatalog(partial).canonical, randomUUID()),
    );
    const unknown = syntheticToolsCatalog(randomUUID());
    f.register(unknown);
    await assert.rejects(
      f.admission.apply(sealToolCatalog(unknown).canonical, randomUUID()),
    );
    const forged = syntheticToolsCatalog(campus, { expectedHead: head });
    await assert.rejects(
      f.admission.apply(sealToolCatalog(forged).canonical, randomUUID()),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_campus_tools.catalogs',
        )
      ).rows[0].n,
      1,
    );
    const bad = syntheticToolsCatalog(campus, {
      expectedHead: head,
      entries: [{ ...syntheticMapEntry(), state: 'disabled' }],
    });
    const accepted = f.register(bad);
    // A failure at the final head statement rolls back cause, catalog and receipt.
    const tx = f.database.transaction.bind(f.database);
    const original = f.database.transaction;
    f.database.transaction = (work, options) =>
      tx(async (client) => {
        const query = client.query;
        client.query = ((sql: unknown, ...args: unknown[]) => {
          if (
            typeof sql === 'string' &&
            sql.startsWith('UPDATE whaleu_campus_tools.heads')
          )
            throw new Error('synthetic final CAS failure');
          return Reflect.apply(query, client, [sql, ...args]);
        }) as typeof client.query;
        try {
          return await work(client);
        } finally {
          client.query = query;
        }
      }, options);
    try {
      await assert.rejects(f.admission.apply(accepted.canonical, randomUUID()));
    } finally {
      f.database.transaction = original;
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_campus_tools.catalogs',
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  'campus tools optional-auth routes deny a real causal access suspension rather than dropping credentials',
  { timeout: 240000 },
  async (t) => {
    const { accountAppealsFixture } =
      await import('../support/account-appeals-fixture.js');
    const f = await accountAppealsFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      subject = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const post = await f.publish(subject);
    await f.issue(admin, subject, post, 'access_suspension');
    const campus = f.scope.home.campusId,
      catalog = randomUUID(),
      entry = randomUUID(),
      binding = randomUUID();
    for (const path of [
      `/v1/campuses/${campus}/tools`,
      `/v1/campuses/${campus}/tools/${entry}?catalogId=${catalog}`,
      `/v1/campuses/${campus}/tools/${entry}/link?catalogId=${catalog}&action=copy`,
      `/v3/media/campus-tools/${campus}/${catalog}/${entry}/${binding}`,
      `/v3/media/campus-tools/${campus}/${catalog}/${entry}/${binding}/display-v1`,
    ]) {
      const response = await request(f.http)
        .get(path)
        .set('Authorization', `Bearer ${subject.accessToken}`);
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'SAFETY_ACCESS_SUSPENDED');
    }
    assert.equal(
      (await request(f.http).get(`/v1/campuses/${campus}/tools`)).body.state,
      'unknown',
    );
  },
);

test(
  'expired and policy-exempt catalogs remain distinct from unknown, empty and runtime-unavailable',
  { timeout: 180000 },
  async (t) => {
    const f = await campusToolsFixture();
    t.after(() => f.close());
    const campus = f.scope.home.campusId;
    const expiring = syntheticToolsCatalog(campus, {
      validity: {
        kind: 'finite',
        effectiveAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 1500).toISOString(),
      },
    });
    await f.admit(expiring);
    await f.pool.query('SELECT pg_sleep(1.6)');
    assert.equal((await f.tools.hub(null, campus)).state, 'expired');
    const exempt = syntheticToolsCatalog(campus, {
      expectedHead: expiring.id,
      validity: {
        kind: 'policy_exempt',
        effectiveAt: '2026-01-01T00:00:00Z',
        exemptionReference: 'synthetic-approved-no-expiry',
      },
    });
    const receipt = await f.admit(exempt);
    assert.equal((await f.tools.hub(null, campus)).state, 'known_empty');
    f.revoke(receipt.digest);
    assert.equal((await f.tools.hub(null, campus)).state, 'unavailable');
  },
);

test(
  'embedding requires independent trusted configuration and exact action policy; source copy never grants it',
  { timeout: 180000 },
  async (t) => {
    let enabled = true;
    const f = await campusToolsFixture({
      webview: {
        allows: (catalog, entryId) =>
          enabled &&
          catalog.entries.some(
            (e) =>
              e.id === entryId &&
              e.kind === 'web-link' &&
              e.link.url === 'https://tools.example.com/controlled',
          ),
      },
    });
    t.after(() => f.close());
    const campus = f.scope.home.campusId,
      entry = {
        id: randomUUID(),
        sourceId: 'web',
        ordinal: 0,
        revision: randomUUID(),
        title: 'Synthetic controlled tool',
        state: 'enabled' as const,
        kind: 'web-link' as const,
        link: {
          action: 'webview' as const,
          url: 'https://tools.example.com/controlled',
        },
      };
    const catalog = syntheticToolsCatalog(campus, {
      entries: [entry],
      linkPolicy: {
        id: randomUUID(),
        version: 1,
        rules: [
          {
            action: 'webview',
            host: 'tools.example.com',
            path: '/controlled',
            query: [],
          },
        ],
      },
    });
    await f.admit(catalog);
    const result = await f.tools.link(
      null,
      campus,
      entry.id,
      catalog.id,
      'webview',
    );
    assert.equal(result.state, 'ready');
    await assert.rejects(
      f.tools.link(null, campus, entry.id, catalog.id, 'copy'),
    );
    enabled = false;
    assert.equal(
      (await f.tools.link(null, campus, entry.id, catalog.id, 'webview')).state,
      'unavailable',
    );
  },
);

test(
  'misconfigured measured writer cannot substitute an unattempted object even when its manifest digest is source-accepted',
  { timeout: 180000 },
  async (t) => {
    const f = await campusToolsFixture();
    t.after(() => f.close());
    const campus = f.scope.home.campusId,
      image = await f.image();
    const catalog = syntheticToolsCatalog(campus, {
      entries: [
        {
          id: randomUUID(),
          sourceId: 'research',
          ordinal: 0,
          revision: randomUUID(),
          title: 'Synthetic',
          state: 'enabled',
          kind: 'research',
          description: 'Synthetic',
          compatibility: null,
          image,
          link: null,
        },
      ],
    });
    const sealed = f.register(catalog),
      originalStaging = await f.runtime.admission.staging(
        sealed.digest,
        image.assetId,
      ),
      planned = [f.storage.newObject(), f.storage.newObject()] as const;
    f.runtime.admission.staging = async () => ({
      ...originalStaging,
      destinations: planned,
    });
    const put = f.runtime.admission.put.bind(f.runtime.admission);
    f.runtime.admission.put = async (data, destination) => {
      const measured = await put(data, destination);
      const index = destination.key === planned[0].key ? 0 : 1;
      return { ...measured, object: originalStaging.destinations[index] };
    };
    await assert.rejects(f.admission.apply(sealed.canonical, randomUUID()));
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_campus_tools.media_attempts',
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_campus_tools.media_results',
        )
      ).rows[0].n,
      0,
    );
    assert.equal((await f.tools.hub(null, campus)).state, 'unknown');
  },
);
