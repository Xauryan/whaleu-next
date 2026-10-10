import { readFile, realpath, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MediaProcessingError,
  PROCESS_MEMORY_BYTES,
  PROCESS_TEMP_BYTES,
} from './protocol.js';

/** The deployment launcher MUST create an isolated cgroup and private capped
 * tmpfs before exec, hide writable host paths, and clean up the group/mount on
 * every exit. This check never creates grants, mounts or changes OS settings.
 * Node heap limits and polling RSS are deliberately not treated as isolation.
 * No launcher ships with S1: an ordinary process fails closed here. */
export async function assertLinuxProcessingBoundary(): Promise<void> {
  const unavailable = () =>
    new MediaProcessingError('MEDIA_PROCESSOR_UNAVAILABLE');
  if (process.platform !== 'linux' || process.env['TMPDIR'] !== '/media-work')
    throw unavailable();
  try {
    const membership = (await readFile('/proc/self/cgroup', 'utf8')).trim();
    const match = /^0::(\/[^\n]*)$/.exec(membership);
    if (!match || match[1]!.split('/').includes('..')) throw unavailable();
    const group = join('/sys/fs/cgroup', match[1]!);
    const limit = (await readFile(join(group, 'memory.max'), 'utf8')).trim();
    const swap = (
      await readFile(join(group, 'memory.swap.max'), 'utf8')
    ).trim();
    const oom = (
      await readFile(join(group, 'memory.oom.group'), 'utf8')
    ).trim();
    const processes = (await readFile(join(group, 'cgroup.procs'), 'utf8'))
      .trim()
      .split(/\s+/);
    if (
      !/^\d+$/.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > PROCESS_MEMORY_BYTES ||
      swap !== '0' ||
      oom !== '1' ||
      processes.length !== 1 ||
      processes[0] !== String(process.pid)
    )
      throw unavailable();
    if ((await realpath('/media-work')) !== '/media-work') throw unavailable();
    const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
    if (
      !mountInfo
        .split('\n')
        .some(
          (line) =>
            line.split(' ')[4] === '/media-work' && line.includes(' - tmpfs '),
        )
    )
      throw unavailable();
    const fs = await statfs('/media-work', { bigint: true });
    if (
      fs.type !== 0x01021994n ||
      fs.blocks * fs.bsize > BigInt(PROCESS_TEMP_BYTES) ||
      fs.blocks * fs.bsize < 1n
    )
      throw unavailable();
  } catch {
    throw unavailable();
  }
}
