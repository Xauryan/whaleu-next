import { readingPredecessor } from './reviewed-reading-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  ContentReferenceController,
  initialReferenceView,
  type ReferencePress,
} from '../src/content-references/controller';
import { detailReferenceRows } from '../src/content-references/detail-rows';
import { initialDetailView } from '../src/pages/community-detail/controller';
import { post, comment, reply, spaceId } from './community-helpers';
import { signedIn } from './helpers';
import type { PresentationNode } from './framework7-action-parity';
import {
  assertReferenceActionDelta,
  assertReviewedReferenceSuccessor,
  referenceEvidenceRoot,
  referencePage,
  referenceSuccessors,
  reviewedReferencePresentation,
} from './reviewed-reading-successor';

const read = (file: string) => readFileSync(path.join(__dirname, '..', file));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const requireNative = createRequire(__filename);
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as {
  parsePreviewWxml(source: string): PresentationNode;
};
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
const beforeWxml = read(
  `${referenceEvidenceRoot}/before/community-detail.wxml.txt`,
).toString('utf8');
const currentWxml = read(`${referencePage}.wxml`).toString('utf8');
const afterWxml = readingPredecessor(
  `${referencePage}.wxml`,
  Buffer.from(currentWxml),
).toString('utf8');

for (const entry of referenceSuccessors) {
  const file = entry.path.slice('apps/wechat/'.length);
  test(`${file}: authenticated before/after and fail-closed path/hash aliases`, () => {
    assert.equal(
      sha(read(`${referenceEvidenceRoot}/${entry.evidence}`)),
      entry.before,
    );
    assert.equal(sha(readingPredecessor(file, read(file))), entry.after);
    for (const alias of [file, entry.path])
      assert.equal(assertReviewedReferenceSuccessor(alias, entry.before), true);
    const unexpectedRead = () => {
      throw new Error('Unexpected read');
    };
    for (const invalid of [
      '',
      '0'.repeat(64),
      entry.after,
      entry.before.toUpperCase(),
    ])
      assert.equal(
        assertReviewedReferenceSuccessor(file, invalid, unexpectedRead),
        false,
      );
    for (const invalid of [
      `./${file}`,
      `other/${file}`,
      `src/../${file}`,
      `${file}/`,
      `${file}.bak`,
      file.toUpperCase(),
      file.slice(4),
      'constructor',
      '__proto__',
      'src/app.json',
    ])
      assert.equal(
        assertReviewedReferenceSuccessor(invalid, entry.before, unexpectedRead),
        false,
      );
    for (const corrupted of [
      file,
      `${referenceEvidenceRoot}/${entry.evidence}`,
    ])
      assert.throws(() =>
        assertReviewedReferenceSuccessor(file, entry.before, (target) => {
          const bytes = read(target);
          if (target === corrupted) bytes[0] = bytes[0]! ^ 1;
          return bytes;
        }),
      );
  });
}

test('the complete immediate predecessor seal and reviewed delta cannot be replaced or self-refreshed', () => {
  const entry = referenceSuccessors[0]!;
  const seal = `${referenceEvidenceRoot}/predecessor-manifest.json.gz`;
  const manifest = `${referenceEvidenceRoot}/manifest.json`;
  for (const corrupted of [seal, manifest])
    assert.throws(
      () =>
        assertReviewedReferenceSuccessor(entry.path, entry.before, (target) => {
          if (target !== corrupted) return read(target);
          return target === seal
            ? gzipSync(
                Buffer.concat([gunzipSync(read(target)), Buffer.from('\n')]),
              )
            : Buffer.from(
                read(target)
                  .toString('utf8')
                  .replace(entry.after, '0'.repeat(64)),
              );
        }),
      /immutable reference successor manifest|immutable V35B predecessor manifest/,
    );
});

test('143 complete raw actions and ancestor chains survive; only the four exact renderers replace old text', () => {
  assertReferenceActionDelta(beforeWxml, afterWxml);
  assert.equal(
    reviewedReferencePresentation(`${referencePage}.wxml`, currentWxml),
    beforeWxml,
  );
  assert.equal(
    reviewedReferencePresentation('src/unknown.wxml', 'unreviewed'),
    'unreviewed',
  );
  assert.throws(
    () =>
      reviewedReferencePresentation(
        `${referencePage}.wxml`,
        currentWxml + '\n',
      ),
    /exact reading presentation successor/,
  );
});

