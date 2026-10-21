import {
  exposureProofPaths,
  exposureSuccessors,
  reviewedExposurePredecessor,
} from './reviewed-notice-exposure-successor';
import {
  reviewedNoticePredecessor,
  noticeSuccessors,
  noticeEvidenceRoot,
} from './reviewed-notice-read-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SafetyChanges } from '../src/community/safety-changes';
import { SocialNoticesController } from '../src/pages/social-notices/controller';
import { assertReviewedSocialSuccessor } from './reviewed-social-successor';
import { noticeId, replyId, route } from './ratings-r2a-helpers';
import { r2cHarness } from './ratings-r2c-helpers';
import {
  socialApi,
  socialCursor,
  socialPage,
  socialResolution,
} from './social-updates-helpers';

const root = path.join(__dirname, '..');
const evidenceRoot = 'test/fixtures/reviewed-social-successor-v33c';
const read = (file: string) => readFileSync(path.join(root, file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// Independent pins, not values read back from the successor manifest.
const expectedSources = {
  'src/ratings/discussion-controller.ts': {
    before: '10ef6d1187d652037e0accbbf8a70a391f3ef573b326bb276030c4dc0c8baeaa',
    after: '233d8a4227e204585b6e1e1c51d029c88cc31e0b2179763663aa94cbcef40bff',
    bytes: 31822,
    reason: 'merged-rating-navigation-explicit-read-with-owner-proof',
  },
  'src/pages/social-notices/controller.ts': {
    before: '87c2f441f64994bcda0e0cf19170bd8f591484f709c8d9febb9ffc1fd44c801e',
    after: '8d9d7821dee05f9c3fd7416e1264c62a97caacef63614bed334ac6bd3c3e327f',
    bytes: 17457,
    reason: 'real-social-readers-with-owner-lifecycle-and-partial-coverage',
  },
  'src/pages/social-notices/social-notices.ts': {
    before: '0d45a96ae31b25f0aa411cc6a9167dc0f3e003c59d7f2e90201c4fb41c73925d',
    after: 'a471fa1646e5494f9388cd781b8fe95179219b417b36cc146c177a59de2db99e',
    bytes: 2576,
    reason: 'same-session-social-api-injection-only',
  },
};

test('social successor manifest pins exactly three reviewed paths and independent V33C provenance', () => {
  const bytes = read(`${evidenceRoot}/manifest.json`);
  assert.equal(
    sha(bytes),
    '6396a37239db04dade540b86620cb975e951ff89c75cc0b6e8c40d82ca245926',
  );
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), {
    baselineManifest:
      '28f996f090a8335506f37cda778692e60cdfb4205bb37e50654f585893084527',
    reviewedNativeManifest:
      'f822d3376e70485e7e6d9040d41fd6de24f7475c64af8bb03ac25e64a82745f4',
    sources: Object.fromEntries(
      Object.entries(expectedSources).map(([file, entry]) => [
        file,
        {
          before: entry.before,
          after: entry.after,
          evidence: `${evidenceRoot}/${file}.txt`,
          reason: entry.reason,
        },
      ]),
    ),
  });
  const originals = readdirSync(path.join(root, evidenceRoot), {
    recursive: true,
  })
    .map(String)
    .filter((file) => file.endsWith('.txt'))
    .sort();
  assert.deepEqual(
    originals,
    Object.keys(expectedSources)
      .map((file) => `${file}.txt`)
      .sort(),
  );
});

for (const [file, entry] of Object.entries(expectedSources)) {
  test(`${file}: original bytes and only exact inventory aliases authorize the pinned successor`, () => {
    const evidence = `${evidenceRoot}/${file}.txt`;
    assert.equal(read(evidence).byteLength, entry.bytes);
    assert.equal(sha(read(evidence)), entry.before);
    assert.equal(
      sha(
        file in noticeSuccessors
          ? reviewedNoticePredecessor(file, entry.after)
          : file in exposureSuccessors
            ? reviewedExposurePredecessor(file, entry.after)
            : read(file),
      ),
      entry.after,
    );
    assert.notEqual(entry.before, entry.after);
    for (const alias of [
      file,
      `apps/wechat/${file}`,
      file.slice('src/'.length),
    ]) {
      const reads: string[] = [];
      assert.equal(
        assertReviewedSocialSuccessor(alias, entry.before, (target) => {
          reads.push(target);
          return read(target);
        }),
        true,
      );
      assert.deepEqual(
        reads,
        file in noticeSuccessors
          ? [evidence, `${noticeEvidenceRoot}/${file}.txt`, file]
          : file in exposureSuccessors
            ? [evidence, ...exposureProofPaths]
            : [evidence, file],
      );
    }
  });
  test(`${file}: wrong historical hashes never supersede an original guard`, () => {
    for (const wrong of [
      '',
      '0'.repeat(64),
      entry.after,
      entry.before.toUpperCase(),
    ]) {
      assert.equal(
        assertReviewedSocialSuccessor(file, wrong, () => {
          assert.fail('A wrong old hash must not read any source');
        }),
        false,
      );
      if (wrong !== entry.after)
        assert.throws(() => {
          if (!assertReviewedSocialSuccessor(file, wrong))
            assert.equal(sha(read(file)), wrong);
        });
    }
  });
  test(`${file}: corrupted baseline and unreviewed current bytes both fail closed`, () => {
    for (const changed of [`${evidenceRoot}/${file}.txt`, file])
      assert.throws(
        () =>
          assertReviewedSocialSuccessor(file, entry.before, (target) => {
            const bytes = read(target);
            return target === changed
              ? Buffer.concat([bytes, Buffer.from('\n// unreviewed\n')])
              : bytes;
          }),
        changed === file
          ? /exact reviewed (social business|explicit-read|exposure) successor/
          : /immutable V33C evidence/,
      );
  });
}

