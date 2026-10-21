import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTextReviewCliPty } from './support/text-review-cli-pty.js';

async function fixture(
  code: string,
  run: (entry: string, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'whaleu-pty-test-'));
  // Spaces, quotes and shell metacharacters in the executable path are intentional.
  const entry = join(directory, "cli ' $() ; fixture.mjs");
  await writeFile(entry, code);
  try {
    await run(entry, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('real PTY provides actual terminal and transports JSON without shell expansion', async () => {
  await fixture(
    `process.stdout.write(JSON.stringify({tty: process.stdout.isTTY, input: JSON.parse(process.argv[2])}));`,
    async (entry, directory) => {
      const marker = join(directory, 'must-not-exist');
      const input = {
        text: `鲸\n'"; $(touch ${marker}); \`touch ${marker}\` \\ $HOME`,
        command: 'show',
      };
      const value = await runTextReviewCliPty(entry, input, process.env);
      assert.deepEqual(value, { tty: true, input });
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    },
  );
});

test('PTY failures withhold private stdout and stderr rather than exposing command output', async () => {
  await fixture(
    `process.stdout.write('PRIVATE-SOURCE'); process.stderr.write('PRIVATE-SECRET'); process.exitCode=7;`,
    async (entry) => {
      await assert.rejects(
        runTextReviewCliPty(entry, {}, process.env),
        (error: unknown) => {
          assert.match(String(error), /output withheld/);
          assert.doesNotMatch(String(error), /PRIVATE/);
          return true;
        },
      );
    },
  );
});

test('PTY rejects non-JSON output without disclosing it', async () => {
  await fixture(`process.stdout.write('PRIVATE-SOURCE');`, async (entry) => {
    await assert.rejects(
      runTextReviewCliPty(entry, {}, process.env),
      /invalid JSON; output withheld/,
    );
  });
});

test('bounded real PTY timeout terminates its owned CLI and descendant group', async () => {
  await fixture(
    `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(process.env.PTY_TEST_PID,JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);`,
    async (entry, directory) => {
      const path = join(directory, 'owned-pids');
      const before = Date.now();
      await assert.rejects(
        runTextReviewCliPty(
          entry,
          {},
          { ...process.env, PTY_TEST_PID: path },
          1000,
        ),
        /PTY command/,
      );
      assert.ok(Date.now() - before < 6000);
      const pids = JSON.parse(await readFile(path, 'utf8')) as number[];
      for (const pid of pids) {
        try {
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
          assert.match(
            stat.slice(stat.lastIndexOf(')') + 2),
            /^Z /,
            'Owned child must be exited, not running',
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    },
  );
});