test('unknown actions, removed datasets, altered permissions, outer ancestors and extra/moved renderers fail closed', () => {
  const variants = [
    afterWxml.replace('bindtap="onAuthorAvatar"', 'bindtap="onUnreviewed"'),
    afterWxml.replace('data-kind="comment"', 'data-kind="reply"'),
    afterWxml.replace(
      'wx:if="{{item.author.kind === \'named\'}}"',
      'wx:if="{{true}}"',
    ),
    afterWxml.replace(
      '<view class="comment-actions">',
      '<view class="comment-actions" hidden="{{busy}}">',
    ),
    afterWxml.replace(
      'bind:referencepress="onReferencePress"',
      'bind:referencepress="onUnreviewed"',
    ),
    afterWxml.replace(
      'bind:plaintextpress="onReferenceThread"',
      'bind:plaintextpress="onUnreviewed"',
    ),
    afterWxml.replace('fallback="{{true}}"', 'fallback="{{false}}"'),
    afterWxml.replace(
      '<view class="body"><wu-reference-text',
      '<view class="body" wx:if="{{busy}}"><wu-reference-text',
    ),
    afterWxml + '<wu-reference-text source="unreviewed" />',
    afterWxml + '<button bindtap="onUnreviewed">new action</button>',
    afterWxml.replace(
      /<wu-reference-text source="\{\{post.text\}\}"[^>]*\/>/,
      '',
    ),
  ];
  for (const candidate of variants) {
    assert.notEqual(
      candidate,
      afterWxml,
      'mutation must exercise the intended guard',
    );
    assert.throws(() => assertReferenceActionDelta(beforeWxml, candidate));
  }
  const wrappers = afterWxml.replace(
    '<view class="body"><wu-reference-text',
    '<view class="body" data-unreviewed="true"><wu-reference-text',
  );
  assert.throws(
    () => assertReferenceActionDelta(beforeWxml, wrappers),
    /original full ancestor gates/,
  );
});

interface ComponentInstance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>): void;
  triggerEvent(name: string, detail: ReferencePress, options: unknown): void;
}
type ComponentMethod = (this: ComponentInstance, event?: unknown) => void;
interface ComponentDefinition {
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, ComponentMethod>;
  lifetimes: Record<string, ComponentMethod>;
}
interface PageInstance {
  data: Record<string, unknown>;
  referenceController: ContentReferenceController;
  referenceInteractionBlocked(): boolean;
}
interface PageDefinition {
  data: Record<string, unknown>;
  referenceInteractionBlocked(this: PageInstance): boolean;
  onReferenceThread(
    this: PageInstance,
    event: { detail: ReferencePress },
  ): void;
}
function registration<T>(kind: 'Page' | 'Component', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals[kind];
  const resolved = requireNative.resolve(file);
  let definition: T | undefined;
  try {
    globals[kind] = (value: T) => {
      definition = value;
    };
    delete requireNative.cache[resolved];
    requireNative(resolved);
  } finally {
    if (previous === undefined) delete globals[kind];
    else globals[kind] = previous;
    delete requireNative.cache[resolved];
  }
  assert.ok(definition);
  return definition;
}

