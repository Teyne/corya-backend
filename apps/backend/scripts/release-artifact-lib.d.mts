export interface ReleaseManifest {
  schemaVersion: 1;
  artifactType: 'corya-backend-jelastic-transition';
  gitSha: string;
  runtime: { node: string; npm: string };
  dependencyModel: 'npm-ci-omit-dev-on-target';
  files: Record<string, { bytes: number; sha256: string }>;
}

export function createReleaseArtifact(options: {
  sourceRoot: string;
  outputRoot: string;
  gitSha: string;
  nodeVersion: string;
  npmVersion: string;
}): Promise<string>;

export function verifyReleaseArtifact(options: {
  artifactRoot: string;
  expectedGitSha?: string;
}): Promise<ReleaseManifest>;

export function artifactName(path: string): string;
