import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
  discoveryScopeHash,
} from '../../src/community/discovery-cursors.js';
import { DatabaseService } from '../../src/database/database.js';
import type { PostView } from '../../src/community/contracts.js';
import { categorySchema } from '../../src/community/contracts.js';
import {
  setRuntimeVerification,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  approveEnvelope,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import { searchHarness, ok, failure } from './search-fixtures.js';
import type { PrivateSearchPosition } from './search-fixtures.js';

const finalRows = 'WITH ORDINALITY AS r(viewer,author,bilateral,ordinality)';
const textOf = (value: unknown) => JSON.stringify(value);
const ids = (body: { items: PostView[] }) => body.items.map((item) => item.id);
const trading = {
  subtype: 'shuma' as const,
  price: '12.5',
  urgency: 'normal' as const,
  location: 'Synthetic location',
  contacts: { wechat: 'private-contact-needle', qq: '', phone: '' },
};
// All publication instants below are explicit facts of newly constructed
// synthetic records. The feature does not import or date unknown history.
const instant = (index: number) =>
  new Date(Date.UTC(2026, 9, 1) - index * 1000).toISOString();
function pageShape(
  body: { items: PostView[]; nextCursor: string | null; continuation: string },
  limit = 10,
) {
  assert.deepEqual(Object.keys(body).sort(), [
    'continuation',
    'items',
    'nextCursor',
  ]);
  assert.ok(body.items.length <= limit);
  assert.equal(new Set(ids(body)).size, body.items.length);
  if (
    ['end', 'login_required', 'phone_verification_required'].includes(
      body.continuation,
    )
  )
    assert.equal(body.nextCursor, null);
  else
    assert.match(
      body.nextCursor ?? '',
      /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,
    );
  if (body.continuation === 'more') assert.equal(body.items.length, limit);
  if (body.continuation === 'scan_pending')
    assert.ok(body.items.length < limit);
}

test(
  'explicit-space search: real authority, bounded structural traversal and privacy',
  { timeout: 300000 },
  async (t) => {
    const h = await searchHarness();
    try {
      await t.test(
        'strict HTTP query grammar, Unicode canonicalization and literal matching',
        async () => {
          const w = await h.world();
          const bodies = [
            '0',
            '100%_\\ literal',
            `quoted '<script>alert("x")</script>'`,
            '鲸鱼校园🙂',
            'CAFE café cafe\u0301',
            'İstanbul',
            'ΟΣ',
            'Straße',
            'line one\nline two',
            '  Keep raw outer spaces  ',
            'UpperCASE',
          ];
          const base = await w.envelope();
          const rows = await w.seed(
            bodies.length,
            (i) => ({ ...base, text: bodies[i]! }),
            { time: instant },
          );
          const cases: [string, number[]][] = [
            ['0', [0, 1]],
            ['%', [1]],
            ['_', [1]],
            ['\\', [1]],
            ['<script>', [2]],
            ["'", [2]],
            ['鲸鱼校园🙂', [3]],
            ['cafe', [4]],
            ['café', [4]],
            ['cafe\u0301', [4]],
            ['i\u0307STANBUL', [5]],
            ['σ', []],
            ['ος', [6]],
            ['οσ', []],
            ['SS', []],
            ['straße', [7]],
            ['line one\r\nline two', [8]],
            ['\u2003Keep raw outer spaces\u3000', [9]],
            ['uppercase', [10]],
          ];
          for (const [q, expected] of cases) {
            const result = await w.search({ q });
            ok(result);
            pageShape(result.body);
            assert.deepEqual(
              ids(result.body),
              expected.map((i) => rows[i]!.id),
              `literal query ${JSON.stringify(q)}`,
            );
            for (const item of result.body.items as PostView[])
              assert.equal(
                item.text,
                bodies[rows.findIndex((row) => row.id === item.id)],
              );
          }
          const accent = await w.seed(1, () => ({ ...base, text: 'é' }), {
            time: () => instant(30),
          });
          assert.ok(
            !ids((await w.search({ q: 'e\u0301' })).body).includes(
              accent[0]!.id,
            ),
            'No normalization',
          );
          for (const query of [
            { q: '' },
            { q: '  \u3000' },
            { q: 'a'.repeat(201) },
            { q: '🙂'.repeat(201) },
            { q: 'bad\u0000' },
            { q: 'bad\u007f' },
            { q: 'bad\u0085' },
            { q: 'bad\r' },
            { limit: '0' },
            { limit: '11' },
            { limit: '01' },
            { limit: '1.0' },
            { limit: '-1' },
            { limit: '1e0' },
            { limit: ' 1' },
            { category: 'unsupported' },
            { tradingSubtype: 'shuma' },
            { category: 'discussion', tradingSubtype: 'shuma' },
            { category: 'trading', tradingSubtype: 'unsupported' },
            { spaceId: 'invalid' },
            { cursor: 'x' },
            { cursor: randomBytes(32).toString('base64url') + '=' },
            { unexpected: 'value' },
            { total: '1' },
          ])
            failure(await w.search(query), 400);
          for (const suffix of [
            '&q=second',
            '&limit=1&limit=2',
            '&spaceId=' + w.scope.home.spaceId,
            '&q%5B%5D=x',
            '&category%5Bbad%5D=discussion',
          ]) {
            const result = await request(h.http).get(
              `/v1/community/search?spaceId=${w.scope.home.spaceId}&q=needle${suffix}`,
            );
            failure(result, 400);
          }
          for (const q of ['🙂'.repeat(200), 'a'.repeat(200)])
            ok(await w.search({ q }));
          failure(
            await request(h.http)
              .get('/v1/community/search')
              .query({ q: 'needle' }),
            400,
          );
          failure(
            await request(h.http)
              .get('/v1/community/search')
              .query({ spaceId: w.scope.home.spaceId }),
            400,
          );
        },
      );

      await t.test(
        'regional/global and category rules preserve urgent and resolved trading semantics',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'needle' });
          const local = await w.seed(1, () => base);
          const relatedAuthor = await w.actor(w.scope.related),
            foreignAuthor = await w.actor(w.scope.foreign);
          const related = await w.publish(
            { spaceId: w.scope.related.spaceId, text: 'needle related' },
            relatedAuthor,
          );
          const foreign = await w.publish(
            { spaceId: w.scope.foreign.spaceId, text: 'needle foreign' },
            foreignAuthor,
          );
          const global = await w.publish({
            spaceId: w.scope.global.spaceId,
            text: 'needle global',
          });
          assert.deepEqual(ids((await w.search()).body), [local[0]!.id]);
          assert.deepEqual(
            ids((await w.search({ spaceId: w.scope.related.spaceId })).body),
            [related.id],
          );
          assert.deepEqual(
            ids((await w.search({ spaceId: w.scope.foreign.spaceId })).body),
            [foreign.id],
            'Foreign regional read is not constrained by publication identity',
          );
          assert.deepEqual(
            ids((await w.search({ spaceId: w.scope.global.spaceId })).body),
            [global.id],
          );
          assert.deepEqual(
            ids(
              (
                await w.search({
                  spaceId: w.scope.global.spaceId,
                  category: 'discussion',
                })
              ).body,
            ),
            [global.id],
          );
          for (const category of categorySchema.options.filter(
            (value) => value !== 'discussion',
          ))
            failure(
              await w.search({ spaceId: w.scope.global.spaceId, category }),
              400,
            );
          const normal = await w.publish({
            category: 'trading',
            text: 'needle normal',
            trading,
          });
          const urgent = await w.publish({
            category: 'trading',
            text: 'needle urgent',
            trading: { ...trading, urgency: 'urgent' },
          });
          const subtype = await w.publish({
            category: 'trading',
            text: 'needle bicycle',
            trading: { ...trading, subtype: 'zixingche' },
          });
          const resolved = await request(h.http)
            .post(`/v1/community/posts/${normal.id}/trading/resolution`)
            .set('Authorization', `Bearer ${w.author.accessToken}`)
            .send({ clientRequestId: randomUUID(), resolution: 'resolved' });
          assert.equal(resolved.status, 201, textOf(resolved.body));
          assert.equal(resolved.body.outcome, 'applied');
          const aggregate = await w.search();
          ok(aggregate);
          assert.deepEqual(
            new Set(ids(aggregate.body)),
            new Set([local[0]!.id, normal.id, subtype.id]),
          );
          const explicit = await w.search({ category: 'trading' });
          ok(explicit);
          assert.deepEqual(
            new Set(ids(explicit.body)),
            new Set([normal.id, urgent.id, subtype.id]),
          );
          assert.equal(
            explicit.body.items.find((item: PostView) => item.id === normal.id)
              .trading.resolution,
            'resolved',
          );
          assert.deepEqual(
            new Set(
              ids(
                (
                  await w.search({
                    category: 'trading',
                    tradingSubtype: 'shuma',
                  })
                ).body,
              ),
            ),
            new Set([normal.id, urgent.id]),
          );
          assert.deepEqual(
            ids((await w.search({ q: 'private-contact-needle' })).body),
            [],
            'Contacts never participate',
          );
          for (const category of categorySchema.options.filter(
            (value) => value !== 'trading',
          )) {
            const envelope = await w.envelope({
              category,
              text: `category marker ${category}`,
            });
            const [post] = await w.seed(1, () => envelope);
            assert.deepEqual(
              ids(
                (await w.search({ q: `category marker ${category}`, category }))
                  .body,
              ),
              [post!.id],
            );
          }
          failure(
            await w.search({ spaceId: randomUUID() }),
            409,
            'COMMUNITY_SCOPE_UNAVAILABLE',
          );
          await h.mutate((tx) =>
            tx.query(
              'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
              [w.scope.home.spaceId],
            ),
          );
          failure(await w.search(), 409, 'COMMUNITY_SCOPE_UNAVAILABLE');
          await h.mutate(async (tx) => {
            await tx.query(
              'UPDATE whaleu_community.spaces SET is_active=true WHERE id=$1',
              [w.scope.home.spaceId],
            );
            await tx.query(
              'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
              [w.scope.home.regionId],
            );
          });
          failure(await w.search(), 409, 'COMMUNITY_SCOPE_UNAVAILABLE');
        },
      );

      await t.test(
        'canonical visibility precedes matching; lists retain reverse-only blocks, anonymous and self posts',
        async () => {
          const w = await h.world(),
            blocked = await w.actor(),
            reverse = await w.actor();
          const visible = await w.envelope({ text: 'needle visible' });
          const blockedEnvelope = await w.envelope(
            { text: 'needle blocked' },
            blocked,
          );
          const reverseEnvelope = await w.envelope(
            { text: 'needle reverse' },
            reverse,
          );
          const selfEnvelope = await w.envelope(
            { text: 'needle self' },
            w.reader,
          );
          const definitions = [
            visible,
            visible,
            visible,
            visible,
            visible,
            blockedEnvelope,
            reverseEnvelope,
            {
              ...blockedEnvelope,
              authorMode: 'anonymous' as const,
              text: 'needle anonymous',
            },
            selfEnvelope,
          ];
          const rows = await w.seed(
            definitions.length,
            (i) => definitions[i]!,
            {
              time: instant,
              state: (i) => (i === 3 ? 'held' : i === 4 ? 'revoked' : 'allow'),
            },
          );
          await h.mutate(async (tx) => {
            await tx.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [rows[1]!.id],
            );
            await tx.query(
              'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
              [rows[2]!.id],
            );
          });
          await h.writeBlock(w.reader, blocked);
          await h.writeBlock(reverse, w.reader);
          const result = await w.search();
          ok(result);
          assert.deepEqual(
            ids(result.body),
            [0, 6, 7, 8].map((i) => rows[i]!.id),
          );
          const anonymous = result.body.items.find(
            (item: PostView) => item.id === rows[7]!.id,
          );
          assert.equal(anonymous.author.kind, 'anonymous');
          assert.equal(anonymous.author.profileId, undefined);
          assert.equal(
            result.body.items.find((item: PostView) => item.id === rows[8]!.id)
              .viewer.isSelf,
            true,
          );
          const detail = await request(h.http)
            .get(`/v1/community/posts/${rows[6]!.id}`)
            .set('Authorization', `Bearer ${w.reader.accessToken}`);
          failure(detail, 404, 'POST_NOT_FOUND');
          for (const forbidden of [
            w.author.accountId,
            w.reader.accountId,
            blocked.accountId,
            reverse.accountId,
            w.reader.sessionId,
            'private-contact-needle',
            'decisionId',
            'digest',
            'provenance',
            'scannedCount',
            'total',
          ])
            assert.equal(
              textOf(result.body).includes(forbidden),
              false,
              forbidden,
            );
          const malformed = randomUUID();
          await h.mutate((tx) =>
            tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at) VALUES($1,$2,$3,'discussion','does not contain the requested term','named','open',$4)",
              [
                malformed,
                w.scope.home.spaceId,
                w.author.accountId,
                instant(-1),
              ],
            ),
          );
          for (const q of ['needle', 'absent'])
            failure(await w.search({ q }), 503, 'COMMUNITY_UNAVAILABLE');
        },
      );

      await t.test(
        'separate approved fixture worlds have identical public pages and decoded structural successors under private body changes',
        async () => {
          for (const mode of ['hidden', 'held', 'blocked'] as const) {
            const outcomes: unknown[][] = [];
            for (const privateMatches of [false, true]) {
              const w = await h.world(),
                privateAuthor = await w.actor();
              const visible = await w.envelope({ text: 'needle public' });
              const privateEnvelope = await w.envelope(
                {
                  text: privateMatches
                    ? 'needle '.repeat(200)
                    : 'private unrelated body',
                },
                privateAuthor,
              );
              const prefix = randomUUID().slice(0, 24);
              const rows = await w.seed(
                260,
                (i) => (i === 0 || i === 259 ? visible : privateEnvelope),
                {
                  time: instant,
                  id: (i) => prefix + (1000 - i).toString(16).padStart(12, '0'),
                  state: (i) =>
                    mode === 'held' && i !== 0 && i !== 259 ? 'held' : 'allow',
                },
              );
              if (mode === 'hidden')
                await h.mutate((tx) =>
                  tx.query(
                    "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=ANY($1::uuid[])",
                    [rows.slice(1, -1).map((row) => row.id)],
                  ),
                );
              if (mode === 'blocked')
                await h.writeBlock(w.reader, privateAuthor);
              const replacements = new Map<string, string>([
                ...rows.map(
                  (row, i) => [row.id, `row:${i}`] as [string, string],
                ),
                [w.scope.home.spaceId, 'space'],
                [w.author.profileId, 'author-profile'],
                [w.reader.profileId, 'reader-profile'],
              ]);
              const normalize = (value: unknown) =>
                JSON.parse(
                  [...replacements].reduce(
                    (json, [from, to]) => json.replaceAll(from, to),
                    textOf(value),
                  ),
                ) as unknown;
              const pages: unknown[] = [];
              let cursor: string | undefined;
              do {
                const result = await w.search({
                  ...(cursor ? { cursor } : {}),
                });
                ok(result);
                pageShape(result.body);
                const coordinate = result.body.nextCursor
                  ? await h.position(result.body.nextCursor)
                  : null;
                pages.push(
                  normalize({ ...result.body, nextCursor: coordinate }),
                );
                if (mode !== 'hidden' && pages.length === 1) {
                  assert.equal(result.body.continuation, 'scan_pending');
                  assert.deepEqual(coordinate!.after, {
                    at: instant(127).replace('.000Z', '.000000Z'),
                    id: rows[127]!.id,
                  });
                  assert.equal(coordinate!.visible!.id, rows[0]!.id);
                }
                if (mode !== 'hidden' && pages.length === 2) {
                  assert.deepEqual(result.body.items, []);
                  assert.equal(result.body.continuation, 'scan_pending');
                  assert.equal(coordinate!.after.id, rows[255]!.id);
                  assert.equal(coordinate!.visible!.id, rows[0]!.id);
                }
                cursor = result.body.nextCursor ?? undefined;
                assert.ok(
                  pages.length <= 3,
                  'Bounded advancing traversal cannot loop',
                );
              } while (cursor);
              assert.equal(pages.length, mode === 'hidden' ? 1 : 3);
              outcomes.push(pages);
            }
            assert.deepEqual(
              outcomes[0],
              outcomes[1],
              `${mode} bodies cannot change any public field or private logical successor`,
            );
          }
        },
      );

      await t.test(
        'more than 1024 sparse rows are traversed in independent 128-row batches without private keyword SQL or off-page rendering',
        async () => {
          const w = await h.world(),
            base = await w.envelope();
          const rows = await w.seed(
            1100,
            (i) => ({
              ...base,
              text:
                i === 1099
                  ? 'needle last visible'
                  : 'ordinary nonmatching body',
            }),
            { time: instant },
          );
          let cursor: string | undefined,
            pages = 0,
            quotaLocked = false;
          const structural: { sql: string; rows: number; values: unknown[] }[] =
            [];
          h.observer.setHook(async (event) => {
            if (
              event.values.some(
                (value) =>
                  typeof value === 'string' &&
                  value.startsWith('whaleu:discovery:quota:v1:'),
              )
            )
              quotaLocked = true;
            if (quotaLocked)
              assert.equal(
                /FOR (?:SHARE|UPDATE)/i.test(event.sql),
                false,
                'No domain lock can follow cursor quota acquisition',
              );
            const mutatedOwner = event.sql.match(
              /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(whaleu_\w+\.\w+)/i,
            )?.[1];
            if (mutatedOwner)
              assert.equal(
                mutatedOwner,
                'whaleu_community.discovery_cursors',
                'Search has no history, reward, exposure or body write',
              );
            if (
              /LIMIT\s+129/i.test(event.sql) &&
              event.sql.includes('whaleu_community.posts')
            ) {
              structural.push(event);
              assert.ok(event.rows <= 129);
              assert.equal(
                /\b(?:ILIKE|LIKE|SIMILAR|text|wechat|qq|phone)\b/i.test(
                  event.sql.replaceAll('::text', ''),
                ),
                false,
                event.sql,
              );
              assert.equal(
                event.values.some(
                  (value) =>
                    typeof value === 'string' && value.includes('needle'),
                ),
                false,
              );
            }
            if (
              event.sql.includes('whaleu_profile.') &&
              event.sql.includes('WHERE')
            ) {
              assert.ok(
                pages >= 8,
                'Nonmatching cards must not resolve their public profile projection',
              );
            }
          });
          try {
            do {
              quotaLocked = false;
              const result = await w.search({ ...(cursor ? { cursor } : {}) });
              ok(result);
              pageShape(result.body);
              pages++;
              if (pages <= 8) {
                assert.deepEqual(result.body.items, []);
                assert.equal(result.body.continuation, 'scan_pending');
                assert.equal(
                  (await h.position(result.body.nextCursor)).after.id,
                  rows[pages * 128 - 1]!.id,
                );
              } else {
                assert.deepEqual(ids(result.body), [rows[1099]!.id]);
                assert.equal(result.body.continuation, 'end');
              }
              cursor = result.body.nextCursor ?? undefined;
              assert.ok(pages <= 9);
            } while (cursor);
          } finally {
            h.observer.setHook(null);
          }
          assert.equal(pages, 9);
          assert.ok(
            structural.length >= 18,
            'Candidate coordinates are re-read after parent locks',
          );
          const stored = await h.pool.query<{ text: string }>(
            'SELECT text FROM whaleu_community.posts WHERE id=$1',
            [rows[1099]!.id],
          );
          assert.equal(stored.rows[0]!.text, 'needle last visible');
        },
      );

      await t.test(
        'exact microsecond seeks, equal-time UUID ties, canonical query scopes and immutable input replay',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'needle' });
          const prefix = randomUUID().slice(0, 24);
          const times = [
            '2026-10-01T00:00:00.000999Z',
            '2026-10-01T00:00:00.000998Z',
            '2026-10-01T00:00:00.000998Z',
            '2026-10-01T00:00:00.000997Z',
          ];
          const rows = await w.seed(4, () => base, {
            time: (i) => times[i]!,
            id: (i) => prefix + (100 - i).toString(16).padStart(12, '0'),
          });
          const first = await w.search({ limit: '1', q: ' \u3000needle\t' });
          ok(first);
          pageShape(first.body, 1);
          assert.deepEqual(ids(first.body), [rows[0]!.id]);
          const firstPosition = await h.position(first.body.nextCursor);
          assert.deepEqual(firstPosition.after, {
            id: rows[0]!.id,
            at: times[0],
          });
          let cursor = first.body.nextCursor as string;
          const seen = [rows[0]!.id];
          for (let i = 1; i < rows.length; i++) {
            const result = await w.search({ limit: '1', cursor, q: 'needle' });
            ok(result);
            seen.push(...ids(result.body));
            if (result.body.nextCursor) {
              assert.equal(
                (await h.position(result.body.nextCursor)).after.at,
                times[i],
              );
              cursor = result.body.nextCursor;
            } else assert.equal(result.body.continuation, 'end');
          }
          assert.deepEqual(
            seen,
            rows.map((row) => row.id),
          );
          const replay = await w.search({
            limit: '1',
            cursor: first.body.nextCursor,
          });
          ok(replay);
          assert.deepEqual(ids(replay.body), [rows[1]!.id]);
          assert.deepEqual(
            await h.position(first.body.nextCursor),
            firstPosition,
            'Replay never mutates its input navigation record',
          );
          for (const patch of [
            { q: 'Needle' },
            { q: 'different' },
            { limit: '2' },
            { category: 'discussion' },
            { spaceId: w.scope.global.spaceId },
          ])
            failure(
              await w.search({
                limit: '1',
                cursor: first.body.nextCursor,
                ...patch,
              }),
              400,
            );
          const other = await w.actor();
          failure(
            await w.search(
              { limit: '1', cursor: first.body.nextCursor },
              other,
            ),
            400,
          );
          // Same account, different current session is a distinct scope, not a new user.
          const provider = (
            await h.pool.query<{
              provider: 'wechat';
              app_id: string;
              subject: string;
            }>(
              'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
              [w.reader.accountId],
            )
          ).rows[0]!;
          const token = mintToken('access'),
            refresh = mintToken('refresh');
          const nextSession = await h.app.get(IdentityRepository).createSession(
            {
              provider: provider.provider,
              appId: provider.app_id,
              subject: provider.subject,
            },
            { access: hashToken(token), refresh: hashToken(refresh) },
          );
          failure(
            await w.search(
              { limit: '1', cursor: first.body.nextCursor },
              { ...w.reader, ...nextSession, accessToken: token },
            ),
            400,
          );
          await setReviewState(h.pool, rows[0]!.decision, 'held');
          failure(
            await w.search({ limit: '1', cursor: first.body.nextCursor }),
            409,
            'DISCOVERY_RESTART_REQUIRED',
          );
        },
      );

      await t.test(
        'guest and phone continuation are current permission checks even for an empty first batch',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'no match' });
          await w.seed(130, () => base, { time: instant });
          const before = (
            await h.pool.query<{ n: number }>(
              'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
            )
          ).rows[0]!.n;
          const guest = await w.search({}, null);
          ok(guest);
          assert.deepEqual(guest.body, {
            items: [],
            nextCursor: null,
            continuation: 'login_required',
          });
          const unverified = await w.actor();
          await setRuntimeVerification(
            h.pool,
            unverified.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
            'verified',
            'unverified',
          );
          const first = await w.search({}, unverified);
          ok(first);
          assert.deepEqual(first.body, {
            items: [],
            nextCursor: null,
            continuation: 'phone_verification_required',
          });
          assert.equal(
            (
              await h.pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
              )
            ).rows[0]!.n,
            before,
            'No guest or unverified search cursors',
          );
          const initial = await w.search();
          ok(initial);
          assert.equal(initial.body.continuation, 'scan_pending');
          failure(
            await w.search({ cursor: initial.body.nextCursor }, null),
            401,
            'AUTHENTICATION_REQUIRED',
          );
          await setRuntimeVerification(
            h.pool,
            w.reader.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
            'verified',
            'unverified',
          );
          failure(
            await w.search({ cursor: initial.body.nextCursor }),
            403,
            'PHONE_VERIFICATION_REQUIRED',
          );
          await setRuntimeVerification(
            h.pool,
            w.reader.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
            'verified',
            'unavailable',
          );
          failure(await w.search(), 503, 'COMMUNITY_UNAVAILABLE');
          failure(
            await w.search({ cursor: initial.body.nextCursor }),
            503,
            'COMMUNITY_UNAVAILABLE',
          );
          await setRuntimeVerification(
            h.pool,
            w.reader.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
          );
          const restored = await w.search({ cursor: initial.body.nextCursor });
          ok(restored);
          assert.deepEqual(restored.body, {
            items: [],
            nextCursor: null,
            continuation: 'end',
          });
          for (const bearer of [
            'garbage',
            'Basic anything',
            'Bearer ' + mintToken('access'),
          ])
            failure(
              await request(h.http)
                .get('/v1/community/search')
                .query({ spaceId: w.scope.home.spaceId, q: 'needle' })
                .set('Authorization', bearer),
              401,
            );
          await h.pool.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
            [w.reader.sessionId],
          );
          failure(await w.search(), 401);
          await h.pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [unverified.accountId],
          );
          failure(await w.search({}, unverified), 403);
        },
      );

      await t.test(
        'evicted, expired and malformed stored cursors restart without relaxing immutable metadata guards',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'needle' });
          await w.seed(3, () => base, { time: instant });
          const first = await w.search({ limit: '1' });
          ok(first);
          const stored = (
            await h.pool.query<{
              scope_hash: string;
              bucket_hash: string;
              coordinate_hash: string;
              position: PrivateSearchPosition;
            }>(
              'SELECT scope_hash,bucket_hash,coordinate_hash,position FROM whaleu_community.discovery_cursors WHERE cursor=$1',
              [first.body.nextCursor],
            )
          ).rows[0]!;
          const expired = randomBytes(32).toString('base64url');
          await h.pool.query(
            'DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1',
            [first.body.nextCursor],
          );
          failure(
            await w.search({ limit: '1', cursor: first.body.nextCursor }),
            409,
            'DISCOVERY_RESTART_REQUIRED',
          );
          await h.pool.query(
            "INSERT INTO whaleu_community.discovery_cursors(cursor,scope_hash,bucket_hash,coordinate_hash,position,created_at,expires_at) SELECT $1,$2,$3,$4,$5,now-interval '25 hours',now-interval '1 hour' FROM (SELECT clock_timestamp() AS now) instant",
            [
              expired,
              stored.scope_hash,
              stored.bucket_hash,
              stored.coordinate_hash,
              stored.position,
            ],
          );
          failure(
            await w.search({ limit: '1', cursor: expired }),
            409,
            'DISCOVERY_RESTART_REQUIRED',
          );
          await h.pool.query(
            'DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1',
            [expired],
          );
          const repository = h.app.get(DiscoveryCursorRepository);
          for (const position of [
            { ...stored.position, kind: 'profile' },
            { ...stored.position, matcherId: 'obsolete-matcher' },
            {
              ...stored.position,
              after: {
                ...stored.position.after,
                at: '2026-10-01T00:00:00.000Z',
              },
            },
            {
              ...stored.position,
              after: {
                ...stored.position.after,
                at: '2026-10-02T00:00:00.000000Z',
              },
            },
            { ...stored.position, secret: 'not-permitted' },
          ]) {
            const cursor = await h.app
              .get(DatabaseService)
              .transaction((tx) =>
                repository.create(
                  stored.scope_hash,
                  discoveryCursorBucket(w.reader.accountId),
                  position,
                  tx,
                ),
              );
            failure(
              await w.search({ limit: '1', cursor }),
              409,
              'DISCOVERY_RESTART_REQUIRED',
            );
          }
          const wrongPurpose = await h.app
            .get(DatabaseService)
            .transaction((tx) =>
              repository.create(
                discoveryScopeHash(['not-search']),
                discoveryCursorBucket(w.reader.accountId),
                { ...stored.position },
                tx,
              ),
            );
          failure(await w.search({ limit: '1', cursor: wrongPurpose }), 400);
        },
      );

      await t.test(
        'comments, author names, private contacts and anonymous metadata do not create body matches',
        async () => {
          const w = await h.world();
          const post = await w.publish({ text: 'plain body' });
          const comment = {
            clientRequestId: randomUUID(),
            text: 'comment-only-needle',
            imageAssetIds: [],
            authorMode: 'named' as const,
          };
          await approveEnvelope(
            h.pool,
            await discussionApprovalEnvelope(
              h.app,
              h.pool,
              w.author.accountId,
              post.id,
              comment,
            ),
          );
          const created = await request(h.http)
            .post(`/v1/community/posts/${post.id}/comments`)
            .set('Authorization', `Bearer ${w.author.accessToken}`)
            .send(comment);
          assert.equal(created.status, 201, textOf(created.body));
          const profile = await request(h.http)
            .patch('/v1/me/profile')
            .set('Authorization', `Bearer ${w.author.accessToken}`)
            .send({ expectedRevision: 1, nickname: 'NameOnlyNeedle', bio: '' });
          ok(profile);
          await w.publish({ text: 'anonymous body', authorMode: 'anonymous' });
          await w.publish({
            category: 'trading',
            text: 'plain trade body',
            trading,
          });
          for (const q of [
            'comment-only-needle',
            'NameOnlyNeedle',
            'private-contact-needle',
            '匿名鲸鱼',
            w.author.accountId,
          ]) {
            const result = await w.search({ q });
            ok(result);
            assert.deepEqual(result.body.items, []);
            assert.equal(result.body.continuation, 'end');
          }
        },
      );

      await t.test(
        'mandatory final relationship proof rolls back already inserted cursors after raw INSERT and reactivation',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'needle protected' });
          await w.seed(3, () => base, { time: instant });
          let relation: string | undefined;
          for (const direction of [
            'outgoing',
            'incoming',
            'outgoing',
          ] as const) {
            let inserted = false,
              final = false;
            const before = (
              await h.pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
              )
            ).rows[0]!.n;
            h.observer.setHook(async (event) => {
              if (event.sql.includes(finalRows)) final = true;
              if (
                !inserted &&
                event.sql.includes(
                  'INSERT INTO whaleu_community.discovery_cursors',
                )
              ) {
                inserted = true;
                relation = await h.writeBlock(
                  direction === 'outgoing' ? w.reader : w.author,
                  direction === 'outgoing' ? w.author : w.reader,
                  true,
                  relation,
                );
              }
            });
            try {
              const measured = await h.observer.measure(
                `search final ${direction}`,
                () =>
                  w.search({
                    limit: '1',
                    q: direction === 'incoming' ? 'protected' : 'needle',
                  }),
              );
              assert.deepEqual(measured.measurement.begins, ['read committed']);
              assert.equal(
                inserted,
                true,
                'Cross a real cursor insert, not a synthetic provider rejection',
              );
              assert.equal(
                final,
                true,
                'Search must explicitly enroll mandatory final named proof',
              );
              if (direction === 'outgoing') {
                failure(measured.value, 503, 'COMMUNITY_UNAVAILABLE');
                assert.equal(
                  (
                    await h.pool.query<{ n: number }>(
                      'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
                    )
                  ).rows[0]!.n,
                  before,
                  'Final rejection rolls back cursor storage',
                );
              } else ok(measured.value);
            } finally {
              h.observer.setHook(null);
            }
            await h.writeBlock(
              direction === 'outgoing' ? w.reader : w.author,
              direction === 'outgoing' ? w.author : w.reader,
              false,
              relation,
            );
            // Keep each direction's retained relation separate. Third pass reuses
            // the outgoing relation's genuine revision/event history.
            relation = (
              await h.pool.query<{ id: string }>(
                'SELECT id FROM whaleu_safety.blocks WHERE blocker_id=$1 AND blocked_id=$2',
                [w.reader.accountId, w.author.accountId],
              )
            ).rows[0]?.id;
            if (direction === 'outgoing') relation = undefined;
          }
        },
      );

      await t.test(
        'exact 128-row exhaustion and unread lookahead never consult a private peek body or review',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'unrelated body' });
          await w.seed(128, () => base, { time: instant });
          const exact = await w.search();
          ok(exact);
          assert.deepEqual(exact.body, {
            items: [],
            nextCursor: null,
            continuation: 'end',
          });
          const unread = randomUUID();
          await h.mutate((tx) =>
            tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at) VALUES($1,$2,$3,'discussion','needle unknown review','named','open',$4)",
              [unread, w.scope.home.spaceId, w.author.accountId, instant(128)],
            ),
          );
          const first = await w.search();
          ok(first);
          assert.equal(first.body.continuation, 'scan_pending');
          assert.deepEqual(first.body.items, []);
          assert.notEqual(
            (await h.position(first.body.nextCursor)).after.id,
            unread,
          );
          failure(
            await w.search({ cursor: first.body.nextCursor }),
            503,
            'COMMUNITY_UNAVAILABLE',
          );
        },
      );

      await t.test(
        'parent lock waits re-read visibility and fail closed on unheld structural additions',
        async () => {
          const waitForParent = async () => {
            for (let i = 0; i < 200; i++) {
              const value = await h.pool.query<{ waiting: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE '%FROM whaleu_community.posts WHERE id=$1 FOR SHARE%' AND wait_event_type='Lock') AS waiting",
              );
              if (value.rows[0]!.waiting) return;
              await sleep(5);
            }
            assert.fail('Search must wait on the real parent row lock');
          };
          for (const mode of ['hide', 'unheld'] as const) {
            const w = await h.world(),
              base = await w.envelope({ text: 'needle' });
            const rows = await w.seed(mode === 'hide' ? 3 : 130, () => base, {
              time: (i) => instant(mode === 'unheld' && i === 129 ? -1 : i),
            });
            if (mode === 'unheld')
              await h.mutate((tx) =>
                tx.query(
                  "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                  [rows[129]!.id],
                ),
              );
            const writer = await h.pool.connect();
            await writer.query('BEGIN');
            await writer.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [rows[0]!.id],
            );
            const pending = w.search({ limit: '1' }).then((result) => result);
            try {
              await waitForParent();
              if (mode === 'hide')
                await writer.query(
                  "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                  [rows[0]!.id],
                );
              else
                await writer.query(
                  "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
                  [rows[129]!.id],
                );
              await writer.query('COMMIT');
              const result = await pending;
              if (mode === 'hide') {
                ok(result);
                assert.deepEqual(ids(result.body), [rows[1]!.id]);
              } else failure(result, 503, 'COMMUNITY_UNAVAILABLE');
            } finally {
              await writer.query('ROLLBACK');
              writer.release();
              await pending;
            }
          }
        },
      );

      await t.test(
        'selected anonymous formations retain independent named-child final proofs and direct roster policy',
        async () => {
          const w = await h.world(),
            child = await w.actor();
          const formation = await w.publish({
            text: 'needle formation',
            authorMode: 'anonymous',
            component: {
              kind: 'formation',
              capacity: 20,
              theme: '合成组局',
              contacts: trading.contacts,
              contactSharing: 'members_v1',
            },
          });
          const joined = await request(h.http)
            .post(`/v1/community/posts/${formation.id}/formation/memberships`)
            .set('Authorization', `Bearer ${child.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              contacts: trading.contacts,
              contactSharing: 'members_v1',
            });
          assert.equal(joined.status, 201, textOf(joined.body));
          assert.equal(joined.body.outcome, 'created');
          const base = await w.envelope({ text: 'needle older' });
          await w.seed(2, () => base, { time: instant });
          const baseline = await w.search({ limit: '1' });
          ok(baseline);
          assert.equal(baseline.body.items[0].author.kind, 'anonymous');
          assert.ok(textOf(baseline.body).includes(child.profileId));
          assert.equal(
            textOf(baseline.body).includes(trading.contacts.wechat),
            false,
          );
          // A distinct query gives a new cursor insert for the finalization race.
          let crossed = false,
            relation: string | undefined,
            childProof = false;
          h.observer.setHook(async (event) => {
            if (
              event.sql.includes(finalRows) &&
              (event.values[1] as string[]).includes(child.accountId)
            )
              childProof = true;
            if (
              !crossed &&
              event.sql.includes(
                'INSERT INTO whaleu_community.discovery_cursors',
              )
            ) {
              crossed = true;
              relation = await h.writeBlock(w.reader, child);
            }
          });
          try {
            failure(
              await w.search({ limit: '1', q: 'formation' }),
              503,
              'COMMUNITY_UNAVAILABLE',
            );
            assert.equal(crossed, true);
            assert.equal(childProof, true);
          } finally {
            h.observer.setHook(null);
          }
          const hiddenChild = await w.search({ limit: '1' });
          ok(hiddenChild);
          assert.equal(
            textOf(hiddenChild.body).includes(child.profileId),
            false,
          );
          await h.writeBlock(w.reader, child, false, relation);
          // A named formation parent with only an incoming block remains a list
          // card, but its stronger direct-parent roster is omitted.
          const named = await w.publish({
            text: 'needle named formation',
            component: {
              kind: 'formation',
              capacity: 20,
              theme: '具名组局',
              contacts: trading.contacts,
              contactSharing: 'members_v1',
            },
          });
          await h.writeBlock(w.author, w.reader);
          const reverse = await w.search({ q: 'named formation' });
          ok(reverse);
          assert.deepEqual(ids(reverse.body), [named.id]);
          assert.deepEqual(reverse.body.items[0].component, { kind: 'none' });
        },
      );

      await t.test(
        'held raw block writer and final phone/session deadlines cannot publish a successor',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'needle' });
          await w.seed(260, () => base, { time: instant });
          const writer = await h.pool.connect();
          let inserted = false;
          h.observer.setHook(async (event) => {
            if (
              !inserted &&
              event.sql.includes(
                'INSERT INTO whaleu_community.discovery_cursors',
              )
            ) {
              inserted = true;
              await writer.query('BEGIN');
              await h.writeBlock(w.reader, w.author, true, undefined, writer);
            }
          });
          try {
            failure(await w.search({ limit: '1' }), 503, 'SAFETY_UNAVAILABLE');
            assert.equal(inserted, true);
          } finally {
            h.observer.setHook(null);
            await writer.query('ROLLBACK');
            writer.release();
          }
          for (const deadline of ['phone', 'session'] as const) {
            const expiresAt = new Date(Date.now() + 2500);
            if (deadline === 'phone')
              await setRuntimeVerification(
                h.pool,
                w.reader.accountId,
                w.scope.institutionId,
                w.scope.home.regionId,
                'verified',
                'verified',
                expiresAt,
              );
            else
              await h.pool.query(
                'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE token_hash=$1',
                [hashToken(w.reader.accessToken), expiresAt],
              );
            const before = (
              await h.pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
              )
            ).rows[0]!.n;
            let waited = false,
              cursorInserted = false;
            h.observer.setHook(async (event) => {
              if (
                event.sql.includes(
                  'INSERT INTO whaleu_community.discovery_cursors',
                )
              )
                cursorInserted = true;
              if (!waited && event.sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
                assert.equal(cursorInserted, true);
                waited = true;
                await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 75);
              }
            });
            try {
              const result = await w.search({
                limit: '1',
                q: deadline === 'phone' ? 'needle' : 'need',
              });
              assert.equal(
                waited,
                true,
                'Expire after would-be cursor creation',
              );
              failure(
                result,
                deadline === 'phone' ? 403 : 401,
                deadline === 'phone'
                  ? 'PHONE_VERIFICATION_REQUIRED'
                  : undefined,
              );
              assert.equal(
                (
                  await h.pool.query<{ n: number }>(
                    'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
                  )
                ).rows[0]!.n,
                before,
              );
            } finally {
              h.observer.setHook(null);
            }
            if (deadline === 'phone')
              await setRuntimeVerification(
                h.pool,
                w.reader.accountId,
                w.scope.institutionId,
                w.scope.home.regionId,
              );
          }
        },
      );
    } finally {
      await h.close();
    }
  },
);