for (const kind of ['reply', 'locatedComment'] as const)
  test(`${kind}: actual component and Page plaintext fallback preserve the authenticated navigator URL exactly`, () => {
    const oldNavigator = flatten(parse(beforeWxml)).find(
      (node) =>
        node.tag === 'navigator' &&
        node.children.some(
          (child) =>
            typeof child === 'string' &&
            child.includes(`{{${kind}.text || '查看图片回复'}}`),
        ),
    )!;
    const renderer = flatten(parse(afterWxml)).find(
      (node) =>
        node.tag === 'wu-reference-text' &&
        node.attrs.source === `{{${kind}.text}}`,
    )!;
    assert.ok(oldNavigator);
    assert.ok(renderer);
    assert.equal(renderer.attrs['bind:plaintextpress'], 'onReferenceThread');
    assert.equal(renderer.attrs.fallback, '{{true}}');
    assert.equal(renderer.attrs.placeholder, '查看图片回复');
    const pageDefinition = registration<PageDefinition>(
      'Page',
      '../src/pages/community-detail/community-detail.ts',
    );
    const componentDefinition = registration<ComponentDefinition>(
      'Component',
      '../src/components/reference-text/reference-text.ts',
    );
    for (const scope of [undefined, spaceId]) {
      for (const text of ['原始正文 #1234567', '']) {
        const root = comment({
          text,
          replyPreview: { items: [reply({ text })], nextCursor: null },
        });
        const view = {
          ...initialDetailView(),
          loaded: true,
          post: post(),
          comments: [root],
          locatedComment: root,
        };
        const prior = structuredClone(view);
        const rows = detailReferenceRows(view);
        const row = rows.find(
          (candidate) =>
            candidate.kind === (kind === 'reply' ? 'reply' : 'comment'),
        )!;
        const calls: string[] = [];
        let referenceView = initialReferenceView();
        const controller = new ContentReferenceController(
          { sessions: signedIn() },
          undefined,
          {
            navigateTo: (options) => {
              calls.push(options.url);
              options.success();
            },
          },
          (next) => {
            referenceView = next;
          },
          scope,
        );
        controller.reconcile(rows, 1);
        const page: PageInstance = {
          data: { ...structuredClone(pageDefinition.data), loaded: true },
          referenceController: controller,
          referenceInteractionBlocked() {
            return pageDefinition.referenceInteractionBlocked.call(this);
          },
        };
        assert.equal(page.referenceInteractionBlocked(), false);
        const events: {
          name: string;
          detail: ReferencePress;
          options: unknown;
        }[] = [];
        const bindings: Record<string, unknown> = {
          '{{reply.text}}': root.replyPreview.items[0]!.text,
          '{{locatedComment.text}}': root.text,
          "{{'reply:' + reply.id}}": `reply:${root.replyPreview.items[0]!.id}`,
          "{{'comment:' + locatedComment.id}}": `comment:${root.id}`,
          '{{references.generation}}': referenceView.generation,
          '{{references.available}}': referenceView.available,
          '{{true}}': true,
        };
        const binding = (attribute: string) => {
          const expression = renderer.attrs[attribute]!;
          assert.ok(Object.prototype.hasOwnProperty.call(bindings, expression));
          return bindings[expression];
        };
        const instance: ComponentInstance = {
          properties: {
            ...Object.fromEntries(
              Object.entries(componentDefinition.properties).map(
                ([key, value]) => [key, value.value],
              ),
            ),
            source: binding('source'),
            rowKey: binding('row-key'),
            generation: binding('generation'),
            available: binding('available'),
            fallback: binding('fallback'),
            placeholder: renderer.attrs.placeholder,
          },
          data: structuredClone(componentDefinition.data),
          setData(value) {
            Object.assign(this.data, value);
          },
          triggerEvent(name, detail, options) {
            events.push({ name, detail, options });
            assert.equal(name, 'plaintextpress');
            pageDefinition.onReferenceThread.call(page, { detail });
          },
        };
        for (const [name, method] of Object.entries(
          componentDefinition.methods,
        ))
          instance[name] = method.bind(instance);
        componentDefinition.lifetimes.attached!.call(instance);
        componentDefinition.methods.onTap!.call(instance, {
          currentTarget: {
            dataset: { index: text ? 0 : -1, revision: instance.data.revision },
          },
        });
        const values: Record<string, string> = {
          'post.id': view.post.id,
          'item.id': root.id,
          'reply.id': root.replyPreview.items[0]!.id,
          'locatedComment.id': root.id,
          viewSpaceQuery: scope ? `&viewSpaceId=${scope}` : '',
        };
        const originalUrl = oldNavigator.attrs.url!.replace(
          /\{\{([^}]+)\}\}/g,
          (_match, expression: string) => {
            assert.ok(
              Object.prototype.hasOwnProperty.call(values, expression),
              `known old URL expression: ${expression}`,
            );
            return values[expression]!;
          },
        );
        assert.deepEqual(calls, [originalUrl]);
        assert.deepEqual(events, [
          {
            name: 'plaintextpress',
            detail: {
              rowKey: `${row.kind}:${row.targetId}`,
              generation: referenceView.generation,
            },
            options: { bubbles: false, composed: false },
          },
        ]);
        assert.deepEqual(
          view,
          prior,
          'no original body, cursor, permission or read state changes',
        );
        controller.dispose();
      }
    }
  });

test('historical inventories and previous business successor proofs are still byte-identical', () => {
  const pins = {
    'test/fixtures/framework7-composer-before-actions.json':
      '357870457423c65d3c87379c751e586120381d835ccbd3078d19a3fb9f019309',
    'test/fixtures/framework7-composer-before-protected.json':
      '0f5c60ae41c6c243f167fd990a4099581a757daaed234dc5d6dbb604f158d73b',
    'test/fixtures/business-successor-v33c.json':
      '0d5a3671481a36e3bf884d421c6999594eaee8024a99796b0863f1cd6aa4c1ca',
    'test/reviewed-business-successor.ts':
      '0899865979024ce96fc723218bd895b1ec660cc906121f1639a7fe3c34f495b8',
  };
  for (const [file, expected] of Object.entries(pins))
    assert.equal(sha(read(file)), expected, file);
});
