import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assertReadingActionDelta,
  assertReviewedReadingSuccessor,
  assertReviewedBusinessSuccessor,
  assertReviewedReferenceSuccessor,
  readingEvidenceRoot,
  readingPredecessor,
  readingSuccessors,
  nullableReadingProofPaths,
  cssReadingProofPaths,
  reviewedReferencePresentation,
} from './reviewed-reading-successor';
const read = (file: string) => readFileSync(path.join(__dirname, '..', file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
for (const entry of readingSuccessors) {
  test(`${entry.path}: exact immediate source successor, old before hash and bounded aliases`, () => {
    assert.ok(entry.reason);
    for (const alias of [entry.path, `apps/wechat/${entry.path}`]) {
      assert.equal(assertReviewedReadingSuccessor(alias, entry.before), true);
      assert.equal(
        sha(readingPredecessor(alias, read(entry.path))),
        entry.before,
      );
    }
    const noRead = () => {
      throw new Error('invalid alias/hash must not read proof');
    };
    for (const wrong of [
      '',
      '0'.repeat(64),
      entry.after,
      entry.before.toUpperCase(),
    ])
      assert.equal(
        assertReviewedReadingSuccessor(entry.path, wrong, noRead),
        false,
      );
    for (const wrong of [
      `./${entry.path}`,
      `other/${entry.path}`,
      `src/../${entry.path}`,
      `${entry.path}/`,
      `${entry.path}.bak`,
      entry.path.toUpperCase(),
      'constructor',
      '__proto__',
      'src/app.json',
    ])
      assert.equal(
        assertReviewedReadingSuccessor(wrong, entry.before, noRead),
        false,
      );
  });
}
test('every source, added implementation, predecessor, delta and manifest link is independently authenticated', () => {
  const first = readingSuccessors[0]!;
  const manifest = JSON.parse(
    read(`${readingEvidenceRoot}/manifest.json`).toString('utf8'),
  ) as { added: { path: string }[] };
  const corruptions = [
    `${readingEvidenceRoot}/manifest.json`,
    `${readingEvidenceRoot}/predecessor-manifest.json.gz`,
    `${readingEvidenceRoot}/native-source.patch`,
    ...nullableReadingProofPaths,
    ...cssReadingProofPaths,
    ...readingSuccessors.flatMap((entry) => [
      entry.path,
      `${readingEvidenceRoot}/${entry.evidence}`,
    ]),
    ...manifest.added.map((entry) => entry.path),
  ];
  for (const target of corruptions)
    assert.throws(
      () =>
        assertReviewedReadingSuccessor(first.path, first.before, (file) => {
          const bytes = read(file);
          if (file === target) bytes[0] = bytes[0]! ^ 1;
          return bytes;
        }),
      target,
    );
});
test('only the two explicit immutable business-history links compose; all old proof/helper bytes remain unchanged', () => {
  const manifest = JSON.parse(
    read('test/fixtures/business-successor-v33c.json').toString('utf8'),
  ) as { sources: Record<string, { before: string; evidence: string }> };
  for (const file of [
    'src/community/contract.ts',
    'src/pages/community-detail/controller.ts',
  ]) {
    const entry = manifest.sources[file]!;
    assert.equal(assertReviewedBusinessSuccessor(file, entry.before), true);
    assert.equal(
      assertReviewedBusinessSuccessor(`apps/wechat/${file}`, entry.before),
      true,
    );
    assert.equal(assertReviewedBusinessSuccessor(file, '0'.repeat(64)), false);
    for (const corrupted of [
      'test/reviewed-business-successor.ts',
      'test/fixtures/business-successor-v33c.json',
      entry.evidence,
      file,
    ])
      assert.throws(() =>
        assertReviewedBusinessSuccessor(file, entry.before, (target) =>
          target === corrupted ? Buffer.from('corrupt') : read(target),
        ),
      );
  }
  assert.equal(
    sha(read('test/reviewed-business-successor.ts')),
    '0899865979024ce96fc723218bd895b1ec660cc906121f1639a7fe3c34f495b8',
  );
  assert.equal(
    sha(read('test/fixtures/business-successor-v33c.json')),
    '0d5a3671481a36e3bf884d421c6999594eaee8024a99796b0863f1cd6aa4c1ca',
  );
  assert.equal(
    assertReviewedReferenceSuccessor(
      'apps/wechat/src/pages/community-detail/community-detail.ts',
      '4496433d8ff570b537e2cd20c129a0a122fc85c15a12476a2654abbe949136cc',
    ),
    true,
  );
  assert.equal(
    reviewedReferencePresentation('src/unknown.wxml', 'unreviewed'),
    'unreviewed',
  );
});
for (const page of [
  'community-detail',
  'community-thread',
  'community-compose',
]) {
  test(`${page}: exact full original tree survives; source actions/conditions/ancestors are not generic exclusions`, () => {
    const file = `src/pages/${page}/${page}.wxml`,
      entry = readingSuccessors.find((item) => item.path === file)!;
    const before = read(`${readingEvidenceRoot}/${entry.evidence}`).toString(
        'utf8',
      ),
      current = read(file).toString('utf8');
    assertReadingActionDelta(file, before, current);
    const variants =
      page === 'community-detail'
        ? [
            current.replace(
              'reply.readingBody &amp;&amp; reply.readingBody.classification',
              'reply.readingBody.classification',
            ),
            current.replace(' &amp;&amp; !reply.readingUseReferences', ''),
            current.replace(
              'data-row-key="{{\'reply:\' + reply.id}}"',
              'data-row-key="{{\'reply:\' + locatedReplyId}}"',
            ),
            current.replace(
              'data-generation="{{references.generation}}"',
              'data-generation="{{0}}"',
            ),
            current.replace('bindtap="onSourceThread"', 'bindtap="onAuthor"'),
            current.replace(
              'bind:plaintextpress="onReferenceThread"',
              'bind:plaintextpress="onSourceThread"',
            ),
            current.replace(
              'bind:referencepress="onReferencePress"',
              'bind:referencepress="onAuthor"',
            ),
            current.replace(
              '<view class="comment-actions">',
              '<view class="comment-actions" hidden="{{busy}}">',
            ),
            current.replace("item.author.kind === 'named'", 'true'),
            current.replace(
              '<wu-source-text',
              '<wu-source-text bindtap="onSourceThread"',
            ),
          ]
        : page === 'community-thread'
          ? [
              current.replace(
                'reply.readingBody &amp;&amp; reply.readingBody.classification',
                'reply.readingBody.classification',
              ),
              current.replace(
                "root.readingBody.classification === 'reviewedSource'",
                'true',
              ),
              current.replace(
                'presentation="{{root.readingBody.value}}"',
                'presentation="{{reply.readingBody.value}}"',
              ),
              current.replace(
                '<view wx:else class="body">{{reply.text}}</view>',
                '<view wx:else class="body">{{root.text}}</view>',
              ),
              current.replace(
                '<wu-source-text',
                '<wu-source-text bindtap="onSourceThread"',
              ),
            ]
          : [
              current.replace('data-format="markdown"', 'data-format="legacy"'),
              current.replace(
                "{{textSource &amp;&amp; textSource.format === 'markdown' ? 'tonal' : 'plain'}}",
                "{{textSource.format === 'markdown' ? 'tonal' : 'plain'}}",
              ),
              current.replace(
                'wx:if="{{textSource &amp;&amp; textSource.format === \'plain\'}}"',
                'wx:if="{{textSource.format === \'plain\'}}"',
              ),
              current.replace(
                'disabled="{{frozen || busy}}" color="#007aff"',
                'disabled="{{busy}}" color="#007aff"',
              ),
              current.replace(
                'descriptor="{{textSource}}"',
                'descriptor="{{otherDescriptor}}"',
              ),
              current.replace(
                'bindinput="onText"',
                'bindinput="onSourceFormat"',
              ),
              current.replace(
                'wx:if="{{canChooseTextSource || textSource}}"',
                'wx:if="{{true}}"',
              ),
            ];
    for (const variant of variants) {
      assert.notEqual(
        variant,
        current,
        'negative mutation must reach its intended field',
      );
      assert.throws(() => assertReadingActionDelta(file, before, variant));
      assert.throws(() => reviewedReferencePresentation(file, variant));
    }
    assert.throws(() =>
      assertReadingActionDelta('src/unknown.wxml', before, current),
    );
  });
}

test('exact source CSS whitespace successor composes without widening the original added-owner inventory', () => {
  const file = 'src/components/source-text/source-text.wxss';
  const first = readingSuccessors[0]!;
  const before = read(cssReadingProofPaths[1]!);
  const formatted = read(file);
  assert.equal(
    sha(before),
    '695e578ea70d80c0f4a0e25685385fd41dfbd716fd64ee1d31fb8a35ac16e7c9',
  );
  assert.equal(
    sha(formatted),
    '129aa69ca79967d205824f520b6c67d52315d783bd71aa4937f5bce69148881b',
  );
  assert.equal(assertReviewedReadingSuccessor(first.path, first.before), true);
  // Original bytes need no new formatting proof; the historical owner seal
  // still authenticates them. No arbitrary whitespace variant is accepted.
  assert.equal(
    assertReviewedReadingSuccessor(first.path, first.before, (target) => {
      assert.equal(cssReadingProofPaths.includes(target), false);
      return target === file ? before : read(target);
    }),
    true,
  );
  const current = formatted.toString('utf8');
  const variants = [
    current.replace('#007aff', '#ff0000'),
    current.replace('.source-toggle[disabled]', '.source-toggle'),
    current.replace(
      '.source-mode-formatted .source-block',
      '.source-mode-formatted.source-block',
    ),
    current.replace('font-size: 1.4em;', 'font-size: 1.5em;'),
    current.replace('word-break: break-word;', 'white-space: normal;'),
    current.replace('.source-raw {\n  display: block;\n}\n', ''),
    current.replace(
      '  color: inherit;\n  font: inherit;',
      '  font: inherit;\n  color: inherit;',
    ),
    current + '.unexpected { color: red; }\n',
    current + '\n',
  ];
  for (const changed of variants) {
    assert.notEqual(
      changed,
      current,
      'negative mutation reaches its CSS field',
    );
    assert.throws(
      () =>
        assertReviewedReadingSuccessor(first.path, first.before, (target) =>
          target === file ? Buffer.from(changed) : read(target),
        ),
      /exact formatted source CSS/,
    );
  }
  // The new edge does not permit modified or extra owners in the immutable list.
  for (const other of [
    'src/components/source-text/source-text.wxml',
    'src/community/text-source-renderer.ts',
  ]) {
    assert.throws(
      () =>
        assertReviewedReadingSuccessor(first.path, first.before, (target) =>
          target === other
            ? Buffer.concat([read(target), Buffer.from('\n')])
            : read(target),
        ),
      /exact added reading owner/,
    );
  }
  for (const unknown of [
    'src/components/source-text/extra.wxss',
    'src/components/source-text/source-text.wxss.bak',
    './src/components/source-text/source-text.wxss',
  ]) {
    const unread = () => {
      throw new Error('unknown path must not consult proof');
    };
    assert.equal(
      assertReviewedReadingSuccessor(unknown, sha(before), unread),
      false,
    );
    assert.equal(readingPredecessor(unknown, formatted, unread), formatted);
  }
  // Neither an extra inventory entry nor any changed proof link can be admitted.
  const manifestFile = `${readingEvidenceRoot}/manifest.json`;
  const inventory = JSON.parse(read(manifestFile).toString('utf8')) as {
    added: { path: string; sha256: string }[];
  };
  inventory.added.push({
    path: 'src/components/source-text/extra.wxss',
    sha256: sha(formatted),
  });
  assert.throws(
    () =>
      assertReviewedReadingSuccessor(first.path, first.before, (target) =>
        target === manifestFile
          ? Buffer.from(JSON.stringify(inventory))
          : read(target),
      ),
    /immutable reading successor manifest/,
  );
});
