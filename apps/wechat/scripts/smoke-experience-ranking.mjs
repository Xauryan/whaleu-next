import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createNativePressBridge } from '../test/native-press-emitted-harness.mjs';
const require = createRequire(import.meta.url);
// Actual emitted Page/API/decoder; synthetic HTTP here, real HTTP/PG in integration.
export async function smokeExperienceRanking({ app, dist, mountPage, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpExperienceRankingGateway } = require(
    path.join(dist, 'experience/ranking-gateway.js'),
  );
  const saved = app.community.experienceRanking;
  const items = [
    {
      profileId: '11111111-1111-4111-8111-111111111111',
      displayName: '合成参与者',
      experienceDisplay: {
        title: { status: 'known', value: null },
        color: { status: 'unavailable', value: null },
        level: { status: 'known', value: 1 },
      },
    },
  ];
  let response = {
      scope: 'global',
      population: 'known_participants',
      populationCompleteness: 'incomplete',
      selectionStatus: 'available_candidates_exhausted',
      items,
    },
    page;
  const requests = [];
  app.community.experienceRanking = new HttpExperienceRankingGateway(
    new ApiClient(
      'https://api.example',
      {
        send: async (request) => {
          requests.push(request);
          assert.equal(
            request.url,
            'https://api.example/v1/experience/ranking?limit=50',
          );
          assert.equal(request.method, 'GET');
          assert.equal(request.body, undefined);
          return { status: 200, headers: {}, body: response };
        },
      },
      app.identity.sessions,
      {
        refresh: async () => {
          throw new Error('Unexpected refresh');
        },
      },
    ),
  );
  try {
    page = mountPage(
      path.join(dist, 'pages/experience-ranking/experience-ranking.js'),
      {},
    );
    await flush();
    assert.equal(page.data.loaded, true);
    assert.deepEqual(page.data.items, items);
    response = { ...response, selectionStatus: 'scan_limited', items: [] };
    const bridge = createNativePressBridge({
      page,
      pageFile: path.join(dist, 'pages/experience-ranking/experience-ranking'),
      dist,
    });
    const refresh = bridge.capture('onRefresh');
    try {
      refresh.press();
    } finally {
      refresh.detach();
    }
    await flush();
    assert.equal(page.data.selectionStatus, 'scan_limited');
    assert.match(page.data.status, /未完整查看/);
    page.onHide();
    assert.deepEqual(page.data.items, []);
    page.onShow();
    await flush();
    assert.equal(requests.length, 3);
    const wxml = readFileSync(
      path.join(dist, 'pages/experience-ranking/experience-ranking.wxml'),
      'utf8',
    );
    assert.match(wxml, /历史覆盖不完整/);
    assert.match(wxml, /public-experience-display/);
    for (const handler of ['onRefresh', 'onCancel', 'onProfile'])
      assert.match(wxml, new RegExp(`bind:press="${handler}"`));
    assert.doesNotMatch(wxml, /\{\{index|<image|total_exp|accountId/);
  } finally {
    page?.onUnload();
    app.community.experienceRanking = saved;
  }
}