test('unreviewed paths, traversal, lookalike prefixes and prototype keys cannot enter the allowlist', () => {
  const unknown = [
    'src/app.json',
    'src/notifications/social-updates/controller.ts',
    'src/pages/social-notices/social-notices.wxml',
    'src/ratings/updates-controller.ts',
    '__proto__',
    'constructor',
    ...Object.keys(expectedSources).flatMap((file) => [
      `./${file}`,
      `/${file}`,
      `other/${file}`,
      `apps/wechat/${file.slice(4)}`,
      `apps/wechat/apps/wechat/${file}`,
      `src/../${file}`,
      `${file}/`,
      `${file}.bak`,
      `${file}?reviewed=true`,
      `${file}\0`,
      file.split('/').join('\\'),
      file.toUpperCase(),
    ]),
  ];
  for (const file of unknown)
    for (const { before } of Object.values(expectedSources))
      assert.equal(
        assertReviewedSocialSuccessor(file, before, () => {
          assert.fail(`Unknown path tried to read evidence: ${file}`);
        }),
        false,
        file,
      );
});

test('the old five protected inventories and independent six-path business helper remain immutable', () => {
  const pins = {
    'test/reviewed-business-successor.ts':
      '0899865979024ce96fc723218bd895b1ec660cc906121f1639a7fe3c34f495b8',
    'test/fixtures/framework7-ratings-before-protected.json':
      '4bf6ace63c71d3bb2623edc5e957037383075a1d48439b31f6de24cb0b613455',
    'test/fixtures/framework7-rating-recovery-before-protected.json':
      '702ad98406037a0238bfa4e80aa22358f5dd174bc009eb22eca9fde5ec1c1f10',
    'test/fixtures/framework7-notifications-before-protected.json':
      '6bbc2023784fc6b2cdf0a0f727472f77ec823759b9def8331c74eacfe203bada',
    'test/fixtures/notification-details-action-inventory.json':
      '04765a4c1f817fe4e9bd104c53e4de6feb72a6c40bf47dc0a30127f8f3a92b3d',
    'test/fixtures/rating-management-action-inventory.json':
      '274e84f48d0e7d885c58368926a0bb9961c61ae7f295fe2d38866bc5651aef33',
  };
  for (const [file, expected] of Object.entries(pins))
    assert.equal(sha(read(file)), expected, file);
});

function replaceOnce(text: string, before: string, after: string): string {
  assert.equal(
    text.split(before).length,
    2,
    `Expected one exact change: ${before}`,
  );
  return text.replace(before, after);
}

test('native social Page successor changes only same-session ApiClient injection', () => {
  const file = 'src/pages/social-notices/social-notices.ts';
  let original = read(`${evidenceRoot}/${file}.txt`).toString('utf8');
  original = replaceOnce(
    original,
    '    const runtime = getApp<WhaleuApp>().community;',
    '    const app = getApp<WhaleuApp>();\n    const runtime = app.community;',
  );
  original = replaceOnce(
    original,
    '        }),\n    );\n    await this.controller.load();',
    '        }),\n      app.identity?.sessions === runtime.sessions\n        ? app.identity.api\n        : undefined,\n    );\n    await this.controller.load();',
  );
  assert.equal(
    reviewedExposurePredecessor(file, expectedSources[file].after).toString(
      'utf8',
    ),
    original,
  );
});

