import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReleaseArtifact } from './release-artifact-lib.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(sourceRoot, process.env.CORYA_ARTIFACT_OUTPUT ?? 'release-artifact');
const gitSha = (process.env.GITHUB_SHA ??
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' })).trim();
const npmUserAgentMatch = /^npm\/([^ ]+)/u.exec(process.env.npm_config_user_agent ?? '');
const npmVersion =
  npmUserAgentMatch?.[1] ??
  execFileSync(
    process.execPath,
    [process.env.npm_execpath ?? 'node_modules/npm/bin/npm-cli.js', '--version'],
    { encoding: 'utf8' },
  ).trim();

try {
  const artifactRoot = await createReleaseArtifact({
    sourceRoot,
    outputRoot,
    gitSha,
    nodeVersion: process.version,
    npmVersion,
  });
  process.stdout.write(`${artifactRoot}\n`);
} catch (error) {
  process.stderr.write(`[artifact-create] ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
}
