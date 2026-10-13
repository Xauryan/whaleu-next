import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { HotPage } from '../src/community/hot-contract';
import { deferred, flush } from './helpers';
import { hotHarness, hotPage, hotRoute } from './hot-helpers';
import { searchHarness, searchPage, searchRoute } from './search-helpers';

const source = (page: string) =>
  readFileSync(
    path.resolve(__dirname, `../src/pages/${page}/${page}.wxml`),
    'utf8',
  );

test('nested discussion templates receive the retained viewing space; unrelated recovery links stay canonical', () => {
  const detail = source('community-detail'),
    thread = source('community-thread');
  for (const [markup, template, count] of [
    [detail, 'root-comment', 1],
    [thread, 'reply-row', 3],
  ] as const) {
    const invocations = [
      ...markup.matchAll(
        new RegExp(`<template is="${template}" data="([^"]+)"`, 'g'),
      ),
    ];
    assert.equal(invocations.length, count);
    for (const match of invocations)
      assert.match(match[1]!, /\bviewSpaceQuery\b/);
  }
  for (const owner of ['tradingMutation', 'formationView', 'pollView']) {
    const url = [...detail.matchAll(/<navigator[^>]+url="([^"]+)"/g)]
      .map((match) => match[1]!)
      .find((value) => value.includes(`${owner}.recoveryPostId`));
    assert.ok(url);
    assert.doesNotMatch(url, /viewSpaceQuery|viewSpaceId/);
  }
  assert.match(detail, /rootCommentId=\{\{item.id\}\}\{\{viewSpaceQuery\}\}/);
  assert.match(thread, /targetReplyId=\{\{reply.id\}\}\{\{viewSpaceQuery\}\}/);
});

test('incomplete feed empty and terminal text never claims complete related coverage', () => {
  const markup = source('community-feed');
  assert.match(
    markup,
    /relatedCampusDistribution === 'unavailable' \? '本次没有已核验可展示的帖子/,
  );
  assert.match(
    markup,
    /relatedCampusDistribution === 'unavailable' \? '已展示本次可核验内容/,
  );
});

test('destination pin keeps a related source badge visible even when collapsed', () => {
  const markup = readFileSync(
    path.resolve(__dirname, '../src/post-pins/feed.wxml'),
    'utf8',
  );
  assert.match(markup, /postPin\.item\.post\.isRelatedCampusSync/);
  assert.match(markup, /postPin\.item\.post\.sourceRegion\.name/);
  assert.ok(
    markup.indexOf('关联学校同步') < markup.indexOf('postPin.collapsed'),
  );
});

test('hot incomplete end is honest and coverage clears immediately on another range', async (t) => {
  const s = hotHarness();
  t.after(() => s.controller.dispose());
  s.behavior.hot = async () =>
    hotPage({ items: [], relatedCampusDistribution: 'unavailable' });
  await s.controller.load(hotRoute);
  assert.equal(s.view().relatedCampusDistribution, 'unavailable');
  assert.match(s.view().status, /关联学校范围仍待核验/);
  assert.doesNotMatch(s.view().status, /暂无|末尾/);
  const pending = deferred<HotPage>();
  s.behavior.hot = () => pending.promise;
  const loading = s.controller.setRange('week');
  await flush();
  assert.equal(s.view().relatedCampusDistribution, '');
  pending.resolve(hotPage({ relatedCampusDistribution: 'complete' }));
  await loading;
  assert.equal(s.view().relatedCampusDistribution, 'complete');
});

test('lexical incomplete end does not become known empty and does not leak into semantic results', async (t) => {
  const s = searchHarness();
  t.after(() => s.controller.dispose());
  s.behavior.search = async () =>
    searchPage({ items: [], relatedCampusDistribution: 'unavailable' });
  await s.controller.load(searchRoute);
  s.controller.setInput('校园');
  await s.controller.submit();
  assert.equal(s.view().relatedCampusDistribution, 'unavailable');
  assert.match(s.view().status, /关联学校范围仍待核验/);
  assert.doesNotMatch(s.view().status, /没有|末尾/);
  await s.controller.setMode('semantic');
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().relatedCampusDistribution, '');
  assert.match(s.view().status, /语义相关/);
});
