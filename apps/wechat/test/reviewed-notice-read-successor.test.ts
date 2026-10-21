import {
  exposureSuccessors,
  reviewedExposurePredecessor,
} from './reviewed-notice-exposure-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import type { PresentationNode } from './framework7-action-parity';
import {
  assertReviewedNoticeReadSuccessor,
  noticeEvidenceRoot,
  noticeSuccessors,
  reviewedNoticePresentation,
} from './reviewed-notice-read-successor';
import { assertReviewedSocialSuccessor } from './reviewed-social-successor';
const read = (file: string) => readFileSync(path.join(__dirname, '..', file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const { parsePreviewWxml: parse } = createRequire(__filename)(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
function actions(
  node: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const own = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) =>
      [
        'wx:if',
        'wx:elif',
        'wx:else',
        'wx:for',
        'wx:for-item',
        'wx:for-index',
        'wx:key',
        'hidden',
      ].includes(key),
    ),
  );
  const scopes = Object.keys(own).length ? [...parents, own] : parents;
  return [
    ...(node.tag === 'navigator' ||
    Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key))
      ? [{ tag: node.tag, attrs: node.attrs, scopes }]
      : []),
    ...node.children.flatMap((child) =>
      typeof child === 'string' ? [] : actions(child, scopes),
    ),
  ];
}
for (const [file, entry] of Object.entries(noticeSuccessors)) {
  test(`${file}: exact before/after transition and fail-closed aliases`, () => {
    assert.equal(sha(read(entry.evidence)), entry.before);
    assert.equal(
      sha(
        file in exposureSuccessors
          ? reviewedExposurePredecessor(file, entry.after)
          : read(file),
      ),
      entry.after,
    );
    for (const alias of [file, `apps/wechat/${file}`, file.slice(4)])
      assert.equal(
        assertReviewedNoticeReadSuccessor(alias, entry.before),
        true,
      );
    for (const wrong of [
      '',
      '0'.repeat(64),
      entry.after,
      entry.before.toUpperCase(),
    ])
      assert.equal(
        assertReviewedNoticeReadSuccessor(file, wrong, () => {
          throw new Error('Unexpected read');
        }),
        false,
      );
    for (const wrong of [
      `./${file}`,
      `other/${file}`,
      `src/../${file}`,
      `${file}/`,
      `${file}.bak`,
      file.toUpperCase(),
      'constructor',
      '__proto__',
      'src/app.json',
    ])
      assert.equal(
        assertReviewedNoticeReadSuccessor(wrong, entry.before, () => {
          throw new Error('Unexpected read');
        }),
        false,
      );
    for (const changed of [file, entry.evidence])
      assert.throws(
        () =>
          assertReviewedNoticeReadSuccessor(file, entry.before, (target) =>
            target === changed
              ? Buffer.concat([read(target), Buffer.from('\n// unreviewed')])
              : read(target),
          ),
        /immutable explicit-read predecessor|exact reviewed (explicit-read|exposure) successor/,
      );
  });
}
test('V33C to social to explicit-read is an authenticated chain, not replacement evidence', () => {
  const file = 'src/ratings/discussion-controller.ts';
  const reads: string[] = [];
  assert.equal(
    assertReviewedSocialSuccessor(
      file,
      '10ef6d1187d652037e0accbbf8a70a391f3ef573b326bb276030c4dc0c8baeaa',
      (target) => {
        reads.push(target);
        return read(target);
      },
    ),
    true,
  );
  assert.deepEqual(reads, [
    `test/fixtures/reviewed-social-successor-v33c/${file}.txt`,
    `${noticeEvidenceRoot}/${file}.txt`,
    file,
  ]);
  for (const changed of reads)
    assert.throws(() =>
      assertReviewedSocialSuccessor(
        file,
        '10ef6d1187d652037e0accbbf8a70a391f3ef573b326bb276030c4dc0c8baeaa',
        (target) =>
          target === changed ? Buffer.from('corrupt') : read(target),
      ),
    );
});
test('exactly two reviewed explicit controls are added; every old raw action, component, attribute and ancestor gate survives', () => {
  const bytes = read(`${noticeEvidenceRoot}/new-f7-actions.json`);
  assert.equal(
    sha(bytes),
    '84fa207fc60451e115271383cb9d02b414982e03c242aeb1406ab9bc9010c68a',
  );
  const additions = JSON.parse(bytes.toString('utf8')) as {
    file: string;
    handler: string;
    actions: Action[];
  }[];
  assert.equal(additions.length, 2);
  for (const addition of additions) {
    const file = addition.file.slice('apps/wechat/'.length);
    const entry = noticeSuccessors[file]!;
    const before = actions(parse(read(entry.evidence).toString('utf8')));
    const after = actions(parse(read(file).toString('utf8')));
    const added = after.filter(
      (action) => action.attrs['bind:press'] === addition.handler,
    );
    assert.deepEqual(added, addition.actions);
    assert.equal(added.length, 1);
    assert.deepEqual(
      after.filter((action) => action.attrs['bind:press'] !== addition.handler),
      before,
    );
    assert.equal(
      reviewedNoticePresentation(file, read(file).toString('utf8')),
      read(entry.evidence).toString('utf8'),
    );
    assert.throws(
      () =>
        reviewedNoticePresentation(file, read(file).toString('utf8') + '\n'),
      /exact reviewed presentation successor/,
    );
  }
  assert.equal(
    reviewedNoticePresentation('src/unknown.wxml', 'unknown'),
    'unknown',
  );
});

