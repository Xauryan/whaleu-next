import 'reflect-metadata';
import { closeBrowserResources } from '../support/browser-test-diagnostics.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { listeningFixtureOrigin } from '../support/browser-test-fixtures.js';
import { createPromotionFixture } from './support/rating-group-promotion.js';
import {
  promotionBrowserBridgeScript,
  startPromotionBrowser,
} from '../support/rating-group-operator-browser.js';

/** Real Chromium DOM/events/fetch -> emitted shell -> real AppModule/PG ->
 * synthetic worker. Does not certify real provider delivery or mobile rendering.
 * The integrated build and controlled PostgreSQL runner are prerequisites.
 */
test(
  'rating promotion emitted operator recovers original opaque intent through real browser HTTP/PG and preserves exact normal/test audiences',
  { timeout: 240000 },
  async (t) => {
    console.log('[browser-fixture] rating: acquiring');
    const f = await createPromotionFixture({ emittedOperator: true });
    console.log('[browser-fixture] rating: acquired');
    let ownedBrowser:
      Awaited<ReturnType<typeof startPromotionBrowser>> | undefined;
    t.after(() =>
      closeBrowserResources([
        ...(ownedBrowser
          ? [['rating-browser', ownedBrowser.close] as const]
          : []),
        ['rating-fixture', () => f.close()],
      ]),
    );
    const origin = listeningFixtureOrigin(f.app.getHttpServer());
    const url = `${origin}/operator/rating-group-promotion?programId=${f.programId}`;
    const journalKey = `rating-group-promotion:v1:${encodeURIComponent(origin)}:${f.actorId}:${f.programId}`;
    const browser = (ownedBrowser = await startPromotionBrowser());
    let script = await browser.command(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: promotionBrowserBridgeScript({
          actorId: f.actorId,
          token: f.token,
        }),
      },
    );
    const count = async (
      table: 'promotion_campaigns' | 'rating_group_effects',
    ) =>
      Number(
        (
          await f.db.query<{ n: number }>(
            table === 'promotion_campaigns'
              ? 'SELECT count(*)::int n FROM whaleu_ratings.promotion_campaigns WHERE program_id=$1'
              : 'SELECT count(*)::int n FROM whaleu_notifications.rating_group_effects WHERE campaign_id IN (SELECT id FROM whaleu_ratings.promotion_campaigns WHERE program_id=$1)',
            [f.programId],
          )
        ).rows[0]!.n,
      );
    const readJournal = () =>
      browser.evaluate<Record<string, string>>(
        `JSON.parse(localStorage.getItem(${JSON.stringify(journalKey)}))`,
      );
    const ready = () =>
      browser.waitFor(
        "document.querySelector('#promotion-preview')?.disabled === false",
      );
    const recorded = () =>
      browser.waitFor(
        "document.querySelector('#promotion-status')?.textContent === 'Original request recorded.'",
      );
    const campaignPattern = `${origin}/v1/rating-group-promotion/programs/${f.programId}/campaigns`;
    const current = await f.db.query<{ audience_kind: string; n: number }>(
      'SELECT audience_kind,count(*)::int n FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$1 GROUP BY audience_kind',
      [f.programId],
    );
    const school =
      current.rows.find((row) => row.audience_kind === 'school_treehole')?.n ??
      0;
    const defaults =
      current.rows.find((row) => row.audience_kind === 'default_treehole')?.n ??
      0;
    const total = school + defaults;
    assert.ok(
      total > 0 && total <= 10,
      'Browser fixture must have a small explicit normal audience.',
    );
    const destination = (
      await f.db.query<{ label: string }>(
        'SELECT label FROM whaleu_ratings.promotion_receivers WHERE id=$1',
        [f.testDestinationId],
      )
    ).rows[0]!;

    await t.test(
      'same-origin shell and real DOM preview make no effects',
      async () => {
        const shell = await fetch(url);
        assert.equal(shell.status, 200);
        assert.match(shell.headers.get('cache-control') ?? '', /no-store/);
        assert.match(
          shell.headers.get('content-security-policy') ?? '',
          /script-src 'self'/,
        );
        assert.doesNotMatch(
          await shell.text(),
          /<script(?! type="module" src=)|\son[a-z]+\s*=|password|token/i,
        );
        const module = await fetch(
          `${origin}/operator/rating-group-promotion/controller.js`,
        );
        assert.equal(module.status, 200);
        assert.match(module.headers.get('cache-control') ?? '', /no-store/);
        assert.match(await module.text(), /mountRatingGroupPromotionOperator/);
        await browser.navigate(url);
        await ready();
        await browser.click('#promotion-preview');
        await browser.waitFor(
          "document.querySelector('#promotion-confirm')?.disabled === false",
        );
        assert.equal(
          await browser.evaluate(
            "document.querySelector('#promotion-confirm').textContent",
          ),
          `Send to enrolled groups (${total} groups: ${school} school, ${defaults} default)`,
        );
        assert.equal(await count('promotion_campaigns'), 0);
        assert.equal(await count('rating_group_effects'), 0);
      },
    );

    await t.test(
      'reload after journal readback before POST admits one immutable original campaign',
      async () => {
        await browser.command('Fetch.enable', {
          patterns: [{ urlPattern: campaignPattern, requestStage: 'Request' }],
        });
        const pause = browser.event('Fetch.requestPaused');
        await browser.click('#promotion-confirm');
        const event = await pause;
        const journal = await readJournal();
        assert.deepEqual(Object.keys(journal).sort(), [
          'actorId',
          'origin',
          'programId',
          'requestHash',
          'requestId',
          'ticketExpiresAt',
        ]);
        assert.equal(journal['actorId'], f.actorId);
        assert.equal(journal['programId'], f.programId);
        assert.equal(journal['origin'], origin);
        const intercepted = JSON.parse(
          String((event['request'] as Record<string, unknown>)['postData']),
        ) as Record<string, unknown>;
        assert.deepEqual(Object.keys(intercepted).sort(), [
          'intentTicket',
          'requestHash',
          'requestId',
        ]);
        assert.equal(intercepted['requestId'], journal['requestId']);
        assert.equal(intercepted['requestHash'], journal['requestHash']);
        assert.equal(await count('promotion_campaigns'), 0);
        assert.equal(
          await browser.evaluate(
            "document.querySelector('#promotion-confirm').disabled",
          ),
          true,
        );
        await browser.command('Fetch.failRequest', {
          requestId: event['requestId'],
          errorReason: 'Aborted',
        });
        await browser.command('Fetch.disable');
        await browser.reload();
        await recorded();
        assert.equal(await count('promotion_campaigns'), 1);
        assert.deepEqual(await readJournal(), journal);
        const admitted = (
          await f.db.query<{ request_id: string; recipient_count: number }>(
            'SELECT request_id,recipient_count FROM whaleu_ratings.promotion_campaigns WHERE program_id=$1',
            [f.programId],
          )
        ).rows[0]!;
        assert.equal(admitted.request_id, journal['requestId']);
        assert.equal(admitted.recipient_count, total);
        await browser.click('#promotion-recover');
        await recorded();
        assert.equal(await count('promotion_campaigns'), 1);
        assert.equal(
          await browser.evaluate(
            "document.querySelector('#promotion-current-copy').textContent",
          ),
          '',
        );
      },
    );

    await t.test(
      'synthetic worker outcomes remain independent of gated payload, hide and sign-out',
      async () => {
        await f.worker.maintain();
        for (let i = 0; i < total + 2; i += 1) {
          const result = await f.worker.drain();
          if (result.claimed === 0) break;
        }
        await browser.click('#promotion-recover');
        await browser.waitFor(
          `document.querySelector('#promotion-counts')?.textContent.includes('Confirmed: ${total}. Unknown: 0. Not sent: 0. Pending: 0.')`,
        );
        await browser.click('#promotion-inspect');
        await browser.waitFor(
          "document.querySelector('#promotion-current-copy')?.textContent.length > 0",
        );
        assert.match(
          await browser.evaluate<string>(
            "document.querySelector('#promotion-current-locator').textContent",
          ),
          /^pages\/rating-catalog\/rating-catalog\?parentId=/,
        );
        await browser.evaluate(
          "window.dispatchEvent(new PageTransitionEvent('pagehide')); true",
        );
        assert.equal(
          await browser.evaluate(
            "document.querySelector('#promotion-current-copy').textContent",
          ),
          '',
        );
        assert.equal(
          await browser.evaluate(
            "document.querySelector('#promotion-current-locator').textContent",
          ),
          '',
        );
        assert.equal(
          await browser.evaluate(
            "document.querySelector('#promotion-result').hidden",
          ),
          true,
        );
        await browser.click('#promotion-open');
        await recorded();
        await browser.click('#promotion-inspect');
        await browser.waitFor(
          "document.querySelector('#promotion-current-copy')?.textContent.length > 0",
        );
        await browser.evaluate(
          'window.invalidateRatingPromotionFixtureHost(); true',
        );
        assert.equal(
          await browser.evaluate(
            "document.querySelector('#promotion-current-copy').textContent",
          ),
          '',
        );
        await browser.click('#promotion-open');
        await recorded();
        assert.match(
          await browser.evaluate<string>(
            "document.querySelector('#promotion-stages').textContent",
          ),
          /messages may remain/,
        );
      },
    );

    await t.test(
      'durable cancellation precedes a separately confirmed one-destination test; lost ACK reload reuses its key',
      async () => {
        await browser.click('#promotion-seal');
        await ready();
        assert.equal(
          await browser.evaluate(
            `localStorage.getItem(${JSON.stringify(journalKey)})`,
          ),
          null,
        );
        await browser.select('#promotion-mode', 'test');
        await browser.select(
          '#promotion-test-destination',
          f.testDestinationId,
        );
        await browser.click('#promotion-preview');
        await browser.waitFor(
          "document.querySelector('#promotion-confirm')?.disabled === false",
        );
        assert.equal(
          await browser.evaluate(
            "document.querySelector('#promotion-confirm').textContent",
          ),
          `Send only to test destination “${destination.label}” (1 group)`,
        );
        assert.equal(await count('promotion_campaigns'), 1);
        await browser.command('Fetch.enable', {
          patterns: [{ urlPattern: campaignPattern, requestStage: 'Response' }],
        });
        const pause = browser.event('Fetch.requestPaused');
        await browser.click('#promotion-confirm');
        const event = await pause;
        assert.equal(await count('promotion_campaigns'), 2);
        const journal = await readJournal();
        const testCampaign = (
          await f.db.query<{
            id: string;
            recipient_count: number;
            mode: string;
          }>(
            'SELECT id,recipient_count,mode FROM whaleu_ratings.promotion_campaigns WHERE request_id=$1',
            [journal['requestId']],
          )
        ).rows[0]!;
        assert.equal(testCampaign.mode, 'test');
        assert.equal(testCampaign.recipient_count, 1);
        const recipients = (
          await f.db.query<{
            stable_destination_id: string;
            audience_kind: string;
          }>(
            'SELECT stable_destination_id,audience_kind FROM whaleu_ratings.promotion_campaign_recipients WHERE campaign_id=$1',
            [testCampaign.id],
          )
        ).rows;
        assert.deepEqual(recipients, [
          { stable_destination_id: f.testDestinationId, audience_kind: 'test' },
        ]);
        await browser.command('Fetch.failRequest', {
          requestId: event['requestId'],
          errorReason: 'Aborted',
        });
        await browser.command('Fetch.disable');
        // Browser expiry must not suppress historical recovery. Server-side expired
        // preview/ticket ordering is independently asserted in the ledger suite.
        const oldJournal = {
          ...journal,
          ticketExpiresAt: '2000-01-01T00:00:00.000Z',
        };
        await browser.evaluate(
          `localStorage.setItem(${JSON.stringify(journalKey)}, ${JSON.stringify(JSON.stringify(oldJournal))}); true`,
        );
        await browser.reload();
        await recorded();
        assert.equal(await count('promotion_campaigns'), 2);
        assert.deepEqual(await readJournal(), oldJournal);
        assert.equal(
          await browser.evaluate(
            "document.querySelector('#promotion-current-copy').textContent",
          ),
          '',
        );
        await browser.click('#promotion-seal');
        await ready();
      },
    );

    for (const storageFailure of ['write', 'readback'] as const) {
      await t.test(
        `${storageFailure} failure sends zero campaign POST and keeps source out of storage`,
        async () => {
          await browser.command('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: script['identifier'],
          });
          script = await browser.command(
            'Page.addScriptToEvaluateOnNewDocument',
            {
              source: promotionBrowserBridgeScript({
                actorId: f.actorId,
                token: f.token,
                storageFailure,
              }),
            },
          );
          await browser.reload();
          await ready();
          const before = await count('promotion_campaigns');
          await browser.click('#promotion-preview');
          await browser.waitFor(
            "document.querySelector('#promotion-confirm')?.disabled === false",
          );
          await browser.click('#promotion-confirm');
          await browser.waitFor(
            "document.querySelector('#promotion-status')?.textContent === 'PROMOTION_JOURNAL_UNAVAILABLE'",
          );
          assert.equal(await count('promotion_campaigns'), before);
          const entries = await browser.evaluate<Record<string, string>>(
            'Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage[key]]))',
          );
          assert.doesNotMatch(
            JSON.stringify(entries),
            /intentTicket|Bearer|copy|locator|opaqueReceiver|testDestination/,
          );
          await browser.evaluate('localStorage.clear(); true');
        },
      );
    }

    await t.test('unsupported host cannot enable sending', async () => {
      await browser.command('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: script['identifier'],
      });
      await browser.reload();
      await browser.waitFor(
        "document.readyState === 'complete' && document.querySelector('#promotion-status')?.textContent === 'A supported authenticated host is required.'",
      );
      for (const control of [
        'promotion-open',
        'promotion-preview',
        'promotion-confirm',
      ])
        assert.equal(
          await browser.evaluate(
            `document.querySelector('#${control}').disabled`,
          ),
          true,
        );
      assert.equal(await count('promotion_campaigns'), 2);
    });
  },
);
