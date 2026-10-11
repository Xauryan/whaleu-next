import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { globSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const apiDirectory = fileURLToPath(
  new URL('../apps/api/', import.meta.url),
);
export const integrationGlob = 'test/integration/*.test.ts';

export function discoverFiles(directory = apiDirectory) {
  const files = globSync(integrationGlob, { cwd: directory }).sort();
  for (const file of files) {
    if (!statSync(resolve(directory, file)).isFile()) {
      throw new Error(`Integration glob matched a non-file: ${file}`);
    }
  }
  return files;
}

function positiveInteger(value) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Expected a positive safe integer, got ${value}`);
  }
  return Number(value);
}

export function parseArguments(args) {
  if (args.length === 2 && args[0] === '--verify') {
    return { total: positiveInteger(args[1]), list: true };
  }
  if (
    (args.length !== 2 && args.length !== 3) ||
    args[0] !== '--shard' ||
    (args.length === 3 && args[2] !== '--list')
  ) {
    throw new Error('Usage: --verify TOTAL | --shard INDEX/TOTAL [--list]');
  }
  const parts = args[1].split('/');
  if (parts.length !== 2) throw new Error('Expected shard INDEX/TOTAL');
  const index = positiveInteger(parts[0]);
  const total = positiveInteger(parts[1]);
  if (index > total) throw new Error('Shard index exceeds total');
  return { index, total, list: args[2] === '--list' };
}

export function createShardPlan(inputFiles, total) {
  if (!Number.isSafeInteger(total) || total < 1 || total > inputFiles.length) {
    throw new Error(
      'Shard count must be positive and no greater than file count',
    );
  }
  const files = [...inputFiles].sort();
  if (new Set(files).size !== files.length) {
    throw new Error('Duplicate integration input files');
  }
  for (const file of files) {
    if (!/^test\/integration\/[^/]+\.test\.ts$/.test(file)) {
      throw new Error(`Unexpected integration file: ${file}`);
    }
  }
  const shards = Array.from({ length: total }, (_, offset) => ({
    index: offset + 1,
    files: [],
  }));
  for (const file of files) {
    // Hash the filename, not its contents: new files do not move existing files.
    const filename = file.slice('test/integration/'.length);
    const hash = createHash('sha256').update(filename).digest().readUInt32BE(0);
    shards[hash % total].files.push(file);
  }
  if (shards.some((shard) => shard.files.length === 0)) {
    throw new Error('Empty integration shard; choose a smaller shard count');
  }
  const assigned = shards.flatMap((shard) => shard.files).sort();
  if (
    assigned.length !== files.length ||
    new Set(assigned).size !== files.length ||
    assigned.some((file, index) => file !== files[index])
  ) {
    throw new Error('Integration shards must cover the glob exactly once');
  }
  return {
    glob: integrationGlob,
    totalFiles: files.length,
    filesSha256: createHash('sha256').update(files.join('\n')).digest('hex'),
    totalShards: total,
    shards,
  };
}

export function runTests(files, spawn = spawnSync) {
  if (files.length === 0) throw new Error('Refusing to run an empty shard');
  const result = spawn(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', ...files],
    { cwd: apiDirectory, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.signal) return 128 + constants.signals[result.signal];
  if (!Number.isInteger(result.status))
    throw new Error('Missing test exit status');
  return result.status;
}

export function main(
  args,
  { files = discoverFiles(), write = console.log, run = runTests } = {},
) {
  const options = parseArguments(args);
  const plan = createShardPlan(files, options.total);
  const selected =
    options.index === undefined
      ? plan.shards
      : [plan.shards[options.index - 1]];
  // Every job logs its exact file manifest and the same complete-corpus digest.
  write(
    JSON.stringify({
      ...plan,
      selectedFiles: selected.reduce(
        (count, shard) => count + shard.files.length,
        0,
      ),
      shards: selected,
    }),
  );
  if (options.list) return 0;
  return run(selected[0].files);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
