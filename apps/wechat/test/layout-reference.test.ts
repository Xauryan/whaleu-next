import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
const source = (page: string, extension = 'wxml') =>
  readFileSync(
    path.join(__dirname, `../src/pages/${page}/${page}.${extension}`),
    'utf8',
  );
test('main destinations do not reintroduce promotional hero panels above actual content', () => {
  assert.doesNotMatch(
    source('campus-hub'),
    /hub-eyebrow|hub-subtitle|campus-card|campus-art|WHALEU CAMPUS/,
  );
  assert.match(source('campus-hub'), /campus-selector/);
  assert.doesNotMatch(
    source('inbox'),
    /inbox-eyebrow|inbox-subtitle|conversation-card|message-hero-icon|STAY CONNECTED/,
  );
  assert.match(source('inbox'), /conversation-row/);
  // The user's current screenshots explicitly retain a dark personal cover in
  // both themes. This is not the removed blue promotional introduction panel.
  assert.match(
    source('me', 'wxss'),
    /background: linear-gradient\(145deg, #25282a/,
  );
  assert.doesNotMatch(
    source('me'),
    /profile-eyebrow|profile-intro|MADE FOR YOU/,
  );
  assert.doesNotMatch(
    source('community-feed'),
    /class="home-title"|class="feed-heading"/,
  );
});

test('campus keeps primary tools concise without promotional subtitles or repeated coverage labels', () => {
  const template = source('campus-hub');
  assert.doesNotMatch(
    template,
    /tool-subtitle|row-subtitle|section-caption|page-footer|unavailable-pill/,
  );
  assert.match(template, /我的课表/);
  assert.match(template, /成绩查询/);
  assert.match(template, /暂未接入/);
  assert.match(template, /campus.error \|\| navigationError/);
});
