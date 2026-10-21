import { spawn } from 'node:child_process';

// Test-only real PTY transport. No content is interpolated into shell syntax.
// GNU timeout owns the CLI's terminal process group and bounds its descendants;
// the parent separately owns and bounds the script wrapper's process group.
const command =
  'exec /usr/bin/timeout --signal=TERM --kill-after=1s "$WHALEU_PTY_SECONDS" "$WHALEU_PTY_NODE" --import tsx "$WHALEU_PTY_ENTRY" "$WHALEU_PTY_JSON"';

export async function runTextReviewCliPty(
  entry: string,
  input: unknown,
  env: NodeJS.ProcessEnv,
  timeoutMs = 15000,
): Promise<unknown> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000)
    throw new Error('Invalid test PTY deadline');
  const encoded = JSON.stringify(input);
  if (encoded === undefined) throw new Error('Invalid test PTY command');
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/script',
      [
        '--quiet',
        '--return',
        '--echo',
        'never',
        '--command',
        command,
        '/dev/null',
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...env,
          SHELL: '/bin/sh',
          WHALEU_PTY_SECONDS: `${timeoutMs / 1000}s`,
          WHALEU_PTY_NODE: process.execPath,
          WHALEU_PTY_ENTRY: entry,
          WHALEU_PTY_JSON: encoded,
        },
      },
    );
    let output = '',
      bytes = 0,
      failed = false,
      running = true;
    child.once('exit', () => {
      running = false;
    });
    child.stdout.setEncoding('utf8');
    const stop = () => {
      failed = true;
      if (running && child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* Already exited. */
        }
      }
    };
    const deadline = setTimeout(stop, timeoutMs + 1500);
    const hardDeadline = setTimeout(() => {
      if (running && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
      reject(new Error('Test PTY command exceeded its deadline'));
    }, timeoutMs + 3000);
    const clear = () => {
      clearTimeout(deadline);
      clearTimeout(hardDeadline);
    };
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) stop();
      else output += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop();
    });
    child.on('error', () => {
      clear();
      reject(new Error('Required real PTY tooling is unavailable'));
    });
    child.on('close', (code, signal) => {
      clear();
      if (failed || signal || code !== 0) {
        reject(new Error('Real PTY command failed; output withheld'));
        return;
      }
      try {
        resolve(JSON.parse(output.trim()));
      } catch {
        reject(
          new Error('Real PTY command returned invalid JSON; output withheld'),
        );
      }
    });
  });
}
