import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import request from 'supertest';
import { commentFixture } from '../support/comment-component-fixture.js';
import { syntheticEpoch } from '../support/view-component-fixture.js';

const exec = promisify(execFile);
test(
  'manual comment CLI: exact full-database dry run, bounded selections and local-only apply',
  { timeout: 120000 },
  async () => {
    const f = await commentFixture();
    try {
      const author = await f.actor(),
        saver = await f.actor(),
        post = await f.publish(author);
      await f.save(saver, post.id);
      await request(f.app.getHttpServer())
        .put(`/v1/community/posts/${post.id}/like`)
        .set('Authorization', `Bearer ${saver.accessToken}`)
        .send({ requestId: randomUUID(), liked: true })
        .expect(200);
      const root = await f.root(saver, post.id);
      const id = (await f.sources(post.id))[0]!.id;
      // Retention has actual expired work available, so a mistakenly mounted
      // automatic cleanup would cause the exact snapshot comparison to fail.
      await syntheticEpoch(f.pool, saver.accountId, { expiresInMs: -1000 });
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        PG_SSL_MODE: 'disable',
        LOG_LEVEL: 'silent',
        COMMUNITY_UPDATES_PROCESSING: 'automatic',
        SAFETY_JURY_PROCESSING: 'automatic',
        EXPERIENCE_PROCESSING: 'automatic',
        VIEW_REPORTING_RETENTION_PROCESSING: 'automatic',
        // These components have no automatic mode in the production schema.
        SUBSCRIPTION_COMPONENT_PROCESSING: 'manual_only',
        LIKE_COMPONENT_PROCESSING: 'manual_only',
        COMMENT_COMPONENT_PROCESSING: 'manual_only',
      };
      const cli = (args: string[], patch: Record<string, string> = {}) =>
        exec(
          process.execPath,
          [
            '--import',
            'tsx',
            'src/community/comment-component/process-comments.ts',
            ...args,
          ],
          {
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            env: { ...env, ...patch },
            timeout: 20000,
          },
        );
      const privateValues = [
        author.accountId,
        saver.accountId,
        author.accessToken,
        saver.accessToken,
        post.id,
        root.id,
        root.body.clientRequestId,
        root.body.text,
        id,
        env.DATABASE_URL,
      ];
      const assertPrivate = (output: { stdout?: string; stderr?: string }) => {
        const text = `${output.stdout ?? ''}${output.stderr ?? ''}`;
        for (const value of privateValues)
          assert.ok(
            !text.includes(value),
            'CLI output must contain only aggregate results',
          );
      };
      const summary = (output: { stdout: string; stderr: string }) => {
        assertPrivate(output);
        assert.equal(output.stderr, '');
        const result = JSON.parse(output.stdout.trim());
        assert.deepEqual(
          Object.keys(result).sort(),
          [
            'command',
            'mode',
            'advisory',
            'requested',
            'applied',
            'alreadyCompleted',
            'blockedBaseline',
            'blockedPredecessor',
            'sourceUnavailable',
            'missing',
            'pending',
            'failed',
          ].sort(),
        );
        assert.equal(result.command, 'local-comment-component');
        assert.equal(result.failed, 0);
        return result;
      };
      const refuses = async (
        args: string[],
        patch: Record<string, string> = {},
      ) =>
        assert.rejects(cli(args, patch), (error: unknown) => {
          assert.ok(error instanceof Error);
          assertPrivate(error as Error & { stdout?: string; stderr?: string });
          return true;
        });
      const before = await f.snapshot();
      const dry = summary(await cli([`--source-id=${id}`]));
      assert.equal(dry.mode, 'dry-run');
      assert.equal(dry.advisory, true);
      assert.equal(dry.requested, 1);
      assert.equal(dry.pending, 1);
      assert.deepEqual(
        await f.snapshot(),
        before,
        'All application tables AND sequence last_value/is_called remain identical, including inherited automatic processors and expired view retention work',
      );
      assert.equal(summary(await cli([])).requested, 0);
      for (const args of [
        ['apply'],
        ['--all'],
        ['--limit=1'],
        [`--post-id=${post.id}`],
        ['--source-id=not-a-uuid'],
        ['apply', `--source-id=${id}`, `--source-id=${id.toUpperCase()}`],
        [
          'apply',
          ...Array.from({ length: 51 }, () => `--source-id=${randomUUID()}`),
        ],
      ])
        await refuses(args);
      for (const patch of [
        { NODE_ENV: 'production' },
        { DATABASE_URL: 'postgres://127.0.0.1/production' },
        { DATABASE_URL: 'postgres://example.invalid/whaleu_test' },
        { COMMENT_COMPONENT_PROCESSING: 'disabled' },
      ])
        await refuses(['apply', `--source-id=${id}`], patch);
      assert.deepEqual(
        await f.snapshot(),
        before,
        'Rejected CLI inputs cannot mutate or start other processors',
      );
      const selected = Array.from(
        { length: 50 },
        () => `--source-id=${randomUUID()}`,
      );
      for (const mode of ['dry-run', 'apply']) {
        const fifty = summary(await cli([mode, ...selected]));
        assert.equal(fifty.requested, 50);
        assert.equal(fifty.missing, 50);
        assert.deepEqual(await f.snapshot(), before);
      }
      const applied = summary(await cli(['apply', `--source-id=${id}`]));
      assert.equal(applied.mode, 'apply');
      assert.equal(applied.advisory, false);
      assert.equal(applied.applied, 1);
      assert.deepEqual(await f.counts(post.id), ['1', '0', '1', '1']);
      const after = await f.snapshot();
      for (const [key, value] of Object.entries(before))
        if (!key.startsWith('whaleu_post_hotness.comment_'))
          assert.deepEqual(after[key], value, `${key} remains unchanged`);
      const retry = summary(await cli(['apply', `--source-id=${id}`]));
      assert.equal(retry.alreadyCompleted, 1);
      assert.equal(retry.applied, 0);
      assert.deepEqual(await f.snapshot(), after);
    } finally {
      await f.close();
    }
  },
);
