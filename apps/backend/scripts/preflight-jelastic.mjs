import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const COMMON_REQUIRED_ENV = Object.freeze([
  'NODE_ENV',
  'APP_BASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'RETELL_API_KEY',
  'ALERT_EMAIL',
  'HEALTH_DEEP_TOKEN',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM_NAME',
  'SMTP_FROM_EMAIL',
]);

const ROLE_CONFIG = Object.freeze({
  api: Object.freeze({
    entrypoint: 'dist/server.js',
    requiredEnv: Object.freeze([
      ...COMMON_REQUIRED_ENV,
      'PORT',
      'CORS_ORIGIN',
      'TRUST_PROXY_HOPS',
      'CALCOM_WEBHOOK_SECRET',
    ]),
  }),
  worker: Object.freeze({
    entrypoint: 'dist/worker.js',
    requiredEnv: Object.freeze([
      ...COMMON_REQUIRED_ENV,
      'ADMIN_APP_URL',
      'JOB_BATCH_SIZE',
    ]),
  }),
});

function usage() {
  return 'Usage: npm run preflight:jelastic -- --role api|worker';
}

export function parseRole(argv) {
  if (argv.length !== 2 || argv[0] !== '--role') return null;
  return argv[1] === 'api' || argv[1] === 'worker' ? argv[1] : null;
}

function isPresent(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIntegerInRange(value, min, max) {
  if (!isPresent(value)) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

function isHttpsUrl(value) {
  if (!isPresent(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isEmail(value) {
  return isPresent(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function isProductionCorsAllowList(value) {
  if (!isPresent(value)) return false;
  const origins = value.split(',').map((origin) => origin.trim());
  return (
    origins.length > 0 &&
    origins.every((origin) => origin !== '*' && isHttpsUrl(origin))
  );
}

export function validateEnvironment(role, environment) {
  const missing = ROLE_CONFIG[role].requiredEnv.filter(
    (name) => !isPresent(environment[name]),
  );
  const invalid = [];

  const invalidateWhenPresent = (name, predicate) => {
    if (isPresent(environment[name]) && !predicate(environment[name])) {
      invalid.push(name);
    }
  };

  invalidateWhenPresent('NODE_ENV', (value) => value === 'production');
  invalidateWhenPresent('APP_BASE_URL', isHttpsUrl);
  invalidateWhenPresent('SUPABASE_URL', isHttpsUrl);
  invalidateWhenPresent('ALERT_EMAIL', isEmail);
  invalidateWhenPresent('SMTP_FROM_EMAIL', isEmail);
  invalidateWhenPresent('HEALTH_DEEP_TOKEN', (value) => value.length >= 16);
  invalidateWhenPresent(
    'SMTP_PORT',
    (value) => isIntegerInRange(value, 1, 65_535),
  );
  invalidateWhenPresent(
    'SMTP_SECURE',
    (value) => value === 'true' || value === 'false',
  );

  if (role === 'api') {
    invalidateWhenPresent(
      'PORT',
      (value) => isIntegerInRange(value, 1, 65_535),
    );
    invalidateWhenPresent(
      'TRUST_PROXY_HOPS',
      (value) => isIntegerInRange(value, 0, 10),
    );
    invalidateWhenPresent('CORS_ORIGIN', isProductionCorsAllowList);
    invalidateWhenPresent('CALCOM_WEBHOOK_SECRET', (value) => value.length >= 32);
  } else {
    invalidateWhenPresent('ADMIN_APP_URL', isHttpsUrl);
    invalidateWhenPresent('JOB_BATCH_SIZE', (value) => value === '1');
  }

  return {
    missing,
    invalid: [...new Set(invalid)].filter((name) => !missing.includes(name)),
  };
}

function validateDist(role, root, fileSystem) {
  const relativePath = ROLE_CONFIG[role].entrypoint;
  const absolutePath = resolve(root, relativePath);
  try {
    return (
      fileSystem.existsSync(absolutePath) &&
      fileSystem.statSync(absolutePath).isFile()
    );
  } catch {
    return false;
  }
}

export function runPreflight({
  argv = process.argv.slice(2),
  environment = process.env,
  nodeVersion = process.versions.node,
  root = backendRoot,
  fileSystem = { existsSync, statSync },
  output = console,
} = {}) {
  const role = parseRole(argv);
  if (role === null) {
    output.error(`[preflight] invalid arguments. ${usage()}`);
    return false;
  }

  const nodeMajor = Number(nodeVersion.split('.')[0]);
  if (nodeMajor !== 24) {
    output.error('[preflight] invalid runtime: Node.js major 24 is required');
    return false;
  }

  const { missing, invalid } = validateEnvironment(role, environment);
  if (missing.length > 0) {
    output.error(`[preflight] missing environment variables: ${missing.join(', ')}`);
  }
  if (invalid.length > 0) {
    output.error(`[preflight] invalid environment variables: ${invalid.join(', ')}`);
  }

  const distOk = validateDist(role, root, fileSystem);
  if (!distOk) {
    output.error(
      `[preflight] missing compiled entrypoint: ${ROLE_CONFIG[role].entrypoint}`,
    );
  }

  if (missing.length > 0 || invalid.length > 0 || !distOk) return false;

  output.log(
    `[preflight] ok role=${role} node_major=24 entrypoint=${ROLE_CONFIG[role].entrypoint}`,
  );
  return true;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  try {
    if (!runPreflight()) process.exitCode = 1;
  } catch {
    console.error('[preflight] unexpected validation failure');
    process.exitCode = 1;
  }
}
