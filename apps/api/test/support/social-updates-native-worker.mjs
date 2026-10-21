/** Emitted native Page/F7 controls -> real authenticated loopback HTTP/PostgreSQL.
 * Only platform callbacks and transport are adapted; no notice payload is seeded
 * here. The caller must build the native artifact before running this test. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSocialUpdatesJourney } from '../../../wechat/test/social-updates-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const {
  NativeExperienceTransport,
  nativeOrigin,
} = require('./experience-native-bridge.ts');
const dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url));

async function until(check, label, page) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${page?.data.error || page?.data.status || 'not settled'}`,
    );
    await delay(5);
  }
}
process.once('message', async (input) => {
  let journey;
  try {
    const transport = new NativeExperienceTransport(input.port);
    journey = createSocialUpdatesJourney({
      dist,
      origin: nativeOrigin,
      credentials: input.credentials,
      transport,
    });
    const likes = journey.mount('likes');
    await likes.idle();
    assert.equal(likes.page.data.loaded, true);
    const rows = likes.page.data.rows.filter((row) =>
      ['community-like', 'community-save'].includes(row.source),
    );
    assert.equal(
      rows.length,
      2,
      'Both real received-community sources appear in the existing likes category',
    );
    assert.equal(new Set(rows.map((row) => row.id)).size, 2);
    for (const row of rows) {
      assert.equal(row.available, true);
      assert.equal(row.unread, true);
      assert.equal(
        row.preview,
        '',
        'Actor-neutral like/save rows have no reconstructed preview',
      );
      assert.equal(row.id, `${row.source}:${row.noticeId}`);
      const previousNavigation = journey.navigations.length;
      const previousRead = transport.exchanges.filter(
        (exchange) => exchange.method === 'PUT',
      ).length;
      assert.equal(likes.press('onOpen', { id: row.id }), true);
      await until(
        () =>
          journey.navigations.length > previousNavigation &&
          !likes.page.data.busy,
        'authorized real community target',
        likes.page,
      );
      assert.ok(journey.navigations.at(-1).includes(input.postId));
      assert.equal(
        transport.exchanges.filter((exchange) => exchange.method === 'PUT')
          .length,
        previousRead,
        'Navigation must not implicitly acknowledge a notice',
      );
      assert.equal(
        likes.page.data.rows.find((value) => value.id === row.id).unread,
        true,
      );
      if (row.source === 'community-like') {
        // Real first acknowledgment commits, but the native reader loses its response.
        // Retry must recover the same server-owned notice without optimistic success.
        transport.dropSuccess = {
          path: `/v1/me/social-updates/${row.noticeId}/read`,
          method: 'PUT',
        };
        const count = transport.exchanges.length;
        assert.equal(likes.press('onRead', { id: row.id }), true);
        await until(
          () => transport.exchanges.length > count && !likes.page.data.busy,
          'uncertain acknowledgment',
          likes.page,
        );
        assert.equal(
          likes.page.data.rows.find((value) => value.id === row.id).unread,
          true,
        );
      }
      assert.equal(likes.press('onRead', { id: row.id }), true);
      await until(
        () =>
          likes.page.data.rows.find((value) => value.id === row.id)?.unread ===
            false && !likes.page.data.busy,
        'explicit owned acknowledgment',
        likes.page,
      );
      const readExchanges = transport.exchanges.filter(
        (exchange) =>
          exchange.method === 'PUT' &&
          exchange.path.startsWith(
            `/v1/me/social-updates/${row.noticeId}/read?`,
          ),
      );
      assert.equal(
        readExchanges.length,
        row.source === 'community-like' ? 2 : 1,
      );
      assert.ok(
        readExchanges.every(
          (exchange) => exchange.authorized && exchange.status === 200,
        ),
      );
    }
    likes.unload();

    let followers = journey.mount('followers');
    await followers.idle();
    assert.equal(followers.page.data.loaded, true);
    assert.equal(followers.page.data.unavailable, false);
    assert.equal(followers.page.data.rows.length, 1);
    const follower = followers.page.data.rows[0];
    assert.equal(follower.source, 'follower');
    assert.equal(follower.available, true);
    assert.equal(follower.unread, true);
    const publicView = JSON.stringify(followers.page.data);
    for (const field of [
      'accountId',
      'sessionId',
      'accessToken',
      'refreshToken',
      'profileId',
      'actor',
      'target',
    ])
      assert.equal(
        publicView.includes(`"${field}":`),
        false,
        'Page data retains display rows, not private transport objects',
      );
    for (const value of [
      input.credentials.accountId,
      input.credentials.sessionId,
      input.credentials.accessToken,
      input.credentials.refreshToken,
    ])
      assert.equal(publicView.includes(value), false);
    const gate = transport.holdNext(
      `/v1/me/social-updates/${follower.noticeId}/target`,
    );
    const navigations = journey.navigations.length;
    assert.equal(followers.press('onOpen', { id: follower.id }), true);
    await gate.arrived;
    followers.hide();
    gate.release();
    await delay(20);
    assert.deepEqual(
      followers.page.data.rows,
      [],
      'Hidden Page cannot receive a late private projection',
    );
    assert.equal(
      journey.navigations.length,
      navigations,
      'Late target resolution cannot navigate after hide',
    );
    followers.unload();

    followers = journey.mount('followers');
    await followers.idle();
    assert.equal(followers.press('onOpen', { id: follower.id }), true);
    await until(
      () =>
        journey.navigations.length > navigations && !followers.page.data.busy,
      'fresh authorized follower target',
      followers.page,
    );
    assert.match(
      journey.navigations.at(-1),
      /^\/pages\/public-profile\/public-profile\?profileId=/,
    );
    assert.equal(
      journey.navigations.at(-1).includes('noticeId'),
      false,
      'Public profile links contain no private notice locator',
    );
    assert.equal(followers.page.data.rows[0].unread, true);
    assert.equal(followers.press('onRead', { id: follower.id }), true);
    await until(
      () =>
        followers.page.data.rows[0]?.unread === false &&
        !followers.page.data.busy,
      'follower acknowledgment',
      followers.page,
    );
    const captured = followers.capture('onOpen', { id: follower.id });
    journey.hideApp();
    const afterHide = transport.exchanges.length;
    captured.press();
    captured.detach();
    await delay(20);
    assert.deepEqual(followers.page.data.rows, []);
    assert.equal(
      transport.exchanges.length,
      afterHide,
      'App-hidden stale controls issue no private request',
    );
    assert.ok(
      transport.exchanges
        .filter((exchange) => exchange.path.startsWith('/v1/me/social-updates'))
        .every((exchange) => exchange.authorized),
    );
    journey.close();
    journey = undefined;
    process.send?.({ event: 'done' }, () => process.disconnect());
  } catch (error) {
    journey?.close();
    process.exitCode = 1;
    process.send?.(
      {
        event: 'failure',
        message: error instanceof Error ? error.stack : String(error),
      },
      () => process.disconnect(),
    );
  }
});
