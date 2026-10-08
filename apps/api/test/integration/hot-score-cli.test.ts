import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { HotScoreService } from '../../src/community/hot-score/service.js';
import { hotScoreFixture } from '../support/hot-score-fixture.js';
import { syntheticEpoch } from '../support/view-component-fixture.js';

const exec = promisify(execFile);
test(
  'internal score CLI: disabled default, local selection, isolated jobs and exact table/sequence nonmutation',
  { timeout: 180000 },
  async () => {
    const f = await hotScoreFixture();
    try {
      const author = await f.actor(),
        actor = await f.actor(),
        zero = await f.publish(author),
        pending = await f.publish(author),
        unknown = await f.rawUnknown(author);
      await f.save(actor, pending.id);
      await f.like(actor, pending.id);
      const root = await f.root(actor, pending.id);
      await syntheticEpoch(f.pool, actor.accountId, { expiresInMs: -1000 });
      assert.throws(
        () => f.app.get(HotScoreService),
        'Public AppModule does not mount score computation',
      );
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
        SUBSCRIPTION_COMPONENT_PROCESSING: 'manual_only',
        LIKE_COMPONENT_PROCESSING: 'manual_only',
        COMMENT_COMPONENT_PROCESSING: 'manual_only',
        HOT_SCORE_COMPUTATION: 'manual_only',
      };
      const cli = (
        args: string[],
        patch: Record<string, string | undefined> = {},
      ) =>
        exec(
          process.execPath,
          [
            '--import',
            'tsx',
            'src/community/hot-score/compute-score.ts',
            ...args,
          ],
          {
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            env: { ...env, ...patch },
            timeout: 20000,
          },
        );
      const secretValues = [
        author.accountId,
        actor.accountId,
        author.accessToken,
        actor.accessToken,
        zero.id,
        pending.id,
        unknown,
        root.id,
        root.body.text,
        env.DATABASE_URL,
      ];
      const sanitized = (out: { stdout?: string; stderr?: string }) => {
        const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
        for (const value of secretValues)
          assert.ok(
            !text.includes(value),
            'CLI must expose aggregate categories, not private identifiers, content or database URL',
          );
      };
      const summary = (out: { stdout: string; stderr: string }) => {
        sanitized(out);
        assert.equal(out.stderr, '');
        const value = JSON.parse(out.stdout.trim());
        assert.deepEqual(
          Object.keys(value).sort(),
          [
            'command',
            'mode',
            'advisory',
            'requested',
            'computed',
            'missing',
            'blockedCoverage',
            'blockedFreshness',
            'unavailable',
            'numericFailure',
            'failed',
          ].sort(),
        );
        assert.equal(value.command, 'local-hot-score');
        assert.equal(value.failed, 0);
        return value;
      };
      const refuses = async (
        args: string[],
        patch: Record<string, string | undefined> = {},
      ) =>
        assert.rejects(cli(args, patch), (error: unknown) => {
          assert.ok(error instanceof Error);
          sanitized(error as Error & { stdout?: string; stderr?: string });
          return true;
        });
      const before = await f.snapshot();
      for (const mode of ['dry-run', 'compute']) {
        const result = summary(
          await cli([
            mode,
            ...[zero.id, pending.id, unknown, randomUUID()].map(
              (id) => `--post-id=${id}`,
            ),
          ]),
        );
        assert.equal(result.mode, mode);
        assert.equal(result.advisory, mode === 'dry-run');
        assert.equal(result.requested, 4);
        assert.equal(result.computed, 1);
        assert.equal(result.blockedCoverage, 1);
        assert.equal(result.blockedFreshness, 1);
        assert.equal(result.missing, 1);
        assert.deepEqual(
          await f.snapshot(),
          before,
          'All tables and sequence last_value/is_called remain unchanged, including pending processors and expired retention',
        );
      }
      const defaultMode = summary(
        await cli([`--post-id=${zero.id}`], {
          HOT_SCORE_COMPUTATION: undefined,
        }),
      );
      assert.equal(defaultMode.mode, 'dry-run');
      assert.equal(defaultMode.advisory, true);
      assert.equal(defaultMode.computed, 1);
      assert.equal(summary(await cli([])).requested, 0);
      for (const args of [
        ['compute'],
        ['apply'],
        ['--all'],
        ['--limit=1'],
        ['--post-id=bad'],
        [`--source-id=${zero.id}`],
        [
          'compute',
          `--post-id=${zero.id}`,
          `--post-id=${zero.id.toUpperCase()}`,
        ],
        [
          'compute',
          ...Array.from({ length: 51 }, () => `--post-id=${randomUUID()}`),
        ],
      ])
        await refuses(args);
      for (const patch of [
        { NODE_ENV: 'production' },
        { DATABASE_URL: 'postgres://example.invalid/whaleu_test' },
        { DATABASE_URL: 'postgres://127.0.0.1/production' },
        { HOT_SCORE_COMPUTATION: 'disabled' },
        { HOT_SCORE_COMPUTATION: undefined },
        { HOT_SCORE_COMPUTATION: 'automatic' },
      ])
        await refuses(['compute', `--post-id=${zero.id}`], patch);
      const fifty = Array.from(
        { length: 50 },
        () => `--post-id=${randomUUID()}`,
      );
      for (const mode of ['dry-run', 'compute']) {
        const result = summary(await cli([mode, ...fifty]));
        assert.equal(result.requested, 50);
        assert.equal(result.missing, 50);
      }
      assert.deepEqual(
        await f.snapshot(),
        before,
        'Refusals and legal selection boundaries also cannot mutate, allocate sequences, or start processors',
      );
    } finally {
      await f.close();
    }
  },
);