test('rating successor changes only strict explicit-read parsing and the final automatic acknowledgment gate', () => {
  const file = 'src/ratings/discussion-controller.ts';
  let current = reviewedNoticePredecessor(
    file,
    expectedSources[file].after,
  ).toString('utf8');
  const changes = [
    [
      "  /** Suppresses only automatic acknowledgment; all owner/target proof remains required. */\n  readonly noticeRead?: 'explicit';\n",
      '',
    ],
    ["          'noticeRead',\n", ''],
    [
      "    Object.entries(value).some(\n      ([key, id]) => key !== 'noticeRead' && !ratingId(id),\n    ) ||\n    (Object.prototype.hasOwnProperty.call(value, 'noticeRead') &&\n      (value.noticeRead !== 'explicit' ||\n        ![value.noticeId, value.likeNoticeId, value.subscriptionNoticeId].some(\n          (id) => id !== undefined,\n        ))) ||",
      '    Object.values(value).some((id) => !ratingId(id)) ||',
    ],
    [
      "    ...(value.noticeRead === 'explicit'\n      ? { noticeRead: 'explicit' as const }\n      : {}),\n",
      '',
    ],
    ["      route.noticeRead !== 'explicit' &&\n", ''],
  ] as const;
  for (const [before, after] of changes)
    current = replaceOnce(current, before, after);
  assert.equal(current, read(`${evidenceRoot}/${file}.txt`).toString('utf8'));
});

for (const spec of [
  { owner: 'ratingUpdates', query: { ...route, noticeId, replyId } },
  { owner: 'ratingLikeUpdates', query: { ...route, likeNoticeId: noticeId } },
  {
    owner: 'ratingSubscriptionUpdates',
    query: { ...route, subscriptionNoticeId: noticeId },
  },
] as const)
  test(`${spec.owner}: legacy and merged explicit modes preserve proof without automatic reading`, async () => {
    for (const explicit of [false, true]) {
      const s = r2cHarness();
      try {
        await s.controller.load({
          ...spec.query,
          ...(explicit ? { noticeRead: 'explicit' } : {}),
        });
        assert.equal(s.view().loaded, true);
        const owner = s[spec.owner];
        assert.equal(
          owner.calls.filter((call) => call.method === 'target').length,
          1,
        );
        assert.equal(
          owner.calls.filter((call) => call.method === 'markRead').length,
          0,
        );
        assert.ok(
          s.ratingDiscussion.calls.some((call) => call.method === 'discussion'),
        );
      } finally {
        s.controller.dispose();
        s.detailController.dispose();
        s.directoryController.dispose();
        s.updatesController.dispose();
      }
    }
  });

test('real follower reader is opt-in, stays partial with more/unknown coverage and clears on safety invalidation', async () => {
  const s = socialApi();
  const safetyChanges = new SafetyChanges();
  const runtime = { ...s.runtime, safetyChanges };
  const urls: string[] = [];
  const legacy = new SocialNoticesController(
    runtime,
    'followers',
    () => undefined,
    async () => undefined,
  );
  const current = new SocialNoticesController(
    runtime,
    'followers',
    () => undefined,
    async (url) => {
      urls.push(url);
    },
    s.api,
  );
  try {
    await legacy.load();
    assert.equal(legacy.snapshot().unavailable, true);
    assert.equal(s.transport.requests.length, 0);
    s.transport.reply(socialPage('followers', { nextCursor: socialCursor }));
    await current.load();
    assert.equal(current.snapshot().loaded, true);
    assert.equal(current.snapshot().unavailable, false);
    assert.equal(current.snapshot().canMore, true);
    assert.equal(current.snapshot().partial, true);
    const row = current.snapshot().rows[0]!;
    assert.equal(row.source, 'follower');
    assert.equal(row.unread, true);
    s.transport.reply(socialResolution('followers'));
    await current.open(row.id);
    assert.equal(urls.length, 1);
    assert.ok(
      s.transport.requests.every((request) => request.method === 'GET'),
    );
    s.transport.reply(socialPage('followers', { items: [] }));
    await current.more('follower');
    assert.equal(current.snapshot().canMore, false);
    assert.equal(current.snapshot().partial, false);
    s.transport.reply(
      socialPage('followers', {
        unreadCount: null,
        unreadCountStatus: 'unavailable',
      }),
    );
    await current.load();
    assert.equal(current.snapshot().canMore, false);
    assert.equal(current.snapshot().partial, true);
    assert.equal('unreadCount' in current.snapshot(), false);
    safetyChanges.invalidate(s.accountId);
    assert.deepEqual(current.snapshot().rows, []);
    assert.equal(current.snapshot().loaded, false);
    const requestCount = s.transport.requests.length;
    await current.open(row.id);
    await current.acknowledge(row.id);
    assert.equal(s.transport.requests.length, requestCount);
  } finally {
    legacy.dispose();
    current.dispose();
  }
});
