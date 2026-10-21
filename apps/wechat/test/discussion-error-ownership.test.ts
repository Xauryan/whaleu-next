import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { ClientError } from '../src/api/errors';
import { communityError } from '../src/community/controller';
import { majorDiscussionError } from '../src/major-discussion/errors';
import { majorDiscussionError as legacyMajorError } from '../src/major-discussion/controller';
import { windowDiscussionError } from '../src/window-discussion/errors';
import { windowDiscussionError as legacyWindowError } from '../src/window-discussion/controller';

// Exact public messages frozen before the ownership-only extraction.
const majorMessages: Readonly<Record<string, string>> = {
  MAJOR_BASE_REQUIRED:
    '发表专业回复需要有效正式认证、临时认证或实际管理权限；浏览和点赞不要求同校认证',
  PHONE_VERIFICATION_REQUIRED:
    '请先验证手机号；原操作回执和自己的点赞仍可独立查询',
  MAJOR_CATALOG_UNAVAILABLE: '专业来源暂不能确认；原操作仍可独立恢复',
  MAJOR_NOT_FOUND: '专业当前不可查看；原操作仍可独立恢复',
  MAJOR_DISCUSSION_NOT_FOUND: '这条回复当前不可查看，请重新加载',
  MAJOR_DISCUSSION_BUDGET_UNAVAILABLE:
    '完整讨论当前无法核验，暂不展示不完整的内容或数量；这不代表没有回复',
  MAJOR_DISCUSSION_NOTICE_NOT_FOUND:
    '此通知不存在或不属于当前账号，请重新核验通知列表',
  DISCOVERY_RESTART_REQUIRED:
    '讨论或通知已变化，请从第一页重新核验；旧分页已清除',
  MAJOR_DISCUSSION_HISTORY_UNAVAILABLE:
    '回复或点赞历史暂不能确认，不能当作没有回复或零个赞',
  MAJOR_DISCUSSION_MEMBERSHIP_CONFLICT:
    '自己的点赞已在别处变化，请重新查询并明确确认',
  MAJOR_REVISION_CONFLICT: '专业目录已变化，请刷新后重新确认',
  MAJOR_DISCUSSION_CURSOR_INVALID: '分页已失效，请从第一页重新加载',
  MAJOR_DISCUSSION_RESTART_REQUIRED: '回复或排序已变化，请从第一页重新加载',
  MAJOR_DISCUSSION_TARGET_UNAVAILABLE:
    '这条通知的当前内容不可查看，未打开旧内容',
  REQUEST_NOT_FOUND: '暂未查到原回执；重试仍使用原请求，取消必须取得服务端回执',
  CONTENT_REVIEW_UNAVAILABLE:
    '当前内容审核暂不能确认；待确认的原请求仍可查询或明确取消',
  SAFETY_ACTION_RESTRICTED:
    '当前账号暂不能访问公开讨论；原回执和自己的点赞仍可独立查询',
};
const windowMessages: Readonly<Record<string, string>> = {
  PHONE_VERIFICATION_REQUIRED:
    '请先验证手机号；原操作回执和自己的点赞仍可独立查询',
  WINDOW_CATALOG_UNAVAILABLE: '窗口来源暂不能确认；原操作仍可独立恢复',
  WINDOW_NOT_FOUND: '窗口当前不可查看；原操作仍可独立恢复',
  WINDOW_DISCUSSION_NOT_FOUND: '这条回复当前不可查看，请重新加载',
  WINDOW_DISCUSSION_BUDGET_UNAVAILABLE:
    '完整讨论当前无法核验，暂不展示不完整的内容或数量；这不代表没有回复',
  WINDOW_DISCUSSION_NOTICE_NOT_FOUND:
    '此通知不存在或不属于当前账号，请重新核验通知列表',
  DISCOVERY_RESTART_REQUIRED:
    '讨论或通知已变化，请从第一页重新核验；旧分页已清除',
  WINDOW_DISCUSSION_HISTORY_UNAVAILABLE:
    '回复或点赞历史暂不能确认，不能当作没有回复或零个赞',
  WINDOW_DISCUSSION_MEMBERSHIP_CONFLICT:
    '自己的点赞已在别处变化，请重新查询并明确确认',
  WINDOW_REVISION_CONFLICT: '窗口目录已变化，请刷新后重新确认',
  WINDOW_DISCUSSION_CURSOR_INVALID: '分页已失效，请从第一页重新加载',
  WINDOW_DISCUSSION_RESTART_REQUIRED: '回复或排序已变化，请从第一页重新加载',
  WINDOW_DISCUSSION_TARGET_UNAVAILABLE:
    '这条通知的当前内容不可查看，未打开旧内容',
  REQUEST_NOT_FOUND: '暂未查到原回执；重试仍使用原请求，取消必须取得服务端回执',
  CONTENT_REVIEW_UNAVAILABLE:
    '当前内容审核暂不能确认；待确认的原请求仍可查询或明确取消',
  SAFETY_ACTION_RESTRICTED:
    '当前账号暂不能访问公开讨论；原回执和自己的点赞仍可独立查询',
};

