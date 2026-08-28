import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseArtifact } from './release-artifact-lib.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(sourceRoot, process.env.CORYA_ARTIFACT_OUTPUT ?? 'release-artifact');

try {
  const directories = (await readdir(outputRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  if (directories.length !== 1) throw new Error('artifact_directory_count_invalid');
  const manifest = await verifyReleaseArtifact({
    artifactRoot: resolve(outputRoot, directories[0].name),
    expectedGitSha: process.env.GITHUB_SHA,
  });
  process.stdout.write(`[artifact-verify] ok ${manifest.gitSha}\n`);
} catch (error) {
  process.stderr.write(`[artifact-verify] ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
}
