import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function artifactContext(
  root = repository,
  env = process.env,
  git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(),
) {
  const sha = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  // Output must come from the checked-out source, with no tracked edits.
  git(['diff', '--exit-code', 'HEAD', '--', '.']);
  if (
    sha !== env.GITHUB_SHA ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9]\d*$/.test(
      env.WHALEU_ARTIFACT_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT ?? '',
    )
  ) {
    throw new Error(
      'Native artifact requires exact checkout and workflow provenance',
    );
  }
  return {
    version: 1,
    sha,
    tree,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.WHALEU_ARTIFACT_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    npm: '11.9.0',
    lockSha256: digest(readFileSync(join(root, 'package-lock.json'))),
  };
}

export function inventory(directory) {
  const files = [];
  let bytes = 0;
  function visit(relative) {
    const absolute = join(directory, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink())
      throw new Error('Native artifact cannot contain symlinks');
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name))
          throw new Error('Unexpected native artifact path');
        visit(relative ? `${relative}/${name}` : name);
      }
    } else if (
      stat.isFile() &&
      (/\.(js|json|wxml|wxss|png)$/.test(relative) ||
        relative === 'vendor/js-sha256-LICENSE.txt')
    ) {
      bytes += stat.size;
      if (bytes > 128 * 1024 * 1024 || files.length >= 10000)
        throw new Error('Native artifact exceeds size budget');
      files.push({
        path: relative,
        bytes: stat.size,
        sha256: digest(readFileSync(absolute)),
      });
    } else {
      throw new Error(`Unexpected native artifact file: ${relative}`);
    }
  }
  visit('');
  if (
    !files.some((file) => file.path === 'app.js') ||
    !files.some((file) => file.path === 'app.json')
  )
    throw new Error('Native app entrypoints are missing');
  return files;
}

export function createArtifact(source, destination, context) {
  if (existsSync(destination))
    throw new Error('Artifact staging path must be fresh');
  inventory(source);
  mkdirSync(destination, { recursive: true });
  cpSync(source, join(destination, 'dist'), {
    recursive: true,
    dereference: false,
  });
  const manifest = { ...context, files: inventory(join(destination, 'dist')) };
  writeFileSync(
    join(destination, 'manifest.json'),
    `${JSON.stringify(manifest)}\n`,
  );
  return manifest;
}

export function verifyArtifact(directory, expected) {
  if (
    lstatSync(directory).isSymbolicLink() ||
    JSON.stringify(readdirSync(directory).sort()) !==
      JSON.stringify(['dist', 'manifest.json']) ||
    !lstatSync(join(directory, 'manifest.json')).isFile() ||
    lstatSync(join(directory, 'manifest.json')).isSymbolicLink()
  ) {
    throw new Error('Unexpected native artifact envelope');
  }
  const manifest = JSON.parse(
    readFileSync(join(directory, 'manifest.json'), 'utf8'),
  );
  const { files, ...actual } = manifest;
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Native artifact provenance mismatch');
  if (
    JSON.stringify(files) !== JSON.stringify(inventory(join(directory, 'dist')))
  )
    throw new Error('Native artifact file inventory or digest mismatch');
  return manifest;
}

export function restoreArtifact(directory, destination, context) {
  const manifest = verifyArtifact(directory, context);
  if (existsSync(destination))
    throw new Error('Native destination must be fresh');
  cpSync(join(directory, 'dist'), destination, {
    recursive: true,
    dereference: false,
  });
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [command, directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length || !['create', 'restore'].includes(command))
      throw new Error('Usage: create|restore ARTIFACT_DIRECTORY');
    const context = artifactContext();
    const native = join(repository, 'apps/wechat/dist');
    const manifest =
      command === 'create'
        ? createArtifact(native, resolve(directory), context)
        : restoreArtifact(resolve(directory), native, context);
    console.log(
      JSON.stringify({
        nativeArtifact: { ...context, files: manifest.files.length },
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