test('all historical inventory and predecessor evidence bytes remain immutable', () => {
  const pins = {
    'test/fixtures/framework7-ratings-before-actions.json':
      '48eee3934c2962ee1e065551a15e25cd8e88a375e998cfca72065b9f8fc908ad',
    'test/fixtures/framework7-ratings-before-protected.json':
      '4bf6ace63c71d3bb2623edc5e957037383075a1d48439b31f6de24cb0b613455',
    'test/fixtures/framework7-rating-recovery-before-actions.json':
      '0be8a6ee1335b4842178a6d70d23f56cc0ce919a3989fe53b2b0b0cec47f2db2',
    'test/fixtures/framework7-rating-recovery-before-protected.json':
      '702ad98406037a0238bfa4e80aa22358f5dd174bc009eb22eca9fde5ec1c1f10',
    'test/fixtures/framework7-notifications-before-protected.json':
      '6bbc2023784fc6b2cdf0a0f727472f77ec823759b9def8331c74eacfe203bada',
    'test/fixtures/framework7-notifications-before-actions.json':
      '2fd4d3c0a456be925aa3b69668a931f1bfb127485b498fc638101b8b812cb549',
    'test/fixtures/notification-details-action-inventory.json':
      '04765a4c1f817fe4e9bd104c53e4de6feb72a6c40bf47dc0a30127f8f3a92b3d',
    'test/fixtures/rating-management-action-inventory.json':
      '274e84f48d0e7d885c58368926a0bb9961c61ae7f295fe2d38866bc5651aef33',
    'test/fixtures/business-successor-v33c-before-5.txt':
      '1f5ab7790886eb704da6cc004fa46a5e124c24ee249b6d3a5ae2cb724aff8fac',
    'test/fixtures/business-successor-v33c-before-3.txt':
      '5c2c2156f4eafc4d07ddd217ad25a838201e1a8c6ab5d9fcd11473dfdcc52f01',
    'test/fixtures/business-successor-v33c-before-1.txt':
      'c9261cf92a519f057452b895a70cec925670cda1df3605734fefe35b2644c2c8',
    'test/fixtures/business-successor-v33c-before-0.txt':
      '0698088457fad2bb9e327a3ef75645171a9cd62fbb3bcad793f31aefe2b14143',
    'test/fixtures/business-successor-v33c.json':
      '0d5a3671481a36e3bf884d421c6999594eaee8024a99796b0863f1cd6aa4c1ca',
    'test/fixtures/business-successor-v33c-before-4.txt':
      'f932c92ae444cf6450f7aa94db9653660ec757732ce9f9dd87db046a874f98c1',
    'test/fixtures/business-successor-v33c-before-2.txt':
      'd923b7c02d5c33457f431a160ef64dc70635afaa8fe1e5b92629651c4eec89b6',
    'test/fixtures/reviewed-social-successor-v33c/manifest.json':
      '6396a37239db04dade540b86620cb975e951ff89c75cc0b6e8c40d82ca245926',
    'test/fixtures/reviewed-social-successor-v33c/README.md':
      'a55ff3c1d6c4046ac51bdf924f07eac2d2b42785f39c17097d4e2a140f566579',
    'test/fixtures/reviewed-social-successor-v33c/src/ratings/discussion-controller.ts.txt':
      '10ef6d1187d652037e0accbbf8a70a391f3ef573b326bb276030c4dc0c8baeaa',
    'test/fixtures/reviewed-social-successor-v33c/src/pages/social-notices/controller.ts.txt':
      '87c2f441f64994bcda0e0cf19170bd8f591484f709c8d9febb9ffc1fd44c801e',
    'test/fixtures/reviewed-social-successor-v33c/src/pages/social-notices/social-notices.ts.txt':
      '0d45a96ae31b25f0aa411cc6a9167dc0f3e003c59d7f2e90201c4fb41c73925d',
    'test/reviewed-business-successor.ts':
      '0899865979024ce96fc723218bd895b1ec660cc906121f1639a7fe3c34f495b8',
  };
  for (const [file, hash] of Object.entries(pins))
    assert.equal(sha(read(file)), hash, file);
});