function source(relative: string) {
  return readFileSync(path.join(__dirname, '../src', relative), 'utf8');
}
function runtimeRequires(relative: string): string[] {
  const javascript = ts.transpileModule(source(relative), {
    compilerOptions: {
      module: ts.ModuleKind.Node16,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: relative,
  }).outputText;
  const parsed = ts.createSourceFile(
    relative + '.js',
    javascript,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.JS,
  );
  const result: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      assert.equal(node.arguments.length, 1);
      const specifier = node.arguments[0];
      assert.ok(specifier && ts.isStringLiteral(specifier));
      result.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return result;
}

for (const [family, format, legacy, messages] of [
  ['major', majorDiscussionError, legacyMajorError, majorMessages],
  ['window', windowDiscussionError, legacyWindowError, windowMessages],
] as const) {
  test(
    family +
      ' formatter preserves every existing business message and controller export identity',
    () => {
      assert.equal(format, legacy);
      for (const [serverCode, expected] of Object.entries(messages)) {
        for (const kind of ['http', 'business'] as const) {
          const error = new ClientError(
            kind,
            'Private upstream message must not escape',
            { serverCode },
          );
          assert.equal(format(error), expected, serverCode);
          assert.equal(legacy(error), expected, serverCode);
          assert.equal(error.details.serverCode, serverCode);
        }
      }
    },
  );
  test(
    family + ' protocol failures cannot be relabeled by business server codes',
    () => {
      for (const serverCode of Object.keys(messages)) {
        const error = new ClientError('protocol', 'Private payload', {
          serverCode,
        });
        assert.equal(format(error), communityError(error), serverCode);
      }
    },
  );
  test(
    family +
      ' formatter retains generic fallback and never remembers another call',
    () => {
      for (const error of [
        undefined,
        null,
        'private upstream message',
        new Error('private upstream message'),
        new ClientError('network', 'private upstream message'),
        new ClientError('http', 'private upstream message', {
          serverCode: 'UNKNOWN_SERVER_CODE',
        }),
        new ClientError('cancelled', 'private upstream message'),
      ]) {
        const expected = communityError(error);
        assert.equal(format(error), expected);
        format(
          new ClientError('http', '', {
            serverCode: 'PHONE_VERIFICATION_REQUIRED',
          }),
        );
        assert.equal(format(error), expected);
      }
    },
  );
  test(
    family + ' media runtime no longer eagerly requires its page controller',
    () => {
      const runtime = runtimeRequires(family + '-discussion/image-runtime.ts');
      assert.ok(runtime.includes('./errors'));
      assert.ok(!runtime.includes('./controller'));
      assert.deepEqual(
        runtimeRequires(family + '-discussion/errors.ts').sort(),
        ['../api/errors', '../community/controller'],
      );
      assert.ok(
        runtimeRequires(family + '-discussion/controller.ts').includes(
          './errors',
        ),
      );
      const parsed = ts.createSourceFile(
        'errors.ts',
        source(family + '-discussion/errors.ts'),
        ts.ScriptTarget.ES2020,
        true,
      );
      assert.equal(parsed.statements.length, 3);
      assert.ok(
        parsed.statements.every(
          (node) =>
            ts.isImportDeclaration(node) || ts.isFunctionDeclaration(node),
        ),
      );
      assert.equal(
        parsed.statements.filter(ts.isFunctionDeclaration).length,
        1,
      );
    },
  );
}
