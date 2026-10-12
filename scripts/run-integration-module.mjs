import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  discoverFiles,
  integrationGlob,
  parseArguments,
  runTests,
} from './run-integration-shard.mjs';

export function readModules() {
  return JSON.parse(
    readFileSync(new URL('./ci-integration-modules.json', import.meta.url)),
  );
}

export function createModulePlan(inputFiles, manifest) {
  const files = [...inputFiles].sort();
  if (!files.length || new Set(files).size !== files.length) {
    throw new Error('Integration inventory must be nonempty and unique');
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.groups)) {
    throw new Error('Unsupported integration module manifest');
  }
  const groups = new Set();
  const shards = [];
  for (const group of manifest.groups) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(group.id) ||
      groups.has(group.id) ||
      typeof group.label !== 'string' ||
      !group.label.trim() ||
      !Array.isArray(group.owners) ||
      !group.owners.length ||
      group.owners.some(
        (owner) => typeof owner !== 'string' || !owner.trim(),
      ) ||
      !Array.isArray(group.shards) ||
      !group.shards.length
    ) {
      throw new Error('Invalid or duplicate integration module');
    }
    groups.add(group.id);
    group.shards.forEach((names, offset) => {
      if (
        !Array.isArray(names) ||
        !names.length ||
        names.some((name) => !/^[a-z0-9][a-z0-9-]*\.test\.ts$/.test(name))
      ) {
        throw new Error(`Invalid or empty module shard: ${group.id}`);
      }
      shards.push({
        id: `${group.id}-${offset + 1}`,
        module: group.id,
        label: group.label,
        owners: group.owners,
        shard: `${offset + 1}/${group.shards.length}`,
        files: names.map((name) => `test/integration/${name}`).sort(),
      });
    });
  }
  const assigned = shards.flatMap((shard) => shard.files).sort();
  const missing = files.filter((file) => !assigned.includes(file));
  const unexpected = assigned.filter((file) => !files.includes(file));
  if (
    new Set(assigned).size !== assigned.length ||
    missing.length ||
    unexpected.length ||
    assigned.length !== files.length
  ) {
    throw new Error(
      `Modules must cover the integration glob exactly once; missing=${JSON.stringify(missing)}; unexpected=${JSON.stringify(unexpected)}; duplicate=${assigned.length !== new Set(assigned).size}`,
    );
  }
  return {
    glob: integrationGlob,
    totalFiles: files.length,
    filesSha256: createHash('sha256').update(files.join('\n')).digest('hex'),
    totalShards: shards.length,
    shards,
  };
}

export function main(
  args,
  {
    files = discoverFiles(),
    manifest = readModules(),
    write = console.log,
    run = runTests,
  } = {},
) {
  const plan = createModulePlan(files, manifest);
  if (args.length === 1 && args[0] === '--matrix') {
    write(
      JSON.stringify({
        include: plan.shards.map(({ id, module, label, shard }) => ({
          id,
          module,
          label,
          shard,
        })),
      }),
    );
    return 0;
  }
  if (args.length === 1 && args[0] === '--verify') {
    write(JSON.stringify(plan));
    return 0;
  }
  if (args[0] !== '--module' || !args[1]) {
    throw new Error(
      'Usage: --verify | --matrix | --module MODULE --shard INDEX/TOTAL [--list]',
    );
  }
  const options = parseArguments(args.slice(2));
  if (options.index === undefined)
    throw new Error('Expected --shard INDEX/TOTAL');
  const shard = plan.shards.find(
    (entry) =>
      entry.module === args[1] &&
      entry.shard === `${options.index}/${options.total}`,
  );
  if (!shard) throw new Error('Unknown module or shard');
  write(
    JSON.stringify({
      ...plan,
      selectedFiles: shard.files.length,
      shards: [shard],
    }),
  );
  return options.list ? 0 : run(shard.files);
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
