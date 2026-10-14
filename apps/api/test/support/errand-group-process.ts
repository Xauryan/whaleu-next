import type { PreparationTrace } from './errand-group-preparation.js';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  GroupDestination,
  PublicGroupPayload,
} from '../../src/notifications/errand-group/contracts.js';
export interface RestartedGroupResult {
  pid: number;
  claimed: boolean;
  trace: PreparationTrace;
  attempts: {
    destination: GroupDestination;
    key: string;
    payload: PublicGroupPayload;
  }[];
}
export function runRestartedGroupProcess(
  directory: string,
  destinations: readonly GroupDestination[],
  now: number,
  discover = false,
  expirePreparation = false,
): Promise<RestartedGroupResult> {
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(
        new URL('./errand-group-process-worker.ts', import.meta.url),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
        env: { ...process.env, NODE_ENV: 'test' },
      },
    );
    let logs = '',
      result: RestartedGroupResult | undefined,
      failed: Error | undefined;
    child.stdout?.on('data', (v) => (logs += String(v)));
    child.stderr?.on('data', (v) => (logs += String(v)));
    const timer = setTimeout(() => {
      failed = Error('Restarted synthetic worker timed out');
      child.kill();
    }, 30000);
    child.on('message', (raw: unknown) => {
      const m = raw as RestartedGroupResult & {
        event: string;
        message?: string;
      };
      if (m.event === 'done') result = m;
      else failed = Error(m.message ?? 'Unknown worker result');
    });
    child.on('error', (error) => {
      failed = error;
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (failed) reject(failed);
      else if (!result || code !== 0)
        reject(Error(`Restarted worker ${code}: ${logs}`));
      else resolve(result);
    });
    child.send({ directory, destinations, now, discover, expirePreparation });
  });
}
