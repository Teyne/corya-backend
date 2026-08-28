import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseArtifact, verifyReleaseArtifact } from '../../scripts/release-artifact-lib.mjs';

const roots: string[] = [];
const sha = '0123456789abcdef0123456789abcdef01234567';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'corya-artifact-test-'));
  roots.push(root);
  const sourceRoot = join(root, 'source');
  const outputRoot = join(root, 'output');
  await mkdir(join(sourceRoot, 'dist', 'templates'), { recursive: true });
  await writeFile(join(sourceRoot, 'dist', 'server.js'), 'export {};\n');
  await writeFile(join(sourceRoot, 'dist', 'worker.js'), 'export {};\n');
  await writeFile(join(sourceRoot, 'dist', 'templates', 'email.html'), '<p>Corya</p>\n');
  await writeFile(join(sourceRoot, 'package.json'), '{"name":"synthetic"}\n');
  await writeFile(join(sourceRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(join(sourceRoot, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  return { sourceRoot, outputRoot };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release artifact provenance', () => {
  it('creates and verifies an exact allowlisted payload', async () => {
    const paths = await fixture();
    const artifactRoot = await createReleaseArtifact({
      ...paths,
      gitSha: sha,
      nodeVersion: 'v24.18.0',
      npmVersion: '11.15.0',
    });
    const manifest = await verifyReleaseArtifact({ artifactRoot, expectedGitSha: sha });
    expect(manifest.runtime).toEqual({ node: 'v24.18.0', npm: '11.15.0' });
    expect(Object.keys(manifest.files)).toContain('dist/server.js');
    expect(await readFile(join(artifactRoot, 'SHA256SUMS'), 'utf8')).toContain('package-lock.json');
  });

  it('rejects a modified payload file', async () => {
    const paths = await fixture();
    const artifactRoot = await createReleaseArtifact({
      ...paths,
      gitSha: sha,
      nodeVersion: 'v24.18.0',
      npmVersion: '11.15.0',
    });
    await writeFile(join(artifactRoot, 'dist', 'server.js'), 'tampered\n');
    await expect(verifyReleaseArtifact({ artifactRoot, expectedGitSha: sha })).rejects.toThrow(
      'artifact_digest_mismatch:dist/server.js',
    );
  });

  it('rejects an unexpected payload file', async () => {
    const paths = await fixture();
    const artifactRoot = await createReleaseArtifact({
      ...paths,
      gitSha: sha,
      nodeVersion: 'v24.18.0',
      npmVersion: '11.15.0',
    });
    await writeFile(join(artifactRoot, 'unexpected.txt'), 'unexpected\n');
    await expect(verifyReleaseArtifact({ artifactRoot, expectedGitSha: sha })).rejects.toThrow(
      'artifact_file_set_mismatch',
    );
  });
});
