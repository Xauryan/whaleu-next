import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type { SearchHit } from '../../src/community/search/contracts.js';
import { categorySchema } from '../../src/community/contracts.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  approveEnvelope,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import { searchHarness, ok, failure } from './search-fixtures.js';
import {
  freshWorld,
  search,
  position,
  addSpace,
  addCatalog,
  pageShape,
  ids,
  instant,
  trading,
} from './federated-search-fixtures.js';

test(
  'federated search: real owner composition, strict scope and bounded private navigation',
  { timeout: 300000 },
  async (t) => {
    const h = await searchHarness();
    try {
      await t.test(
        'known empty catalogs, strict HTTP union and no caller inventory',
        async () => {
          for (const scope of ['all', 'regional', 'global']) {
            const result = await search(h, { scope });
            ok(result);
            assert.deepEqual(result.body, {
              effectiveTypes: ['post'],
              items: [],
              nextCursor: null,
              continuation: 'end',
            });
          }
          const w = await freshWorld(h);
          for (const query of [
            { scope: 'related' },
            { scope: 'ALL' },
            { scope: '' },
            { scope: 'all', category: 'discussion' },
            { scope: 'global', category: 'discussion' },
            { scope: 'all', spaceId: w.scope.home.spaceId },
            { scope: 'regional', tradingSubtype: 'shuma' },
            { scope: 'regional', category: 'pets', tradingSubtype: 'shuma' },
            {
              scope: 'regional',
              category: 'trading',
              tradingSubtype: 'unknown',
            },
            { scope: 'regional', category: 'rental' },
            { scope: 'all', campusId: w.scope.home.campusId },
            { scope: 'all', regionId: w.scope.home.regionId },
            { scope: 'all', spaceIds: [w.scope.home.spaceId] },
            { scope: 'all', membershipFingerprint: 'a'.repeat(64) },
            { scope: 'all', q: '' },
            { scope: 'all', q: 'x\u0000' },
            { scope: 'all', limit: '01' },
            { scope: 'all', cursor: 'x'.repeat(43) },
          ])
            failure(await w.aggregate(query), 400);
          for (const suffix of [
            '&scope=global',
            '&scope%5B%5D=all',
            '&category=discussion&category=pets',
            '&q=other',
            '&limit=1&limit=2',
          ])
            failure(
              await request(h.http).get(
                `/v1/community/search?scope=regional&q=needle${suffix}`,
              ),
              400,
            );
          failure(
            await request(h.http)
              .get('/v1/community/search')
              .query({ q: 'needle' }),
            400,
          );
          failure(
            await request(h.http)
              .get('/v1/community/search')
              .query({ scope: 'all' }),
            400,
          );
          failure(await search(h, {}, { accessToken: 'invalid' }), 401);
        },
      );

      await t.test(
        'all supported regional categories, multiple globals, urgent/resolved and browse-independent membership',
        async () => {
          const w = await freshWorld(h);
          const related = await w.actor(w.scope.related),
            foreign = await w.actor(w.scope.foreign);
          const extraGlobal = await addSpace(h);
          const definitions = [
            await w.envelope({ text: 'needle home' }),
            await w.envelope(
              { spaceId: w.scope.related.spaceId, text: 'needle related' },
              related,
            ),
            await w.envelope(
              { spaceId: w.scope.foreign.spaceId, text: 'needle foreign' },
              foreign,
            ),
            await w.envelope({
              spaceId: w.scope.global.spaceId,
              text: 'needle global one',
            }),
            await w.envelope({
              spaceId: extraGlobal.spaceId,
              text: 'needle global two',
            }),
            await w.envelope({
              category: 'trading',
              text: 'needle normal',
              trading,
            }),
            await w.envelope({
              category: 'trading',
              text: 'needle urgent',
              trading: { ...trading, urgency: 'urgent' },
            }),
            await w.envelope({
              category: 'trading',
              text: 'needle resolved',
              trading: { ...trading, subtype: 'yifu' },
            }),
          ];
          const rows = await w.seed(
            definitions.length,
            (i) => definitions[i]!,
            { time: instant },
          );
          await h.mutate(async (tx) => {
            await tx.query(
              "UPDATE whaleu_community.trading_listings SET resolution='resolved' WHERE post_id=$1",
              [rows[7]!.id],
            );
            // A second physical campus mapping is not a second source community.
            const campus = randomUUID();
            await tx.query(
              "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,'Synthetic duplicate physical campus','synthetic',true)",
              [campus, w.scope.institutionId],
            );
            await tx.query(
              'INSERT INTO whaleu_campus.campus_region_assignments(campus_id,operating_region_id) VALUES($1,$2)',
              [campus, w.scope.home.regionId],
            );
            // Read eligibility does not require an active physical browse directory.
            await tx.query(
              'DELETE FROM whaleu_campus.campus_region_assignments WHERE campus_id=$1',
              [w.scope.foreign.campusId],
            );
            await tx.query(
              'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
              [w.scope.foreign.campusId],
            );
            // Unsupported raw global population must be structurally excluded, even
            // with matching text and missing approval; it is not reclassified.
            await tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at) VALUES($1,$2,$3,'pets','needle unsupported global','named','open',$4)",
              [
                randomUUID(),
                extraGlobal.spaceId,
                w.author.accountId,
                instant(-1),
              ],
            );
          });
          for (const [query, expected] of [
            [{}, rows],
            [{ scope: 'regional' }, rows.filter((_, i) => i !== 3 && i !== 4)],
            [{ scope: 'global' }, rows.slice(3, 5)],
            [{ scope: 'regional', category: 'discussion' }, rows.slice(0, 3)],
            [{ scope: 'regional', category: 'trading' }, rows.slice(5)],
            [
              {
                scope: 'regional',
                category: 'trading',
                tradingSubtype: 'shuma',
              },
              rows.slice(5, 7),
            ],
          ] as const) {
            const result = await w.aggregate(query);
            ok(result);
            pageShape(result.body);
            assert.deepEqual(
              ids(result.body),
              expected.map((row) => row.id),
            );
            for (const item of result.body.items as SearchHit[]) {
              const source =
                definitions[
                  rows.findIndex((row) => row.id === item.contentId)
                ]!;
              assert.equal(
                item.space.id,
                source.spaceId,
                'Serialize actual source, never a representative space',
              );
            }
            assert.equal(
              JSON.stringify(result.body).includes(trading.contacts.wechat),
              false,
            );
          }
          const explicit = await w.search();
          ok(explicit);
          assert.deepEqual(
            ids(explicit.body),
            [rows[0]!.id, rows[5]!.id, rows[7]!.id],
            'Explicit no-category urgent exclusion remains unchanged',
          );
          const ordinary = categorySchema.options.filter(
            (category) => category !== 'trading' && category !== 'discussion',
          );
          for (const category of ordinary) {
            const base = await w.envelope({
              category,
              text: `needle ${category}`,
            });
            const row = (await w.seed(1, () => base))[0]!;
            const result = await w.aggregate({ scope: 'regional', category });
            ok(result);
            assert.deepEqual(ids(result.body), [row.id]);
          }
          await h.mutate((tx) =>
            tx.query(
              'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
              [w.scope.related.regionId],
            ),
          );
          const inactiveRegion = await w.aggregate({
            scope: 'regional',
            category: 'discussion',
          });
          ok(inactiveRegion);
          assert.deepEqual(ids(inactiveRegion.body), [
            rows[0]!.id,
            rows[2]!.id,
          ]);
          await h.mutate((tx) =>
            tx.query(
              'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
              [extraGlobal.spaceId],
            ),
          );
          assert.deepEqual(ids((await w.aggregate({ scope: 'global' })).body), [
            rows[3]!.id,
          ]);
        },
      );

      await t.test(
        'global microsecond chronology, UUID ties, immutable replay and scoped cursor intent',
        async () => {
          const w = await freshWorld(h),
            foreign = await w.actor(w.scope.foreign);
          const bases = [
            await w.envelope({ text: 'needle' }),
            await w.envelope({
              spaceId: w.scope.global.spaceId,
              text: 'needle',
            }),
            await w.envelope(
              { spaceId: w.scope.foreign.spaceId, text: 'needle' },
              foreign,
            ),
          ];
          const prefix = randomUUID().slice(0, 24);
          const times = [
            '2026-10-01T00:00:00.000999Z',
            '2026-10-01T00:00:00.000998Z',
            '2026-10-01T00:00:00.000998Z',
            '2026-10-01T00:00:00.000997Z',
            '2026-10-01T00:00:00.000001Z',
          ];
          const rows = await w.seed(
            times.length,
            (i) => bases[i % bases.length]!,
            {
              time: (i) => times[i]!,
              id: (i) => prefix + (100 - i).toString(16).padStart(12, '0'),
            },
          );
          const first = await w.aggregate({ limit: '1', q: ' \u3000needle\t' });
          ok(first);
          pageShape(first.body, 1);
          const original = await position(h, first.body.nextCursor);
          assert.deepEqual(original.after, {
            id: rows[0]!.id,
            kind: 'post',
            at: times[0],
          });
          let cursor = first.body.nextCursor as string;
          const seen = ids(first.body);
          for (let i = 1; i < rows.length; i++) {
            const result = await w.aggregate({ limit: '1', cursor });
            ok(result);
            pageShape(result.body, 1);
            seen.push(...ids(result.body));
            if (result.body.nextCursor) {
              cursor = result.body.nextCursor;
              assert.equal((await position(h, cursor)).after.at, times[i]);
            } else assert.equal(result.body.continuation, 'end');
          }
          assert.deepEqual(
            seen,
            rows.map((row) => row.id),
          );
          const replay = await w.aggregate({
            limit: '1',
            cursor: first.body.nextCursor,
          });
          ok(replay);
          assert.deepEqual(ids(replay.body), [rows[1]!.id]);
          assert.deepEqual(await position(h, first.body.nextCursor), original);
          for (const mismatch of [
            { scope: 'regional' },
            { scope: 'global' },
            { q: 'need' },
            { limit: '2' },
          ])
            failure(
              await w.aggregate({
                limit: '1',
                cursor: first.body.nextCursor,
                ...mismatch,
              }),
              400,
            );
          failure(
            await w.aggregate(
              { limit: '1', cursor: first.body.nextCursor },
              w.author,
            ),
            400,
          );
          failure(
            await w.search({ limit: '1', cursor: first.body.nextCursor }),
            400,
          );
          await setReviewState(h.pool, rows[0]!.decision, 'held');
          failure(
            await w.aggregate({ limit: '1', cursor: first.body.nextCursor }),
            409,
            'DISCOVERY_RESTART_REQUIRED',
          );
        },
      );

      await t.test(
        '0/1/127/128/129 globally bounded candidates and unread unknown-review lookahead',
        async () => {
          for (const count of [0, 1, 127, 128, 129]) {
            const w = await freshWorld(h);
            const bases = [
              await w.envelope({ text: 'ordinary nonmatch' }),
              await w.envelope({
                spaceId: w.scope.global.spaceId,
                text: 'ordinary nonmatch',
              }),
            ];
            const rows = await w.seed(count, (i) => bases[i % 2]!, {
              time: instant,
            });
            const result = await w.aggregate();
            ok(result);
            pageShape(result.body);
            assert.deepEqual(result.body.items, []);
            assert.equal(
              result.body.continuation,
              count <= 128 ? 'end' : 'scan_pending',
            );
            if (count === 129) {
              assert.equal(
                (await position(h, result.body.nextCursor)).after.id,
                rows[127]!.id,
              );
              const last = await w.aggregate({
                cursor: result.body.nextCursor,
              });
              ok(last);
              assert.equal(last.body.continuation, 'end');
            }
          }
          const w = await freshWorld(h),
            base = await w.envelope({ text: 'ordinary nonmatch' });
          await w.seed(128, () => base, { time: instant });
          const unread = randomUUID();
          await h.mutate((tx) =>
            tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at) VALUES($1,$2,$3,'discussion','needle unread unknown review','named','open',$4)",
              [
                unread,
                w.scope.global.spaceId,
                w.author.accountId,
                instant(128),
              ],
            ),
          );
          const first = await w.aggregate();
          ok(first);
          assert.equal(first.body.continuation, 'scan_pending');
          assert.notEqual(
            (await position(h, first.body.nextCursor)).after.id,
            unread,
          );
          failure(
            await w.aggregate({ cursor: first.body.nextCursor }),
            503,
            'COMMUNITY_UNAVAILABLE',
          );
          const absent = await w.aggregate({ q: 'absent' });
          ok(absent);
          assert.equal(absent.body.continuation, 'scan_pending');
          failure(
            await w.aggregate({ q: 'absent', cursor: absent.body.nextCursor }),
            503,
            'COMMUNITY_UNAVAILABLE',
          );
        },
      );

      await t.test(
        'multi-thousand catalog, complete bounded metadata chunks and one global 128-content budget',
        async () => {
          const w = await freshWorld(h);
          await addCatalog(h, 2053);
          const bases = [
            await w.envelope({ text: 'ordinary nonmatch' }),
            await w.envelope({
              spaceId: w.scope.global.spaceId,
              text: 'ordinary nonmatch',
            }),
          ];
          const rows = await w.seed(
            260,
            (i) => ({
              ...bases[i % 2]!,
              text: i === 259 ? 'needle final match' : 'ordinary nonmatch',
            }),
            { time: instant },
          );
          let pages = 0,
            quota = false,
            catalogBatches = 0,
            structuralReads = 0;
          h.observer.setHook(async (event) => {
            if (
              event.values.some(
                (value) =>
                  typeof value === 'string' &&
                  value.startsWith('whaleu:discovery:quota:v1:'),
              )
            )
              quota = true;
            if (quota)
              assert.equal(
                /FOR (?:SHARE|UPDATE)/i.test(event.sql),
                false,
                'Quota lock is the final domain-lock step',
              );
            if (
              /FROM whaleu_community.spaces/i.test(event.sql) &&
              /LIMIT\s+256/i.test(event.sql)
            ) {
              catalogBatches++;
              assert.ok(event.rows <= 256);
            }
            if (
              /LIMIT\s+129/i.test(event.sql) &&
              event.sql.includes('whaleu_community.posts')
            ) {
              structuralReads++;
              assert.ok(event.rows <= 129);
              assert.equal(
                /\b(?:ILIKE|LIKE|SIMILAR|text|wechat|qq|phone)\b/i.test(
                  event.sql.replaceAll('::text', ''),
                ),
                false,
                event.sql,
              );
              assert.equal(
                JSON.stringify(event.values).includes('needle'),
                false,
              );
            }
            if (
              event.sql.includes('whaleu_profile.') &&
              event.sql.includes('WHERE')
            )
              assert.ok(pages >= 2, 'Nonmatches are not serialized');
            const owner = event.sql.match(
              /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(whaleu_\w+\.\w+)/i,
            )?.[1];
            if (owner)
              assert.equal(owner, 'whaleu_community.discovery_cursors');
          });
          let cursor: string | undefined;
          try {
            do {
              quota = false;
              const result = await w.aggregate({
                ...(cursor ? { cursor } : {}),
              });
              ok(result);
              pageShape(result.body);
              pages++;
              if (pages <= 2) {
                assert.equal(result.body.continuation, 'scan_pending');
                assert.deepEqual(result.body.items, []);
                const value = await position(h, result.body.nextCursor);
                assert.equal(value.after.id, rows[pages * 128 - 1]!.id);
                assert.equal(value.visible, null);
              } else {
                assert.deepEqual(ids(result.body), [rows[259]!.id]);
                assert.equal(result.body.continuation, 'end');
              }
              cursor = result.body.nextCursor ?? undefined;
              assert.ok(pages <= 3);
            } while (cursor);
          } finally {
            h.observer.setHook(null);
          }
          assert.equal(pages, 3);
          assert.ok(
            catalogBatches >= 9 * pages,
            'Complete metadata enumeration on every request, not truncated first chunk',
          );
          assert.ok(
            structuralReads >= 2 * pages,
            'Global coordinates re-read after deterministic parent locks',
          );
        },
      );

      await t.test(
        'guest preview and current phone continuation without affiliation, identity selection or representative space',
        async () => {
          const w = await freshWorld(h),
            base = await w.envelope({ text: 'ordinary no match' });
          await w.seed(130, () => base, { time: instant });
          const reader = await createRuntimeActor(h.app);
          await setRuntimeVerification(
            h.pool,
            reader.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
            'unavailable',
            'verified',
          );
          h.observer.setHook(async (event) => {
            assert.equal(
              /community_identity_|community_topology_|campus_region_assignments|region_policy_revisions/.test(
                event.sql,
              ),
              false,
              'Aggregate navigation is not publication identity resolution',
            );
          });
          let cursor: string;
          try {
            const guest = await w.aggregate({}, null);
            ok(guest);
            assert.deepEqual(guest.body, {
              effectiveTypes: ['post'],
              items: [],
              nextCursor: null,
              continuation: 'login_required',
            });
            const verified = await w.aggregate({}, reader);
            ok(verified);
            assert.equal(verified.body.continuation, 'scan_pending');
            cursor = verified.body.nextCursor;
          } finally {
            h.observer.setHook(null);
          }
          await setRuntimeVerification(
            h.pool,
            reader.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
            'unavailable',
            'unverified',
          );
          const unverified = await w.aggregate({}, reader);
          ok(unverified);
          assert.deepEqual(unverified.body, {
            effectiveTypes: ['post'],
            items: [],
            nextCursor: null,
            continuation: 'phone_verification_required',
          });
          await h.mutate((tx) =>
            tx.query(
              'UPDATE whaleu_community.spaces SET is_active=false WHERE is_active',
            ),
          );
          failure(
            await w.aggregate({ cursor }, reader),
            403,
            'PHONE_VERIFICATION_REQUIRED',
          );
          await setRuntimeVerification(
            h.pool,
            reader.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
            'unavailable',
            'unavailable',
          );
          failure(
            await w.aggregate({ cursor }, reader),
            503,
            'COMMUNITY_UNAVAILABLE',
          );
          await setRuntimeVerification(
            h.pool,
            reader.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
            'unavailable',
            'verified',
          );
          failure(
            await w.aggregate({ cursor }, reader),
            409,
            'DISCOVERY_RESTART_REQUIRED',
          );
          const empty = await w.aggregate({}, reader);
          ok(empty);
          assert.deepEqual(empty.body, {
            effectiveTypes: ['post'],
            items: [],
            nextCursor: null,
            continuation: 'end',
          });
        },
      );

      await t.test(
        'denied body differential leaves public cards, consumed coordinates and carried guards unchanged across sources',
        async () => {
          for (const mode of [
            'hidden',
            'held',
            'revoked',
            'outgoing',
          ] as const) {
            const outcomes: unknown[][] = [];
            for (const privateMatches of [false, true]) {
              const w = await freshWorld(h),
                privateAuthor = await w.actor();
              const visible = await w.envelope({ text: 'needle public' });
              const hidden = await w.envelope(
                {
                  spaceId: w.scope.global.spaceId,
                  text: privateMatches
                    ? 'needle '.repeat(200)
                    : 'private unrelated body',
                },
                privateAuthor,
              );
              const prefix = randomUUID().slice(0, 24);
              const rows = await w.seed(
                260,
                (i) => (i === 0 || i === 259 ? visible : hidden),
                {
                  time: instant,
                  id: (i) => prefix + (1000 - i).toString(16).padStart(12, '0'),
                  state: (i) =>
                    i !== 0 &&
                    i !== 259 &&
                    (mode === 'held' || mode === 'revoked')
                      ? mode
                      : 'allow',
                },
              );
              if (mode === 'hidden')
                await h.mutate((tx) =>
                  tx.query(
                    "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=ANY($1::uuid[])",
                    [rows.slice(1, -1).map((row) => row.id)],
                  ),
                );
              if (mode === 'outgoing')
                await h.writeBlock(w.reader, privateAuthor);
              const replacements = new Map<string, string>([
                ...rows.map(
                  (row, i) => [row.id, `row:${i}`] as [string, string],
                ),
                [w.scope.home.spaceId, 'home-space'],
                [w.scope.global.spaceId, 'global-space'],
                [w.author.profileId, 'author-profile'],
                [w.reader.profileId, 'reader-profile'],
              ]);
              const normalize = (value: unknown) =>
                JSON.parse(
                  [...replacements].reduce(
                    (json, [from, to]) => json.replaceAll(from, to),
                    JSON.stringify(value),
                  ),
                ) as unknown;
              const pages: unknown[] = [];
              let cursor: string | undefined;
              do {
                const result = await w.aggregate({
                  ...(cursor ? { cursor } : {}),
                });
                ok(result);
                pageShape(result.body);
                const value = result.body.nextCursor
                  ? await position(h, result.body.nextCursor)
                  : null;
                pages.push(
                  normalize({
                    ...result.body,
                    nextCursor: value
                      ? {
                          ...value,
                          membershipFingerprint: 'equivalent-synthetic-catalog',
                        }
                      : null,
                  }),
                );
                if (mode !== 'hidden' && pages.length <= 2) {
                  assert.equal(result.body.continuation, 'scan_pending');
                  assert.equal(
                    value!.after.id,
                    rows[pages.length * 128 - 1]!.id,
                  );
                  assert.equal(value!.visible!.id, rows[0]!.id);
                  if (pages.length === 2)
                    assert.deepEqual(result.body.items, []);
                }
                cursor = result.body.nextCursor ?? undefined;
                assert.ok(pages.length <= 3);
              } while (cursor);
              assert.equal(pages.length, mode === 'hidden' ? 1 : 3);
              outcomes.push(pages);
            }
            assert.deepEqual(
              outcomes[0],
              outcomes[1],
              `${mode}: changing only synthetic denied bodies leaves logical output unchanged`,
            );
          }
        },
      );

      await t.test(
        'incoming named versus anonymous list policy and post-only type excludes comments',
        async () => {
          const w = await freshWorld(h);
          const named = await w.publish({
            spaceId: w.scope.global.spaceId,
            text: 'needle named',
          });
          const anonymous = await w.publish({
            text: 'needle anonymous',
            authorMode: 'anonymous',
          });
          await h.writeBlock(w.author, w.reader);
          const incoming = await w.aggregate();
          ok(incoming);
          assert.deepEqual(
            new Set(ids(incoming.body)),
            new Set([named.id, anonymous.id]),
          );
          await h.writeBlock(w.reader, w.author);
          const outgoing = await w.aggregate();
          ok(outgoing);
          assert.deepEqual(ids(outgoing.body), [anonymous.id]);
          assert.equal(
            JSON.stringify(outgoing.body).includes(w.author.accountId),
            false,
          );
          const comment = {
            clientRequestId: randomUUID(),
            text: 'comment-only-federated-needle',
            imageAssetIds: [],
            authorMode: 'anonymous' as const,
          };
          await approveEnvelope(
            h.pool,
            await discussionApprovalEnvelope(
              h.app,
              h.pool,
              w.author.accountId,
              anonymous.id,
              comment,
            ),
          );
          const created = await request(h.http)
            .post(`/v1/community/posts/${anonymous.id}/comments`)
            .set('Authorization', `Bearer ${w.author.accessToken}`)
            .send(comment);
          assert.equal(created.status, 201, JSON.stringify(created.body));
          const byComment = await w.aggregate({ q: comment.text });
          ok(byComment);
          assert.deepEqual(byComment.body.items, []);
        },
      );
    } finally {
      await h.close();
    }
  },
);
