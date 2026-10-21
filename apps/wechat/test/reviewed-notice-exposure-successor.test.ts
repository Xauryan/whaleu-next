import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { guardNoticeRead } from '../src/notifications/notice-read-guard';
import { Cancellation } from '../src/platform/contracts';
import {
  assertReviewedNoticeExposureSuccessor,
  exposureProofPaths,
  exposureSuccessors,
  reviewedExposurePredecessor,
} from './reviewed-notice-exposure-successor';
import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import { assertReviewedNoticeReadSuccessor } from './reviewed-notice-read-successor';
import { assertReviewedReferenceSuccessor } from './reviewed-reading-successor';
import { assertReviewedSocialSuccessor } from './reviewed-social-successor';

const read = (file: string) => readFileSync(path.join(__dirname, '..', file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
for (const [file, entry] of Object.entries(exposureSuccessors)) {
  test(`${file}: only the exact reviewed exposure transition and explicit aliases supersede history`, () => {
    for (const alias of [file, `apps/wechat/${file}`, file.slice(4)]) {
      const reads: string[] = [];
      assert.equal(
        assertReviewedNoticeExposureSuccessor(alias, entry.before, (target) => {
          reads.push(target);
          return read(target);
        }),
        true,
      );
      assert.deepEqual(reads, exposureProofPaths);
    }
    assert.equal(
      sha(reviewedExposurePredecessor(file, entry.before)),
      entry.before,
    );
    for (const wrong of [
      '',
      '0'.repeat(64),
      entry.after,
      entry.before.toUpperCase(),
    ])
      assert.equal(
        assertReviewedNoticeExposureSuccessor(file, wrong, () => {
          assert.fail(
            'Wrong historical hashes cannot read or supersede evidence',
          );
        }),
        false,
      );
    for (const wrong of [
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
    ])
      assert.equal(
        assertReviewedNoticeExposureSuccessor(wrong, entry.before, () => {
          assert.fail(`Unreviewed alias tried reading evidence: ${wrong}`);
        }),
        false,
      );
  });
}

test('the entire bounded slice, each predecessor and every dependency are required, not only the requested controller hash', () => {
  const file = 'src/pages/community-updates/controller.ts';
  assert.equal(new Set(exposureProofPaths).size, exposureProofPaths.length);
  for (const changed of exposureProofPaths)
    assert.throws(
      () =>
        assertReviewedNoticeExposureSuccessor(
          file,
          exposureSuccessors[file]!.before,
          (target) =>
            target === changed
              ? Buffer.concat([read(target), Buffer.from('\n// unreviewed')])
              : read(target),
        ),
      /immutable|exact reviewed/,
      changed,
    );
});

test('unknown files and added dependencies never authorize replacing an older protected hash', () => {
  for (const file of [
    '__proto__',
    'constructor',
    'src/app.json',
    'src/pages/inbox/inbox.ts',
    'src/pages/home/home.wxml',
    'src/pages/me/me.ts',
    'src/notifications/notice-exposure.ts',
    'src/notifications/notice-read-guard.ts',
  ])
    for (const { before } of Object.values(exposureSuccessors))
      assert.equal(
        assertReviewedNoticeExposureSuccessor(file, before, () => {
          assert.fail(`Unknown source tried reading evidence: ${file}`);
        }),
        false,
      );
});

test('business, social, notice-read and reference proofs compose without replacing prior evidence or broadening allowlists', () => {
  assert.equal(
    assertReviewedBusinessSuccessor(
      'src/app.json',
      '0698088457fad2bb9e327a3ef75645171a9cd62fbb3bcad793f31aefe2b14143',
    ),
    true,
  );
  assert.equal(
    assertReviewedReferenceSuccessor(
      'apps/wechat/src/pages/community-detail/community-detail.ts',
      '4496433d8ff570b537e2cd20c129a0a122fc85c15a12476a2654abbe949136cc',
    ),
    true,
  );
  assert.equal(
    assertReviewedSocialSuccessor(
      'src/pages/social-notices/controller.ts',
      '87c2f441f64994bcda0e0cf19170bd8f591484f709c8d9febb9ffc1fd44c801e',
    ),
    true,
  );
  assert.equal(
    assertReviewedSocialSuccessor(
      'src/pages/social-notices/social-notices.ts',
      '0d45a96ae31b25f0aa411cc6a9167dc0f3e003c59d7f2e90201c4fb41c73925d',
    ),
    true,
  );
  assert.equal(
    assertReviewedNoticeReadSuccessor(
      'src/ratings/updates-controller.ts',
      '4d9650f4bde58b93c5cdc67ccb088fb1ea6534339a73143f8486b013bdf9a910',
    ),
    true,
  );
  for (const helper of [
    assertReviewedBusinessSuccessor,
    assertReviewedSocialSuccessor,
    assertReviewedNoticeReadSuccessor,
    assertReviewedReferenceSuccessor,
  ])
    assert.equal(
      helper('src/notifications/notice-read-guard.ts', '0'.repeat(64)),
      false,
    );
  for (const [file, expected, helper] of [
    [
      'src/pages/social-notices/controller.ts',
      '87c2f441f64994bcda0e0cf19170bd8f591484f709c8d9febb9ffc1fd44c801e',
      assertReviewedSocialSuccessor,
    ],
    [
      'src/ratings/updates-controller.ts',
      '4d9650f4bde58b93c5cdc67ccb088fb1ea6534339a73143f8486b013bdf9a910',
      assertReviewedNoticeReadSuccessor,
    ],
  ] as const)
    for (const changed of exposureProofPaths)
      assert.throws(
        () =>
          helper(file, expected, (target) =>
            target === changed ? Buffer.from('corrupt') : read(target),
          ),
        /immutable|exact reviewed/,
        changed,
      );
});

// These are independent historical pins. No predecessor inventory is regenerated.
const immutablePins: Record<string, string> = {
  'test/fixtures/framework7-notifications-before-actions.json':
    '2fd4d3c0a456be925aa3b69668a931f1bfb127485b498fc638101b8b812cb549',
  'test/fixtures/framework7-notifications-before-protected.json':
    '6bbc2023784fc6b2cdf0a0f727472f77ec823759b9def8331c74eacfe203bada',
  'test/fixtures/framework7-discussions-before-actions.json':
    '75315012d59d1edf832158d4b1a30bb99cd7bb663414099fa0b7653beec145dc',
  'test/fixtures/framework7-discussions-before-protected.json':
    '3bc0b16593d7d2e2daeebe9fd4bb7ccd51f737de7fe9a531f1b327e8f6616ab8',
  'test/fixtures/framework7-ratings-before-actions.json':
    '48eee3934c2962ee1e065551a15e25cd8e88a375e998cfca72065b9f8fc908ad',
  'test/fixtures/framework7-ratings-before-protected.json':
    '4bf6ace63c71d3bb2623edc5e957037383075a1d48439b31f6de24cb0b613455',
  'test/fixtures/framework7-rating-recovery-before-actions.json':
    '0be8a6ee1335b4842178a6d70d23f56cc0ce919a3989fe53b2b0b0cec47f2db2',
  'test/fixtures/framework7-rating-recovery-before-protected.json':
    '702ad98406037a0238bfa4e80aa22358f5dd174bc009eb22eca9fde5ec1c1f10',
  'test/fixtures/framework7-school-operations-before-actions.json':
    '1e708ae719edd941ce2a5f5fadc7b1a5039aeb6512e920c85cd85a1cf6a43f32',
  'test/fixtures/framework7-school-operations-before-protected.json':
    '80084b29c9b03cff5d6d3652761fb8ed505a2d7c856f864b1fa712fb06be7573',
  'test/fixtures/framework7-errands-before-actions.json':
    'c6d241561a164cb15734d020d64b31a7781b33d3519f2e8c50ff19148361f8b9',
  'test/fixtures/framework7-errands-before-protected.json':
    '6bea23adda8bd16f7ab5f8125c1f26c4e8aa2a49553c78dc57a40a6bf5b36b7d',
  'test/fixtures/framework7-moderation-before-actions.json':
    'fecdfa59604dd25e2edd7790f9a03f0522a13d3e5a4a6bbbc177bc74333245b9',
  'test/fixtures/framework7-moderation-before-protected.json':
    '88b09359d6a62daa4f686a6cac76ffb690a1a49fb49782417cddf96e154c54b8',
  'test/fixtures/framework7-support-before-actions.json':
    'f946196852841ff1aec513681e6545888469e107d1de5861633509188ac0322c',
  'test/fixtures/framework7-support-before-protected.json':
    '811167d3767fe8d370eee9722f8815c4ce95801be813b5c406d01e958da41766',
  'test/fixtures/notification-details-action-inventory.json':
    '04765a4c1f817fe4e9bd104c53e4de6feb72a6c40bf47dc0a30127f8f3a92b3d',
  'test/fixtures/rating-management-action-inventory.json':
    '274e84f48d0e7d885c58368926a0bb9961c61ae7f295fe2d38866bc5651aef33',
  'test/fixtures/business-successor-v33c.json':
    '0d5a3671481a36e3bf884d421c6999594eaee8024a99796b0863f1cd6aa4c1ca',
  'test/fixtures/reviewed-social-successor-v33c/manifest.json':
    '6396a37239db04dade540b86620cb975e951ff89c75cc0b6e8c40d82ca245926',
  'test/fixtures/reviewed-notice-read-successor/manifest.json':
    'ce365ec5df64fd0e9893d4a36dda54e342b3452982944cd943224d13861b3372',
  'test/fixtures/reviewed-reference-successor/manifest.json':
    'b0bad6e8817cffc9d2c4d9c8a0f45e45526fdfc18f55008b3b4d6e0562e29f14',
  'test/reviewed-business-successor.ts':
    '0899865979024ce96fc723218bd895b1ec660cc906121f1639a7fe3c34f495b8',
};
test('all affected original action/protected inventories and successor manifests remain immutable', () => {
  assert.equal(Object.keys(immutablePins).length, 23);
  for (const [file, hash] of Object.entries(immutablePins))
    assert.equal(sha(read(file)), hash, file);
});

test('manual omission keeps the original cancellation identity and subscribers; an optional exposure fence only narrows dispatch', () => {
  const original = new Cancellation();
  let notifications = 0;
  original.subscribe(() => notifications++);
  const manual = guardNoticeRead(original);
  assert.equal(manual, original);
  let current = true;
  const guarded = guardNoticeRead(original, () => current);
  assert.notEqual(guarded, original);
  assert.equal(guarded.isCancelled, false);
  current = false;
  assert.equal(guarded.isCancelled, true);
  assert.equal(
    original.isCancelled,
    false,
    'an exposure fence must not cancel an independent manual attempt',
  );
  current = true;
  assert.equal(
    guarded.isCancelled,
    true,
    'the invalid attempt cannot be revived',
  );
  assert.throws(
    () => guardNoticeRead(original, () => false),
    (error: unknown) =>
      error instanceof ClientError && error.kind === 'cancelled',
  );
  original.cancel();
  assert.equal(notifications, 1);
  assert.equal(manual.isCancelled, true);
  assert.equal(guardNoticeRead(original), original);
});

const requireNative = createRequire(__filename);
type Event = { currentTarget: { dataset: { id: string; source: string } } };
interface ManualPage {
  onRead(event: Event): void;
  onOpen(event: Event): void;
  onMore(event: Event): void;
  onCancel(): void;
  noticeExposure?: { clear(): void };
  controller?: {
    acknowledge(...args: unknown[]): Promise<void>;
    open(...args: unknown[]): Promise<void>;
    more(...args: unknown[]): Promise<void>;
    cancel(...args: unknown[]): void;
  };
}
for (const name of ['social-notices', 'system-notices'])
  test(`${name}: live Page manual handlers keep exact target, default guard omission, pagination and cancel authority`, async () => {
    const previous = Reflect.get(globalThis, 'Page');
    let page: ManualPage | undefined;
    Reflect.set(globalThis, 'Page', (definition: ManualPage) => {
      page = definition;
    });
    const file = path.resolve(__dirname, `../src/pages/${name}/${name}.ts`);
    try {
      delete requireNative.cache[requireNative.resolve(file)];
      requireNative(file);
      assert.ok(page);
      const calls: unknown[][] = [];
      const record =
        (action: string) =>
        (...args: unknown[]) => {
          calls.push([action, ...args]);
          return Promise.resolve();
        };
      page.noticeExposure = {
        clear: () => {
          calls.push(['clear']);
        },
      };
      page.controller = {
        acknowledge: record('acknowledge'),
        open: record('open'),
        more: record('more'),
        cancel: record('cancel'),
      };
      const selected = 'source:77777777-7777-4777-8777-777777777777';
      const event = {
        currentTarget: { dataset: { id: selected, source: 'source' } },
      };
      page.onRead(event);
      page.onOpen(event);
      page.onMore(event);
      page.onCancel();
      await Promise.resolve();
      assert.deepEqual(calls, [
        ['clear'],
        ['acknowledge', selected],
        ['clear'],
        ['open', selected],
        ['clear'],
        name === 'social-notices' ? ['more', 'source'] : ['more'],
        ['clear'],
        ['cancel'],
      ]);
      calls.length = 0;
      delete page.noticeExposure;
      page.onRead(event);
      assert.deepEqual(
        calls,
        [['acknowledge', selected]],
        'missing observer never disables manual read',
      );
      delete page.controller;
      page.onRead(event);
      page.onOpen(event);
      page.onMore(event);
      page.onCancel();
      assert.deepEqual(
        calls,
        [['acknowledge', selected]],
        'disposed owner never dispatches',
      );
    } finally {
      delete requireNative.cache[requireNative.resolve(file)];
      if (previous === undefined) Reflect.deleteProperty(globalThis, 'Page');
      else Reflect.set(globalThis, 'Page', previous);
    }
  });
