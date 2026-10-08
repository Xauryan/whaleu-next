import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { subscriptionFixture } from '../support/subscription-component-fixture.js';
const exec = promisify(execFile);
test(
  'manual subscription CLI: exact full-database dry run, bounded selections and local-only apply',
  { timeout: 120000 },
  async () => {
    const f = await subscriptionFixture();
    try {
      const author = await f.actor(),
        saver = await f.actor(),
        post = await f.publish(author);
      await f.save(saver, post.id);
      const id = (await f.obligations(post.id))[0]!.id;
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: process.env['TEST_DATABASE_URL']!,
        PG_SSL_MODE: 'disable',
        LOG_LEVEL: 'silent',
        COMMUNITY_UPDATES_PROCESSING: 'automatic',
        SAFETY_JURY_PROCESSING: 'automatic',
        EXPERIENCE_PROCESSING: 'automatic',
        SUBSCRIPTION_COMPONENT_PROCESSING: 'manual_only',
      };
      const cli = (args: string[], patch: Record<string, string> = {}) =>
        exec(
          process.execPath,
          [
            '--import',
            'tsx',
            'src/community/subscription-component/process-subscriptions.ts',
            ...args,
          ],
          {
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            env: { ...env, ...patch },
            timeout: 20000,
          },
        );
      const before = await f.snapshot();
      const dry = await cli([`--obligation-id=${id}`]);
      const summary = JSON.parse(dry.stdout.trim());
      assert.equal(summary.mode, 'dry-run');
      assert.equal(summary.advisory, true);
      assert.equal(summary.pending, 1);
      assert.deepEqual(
        await f.snapshot(),
        before,
        'All application tables AND sequence last_value/is_called remain identical, including inherited automatic processors',
      );
      const empty = JSON.parse((await cli([])).stdout.trim());
      assert.equal(empty.requested, 0);
      await assert.rejects(cli(['apply']));
      await assert.rejects(cli(['--all']));
      await assert.rejects(
        cli(['apply', `--obligation-id=${id}`, `--obligation-id=${id}`]),
      );
      await assert.rejects(
        cli([
          'apply',
          ...Array.from(
            { length: 51 },
            () => `--obligation-id=${randomUUID()}`,
          ),
        ]),
      );
      for (const patch of [
        { NODE_ENV: 'production' },
        { DATABASE_URL: 'postgres://127.0.0.1/production' },
        { DATABASE_URL: 'postgres://example.invalid/whaleu_test' },
      ])
        await assert.rejects(cli(['apply', `--obligation-id=${id}`], patch));
      assert.deepEqual(
        await f.snapshot(),
        before,
        'Rejected CLI inputs cannot mutate or start other processors',
      );
      const fifty = JSON.parse(
        (
          await cli(
            Array.from({ length: 50 }, () => `--obligation-id=${randomUUID()}`),
          )
        ).stdout.trim(),
      );
      assert.equal(fifty.requested, 50);
      assert.equal(fifty.missing, 50);
      assert.deepEqual(await f.snapshot(), before);
      const applied = JSON.parse(
        (await cli(['apply', `--obligation-id=${id}`])).stdout.trim(),
      );
      assert.equal(applied.applied, 1);
      const after = await f.snapshot();
      for (const [key, value] of Object.entries(before))
        if (
          !key.startsWith('whaleu_post_hotness.') &&
          key !== 'whaleu_community.saved_obligations'
        )
          assert.deepEqual(after[key], value, `${key} remains unchanged`);
      const rows = (
        await f.pool.query(
          'SELECT action,status FROM whaleu_community.saved_obligations',
        )
      ).rows;
      assert.ok(
        rows.every(
          (r) =>
            r.status ===
            (r.action === 'save_ranking' ? 'completed' : 'pending'),
        ),
      );
      const retry = JSON.parse(
        (await cli(['apply', `--obligation-id=${id}`])).stdout.trim(),
      );
      assert.equal(retry.alreadyCompleted, 1);
      assert.deepEqual(await f.snapshot(), after);
      assert.ok(!dry.stdout.includes(author.accountId));
      assert.ok(!dry.stdout.includes(post.id));
      assert.ok(!dry.stdout.includes(env.DATABASE_URL));
    } finally {
      await f.close();
    }
  },
);
