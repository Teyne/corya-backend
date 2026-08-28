import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const REQUIRED_ROOT_FILES = ['package.json', 'package-lock.json', 'ecosystem.config.cjs'];
const METADATA_FILES = new Set(['artifact-manifest.json', 'SHA256SUMS']);
const FORBIDDEN_NAME = /(^|\/)(\.env(?:\.|$)|node_modules(?:\/|$)|.*\.(?:log|dump|sql\.gz|map)$)/iu;

function portable(path) {
  return path.split(sep).join('/');
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`artifact_symlink_forbidden:${entry.name}`);
    if (entry.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else if (entry.isFile()) files.push(portable(relative(root, absolute)));
    else throw new Error(`artifact_unsupported_entry:${entry.name}`);
  }
  return files;
}

function validateGitSha(gitSha) {
  if (!/^[0-9a-f]{40}$/u.test(gitSha)) throw new Error('artifact_git_sha_invalid');
}

async function copyPayloadFile(sourceRoot, artifactRoot, file) {
  if (FORBIDDEN_NAME.test(file)) throw new Error(`artifact_forbidden_path:${file}`);
  const source = join(sourceRoot, file);
  const stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`artifact_source_invalid:${file}`);
  const destination = join(artifactRoot, file);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: false, errorOnExist: true });
}

export async function createReleaseArtifact({
  sourceRoot,
  outputRoot,
  gitSha,
  nodeVersion,
  npmVersion,
}) {
  const source = resolve(sourceRoot);
  const output = resolve(outputRoot);
  validateGitSha(gitSha);
  if (output === source || output.startsWith(`${source}${sep}dist${sep}`))
    throw new Error('artifact_output_path_unsafe');

  const distRoot = join(source, 'dist');
  const distFiles = (await listFiles(distRoot)).map((file) => `dist/${file}`);
  if (distFiles.length === 0) throw new Error('artifact_dist_empty');

  const payloadFiles = [...REQUIRED_ROOT_FILES, ...distFiles].sort();
  const artifactRoot = join(output, `corya-backend-${gitSha.slice(0, 12)}`);
  await rm(output, { recursive: true, force: true });
  await mkdir(artifactRoot, { recursive: true });

  for (const file of payloadFiles) await copyPayloadFile(source, artifactRoot, file);

  const files = {};
  for (const file of payloadFiles) {
    const path = join(artifactRoot, file);
    const stat = await lstat(path);
    files[file] = { bytes: stat.size, sha256: await sha256(path) };
  }

  const manifest = {
    schemaVersion: 1,
    artifactType: 'corya-backend-jelastic-transition',
    gitSha,
    runtime: { node: nodeVersion, npm: npmVersion },
    dependencyModel: 'npm-ci-omit-dev-on-target',
    files,
  };
  await writeFile(
    join(artifactRoot, 'artifact-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  const sums = payloadFiles.map((file) => `${files[file].sha256}  ${file}`).join('\n');
  await writeFile(join(artifactRoot, 'SHA256SUMS'), `${sums}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return artifactRoot;
}

export async function verifyReleaseArtifact({ artifactRoot, expectedGitSha }) {
  const root = resolve(artifactRoot);
  const manifest = JSON.parse(await readFile(join(root, 'artifact-manifest.json'), 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifactType !== 'corya-backend-jelastic-transition' ||
    manifest.dependencyModel !== 'npm-ci-omit-dev-on-target'
  )
    throw new Error('artifact_manifest_contract_invalid');
  validateGitSha(manifest.gitSha);
  if (expectedGitSha !== undefined && manifest.gitSha !== expectedGitSha)
    throw new Error('artifact_git_sha_mismatch');

  const expectedFiles = Object.keys(manifest.files).sort();
  const actualFiles = (await listFiles(root))
    .filter((file) => !METADATA_FILES.has(file))
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
    throw new Error('artifact_file_set_mismatch');

  for (const file of expectedFiles) {
    if (FORBIDDEN_NAME.test(file)) throw new Error(`artifact_forbidden_path:${file}`);
    const path = join(root, file);
    const stat = await lstat(path);
    const expected = manifest.files[file];
    if (stat.size !== expected.bytes || (await sha256(path)) !== expected.sha256)
      throw new Error(`artifact_digest_mismatch:${file}`);
  }

  const expectedSums = expectedFiles
    .map((file) => `${manifest.files[file].sha256}  ${file}`)
    .join('\n');
  const actualSums = (await readFile(join(root, 'SHA256SUMS'), 'utf8')).trimEnd();
  if (actualSums !== expectedSums) throw new Error('artifact_sums_mismatch');
  return manifest;
}

export function artifactName(path) {
  return basename(resolve(path));
}
