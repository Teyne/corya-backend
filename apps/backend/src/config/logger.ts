/**
 * Pino logger with mandatory nLPD / art. 321 CP redaction.
 *
 * Redaction strategy — two complementary layers:
 *
 *   1. `redact.paths` (fast, static): covers well-known top-level & shallow
 *      header paths — cheap and predictable.
 *
 *   2. `formatters.log` (recursive sanitizer): walks the log object and
 *      censors any key whose name is in `SENSITIVE_KEYS`, at ANY depth,
 *      through objects AND arrays. This is what actually protects us from
 *      the Retell payload shape `call.transcript_object[*].content` (and
 *      `words[*].word`), which fast-redact's single-star wildcard cannot
 *      express portably.
 *
 * WHY a recursive sanitizer instead of enumerating every array path:
 *   - fast-redact's `[*]` array wildcard requires knowing the full path,
 *     and Retell payloads may be logged under `req.body.call.…`, `payload.…`,
 *     `{ event }` shorthand, etc. Enumerating all combinations is fragile;
 *     the next log site that forgets a variant becomes a compliance breach.
 *   - The recursive sanitizer is O(n) over the object size and runs once
 *     per log call. At our volume it is negligible.
 *   - Trade-off: any legitimate field named e.g. `transcript_object` will
 *     also be censored. This is intentional — the field name itself is our
 *     signal that the value must not be logged.
 *
 * ANY new field carrying patient data MUST be added to `SENSITIVE_KEYS`.
 * See `docs/compliance.md` § "Ce qui ne doit JAMAIS être loggé".
 */
import pino, {
  type DestinationStream,
  type LoggerOptions,
} from 'pino';
import { env } from './env.js';

/**
 * Keys whose value is ALWAYS censored, wherever they appear in the log
 * object tree. Case-insensitive match.
 *
 * When a key matches, the ENTIRE value is replaced by `[REDACTED]`,
 * including nested arrays/objects — so redacting `transcript_object`
 * automatically covers every `content` and `words[*].word` inside it.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  [
    // Patient PII
    'patient_nom',
    'patient_prenom',
    'patient_telephone',
    'numero_appelant_masque',
    'maskednumber',
    'maskedtransfernumber',

    // Retell call payload — verbatim / audio / phone identifiers
    'transcript',
    'transcript_object',
    'recording_url',
    'public_log_url',
    'from_number',
    'to_number',
    'signedurl',
    'pdf_url',

    // Auth material. Redact a complete headers object so an unknown future
    // authentication header cannot bypass a finite key blacklist.
    'headers',
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-health-token',
    'proxy-authorization',
    'www-authenticate',
    'x-auth-token',
    'x-retell-signature',
  ].map((k) => k.toLowerCase()),
);

const CENSOR = '[REDACTED]';
const MAX_DEPTH = 12;
const SAFE_ERROR_TYPES: ReadonlySet<string> = new Set([
  'Error',
  'AggregateError',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AbortError',
  'TimeoutError',
  'WebhookValidationError',
  'RetellSignatureError',
  'CabinetNotFoundError',
]);

function serializeError(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return { type: 'Error' };
  }

  try {
    const error = value as { name?: unknown; type?: unknown };
    const candidate =
      typeof error.type === 'string'
        ? error.type
        : typeof error.name === 'string'
          ? error.name
          : '';
    return { type: SAFE_ERROR_TYPES.has(candidate) ? candidate : 'Error' };
  } catch {
    return { type: 'Error' };
  }
}

/**
 * Recursively walk `value` and censor any property whose key matches
 * `SENSITIVE_KEYS`. Preserves shape otherwise so pino-pretty still renders
 * usefully in dev.
 *
 * NOTE: returns a fresh object; never mutates the input.
 */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[REDACTED:MAXDEPTH]';
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v, depth + 1));
  }

  if (typeof value === 'object') {
    // Preserve Error instances until the strict `err` serializer below
    // replaces them with an allowlisted type only.
    if (value instanceof Error) return value;

    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        out[key] = CENSOR;
      } else {
        out[key] = sanitize(src[key], depth + 1);
      }
    }
    return out;
  }

  return value;
}

// -- Fast-path redact for the common shallow header locations. The recursive
// sanitizer would catch these too, but declaring them here is documentation
// AND gives pino a fast constant-path early exit.
const redactPaths: string[] = [
  'authorization',
  'Authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-retell-signature"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-retell-signature"]',
];

const isProd = env.NODE_ENV === 'production';
// Pretty transport is a dev-only convenience. In test and prod we emit raw
// JSON so tests can parse output and prod tooling gets structured logs.
const usePrettyTransport = env.NODE_ENV === 'development';

function buildOptions(): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    serializers: {
      // Never serialize Error.message, stack, cause or enumerable custom
      // properties. Callers needing scrubbed diagnostics use toLogFields().
      err: serializeError,
    },
    redact: {
      paths: redactPaths,
      censor: CENSOR,
      remove: false,
    },
    formatters: {
      // `log` runs on the merged log object AFTER serializers have replaced
      // known keys (err, req, res). That means req.headers is already the
      // serializer output, and our recursive walker will still catch any
      // sensitive header the serializer let through.
      log(obj: Record<string, unknown>): Record<string, unknown> {
        return sanitize(obj) as Record<string, unknown>;
      },
    },
    base: {
      service: 'corya-backend',
      env: env.NODE_ENV,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

/**
 * Build a logger. In production/test/CI, pass a `destination` to capture
 * output (e.g. a Writable stream in tests). When no destination is given
 * and we are in development, pino-pretty is wired for human-readable logs.
 */
export function createLogger(destination?: DestinationStream): pino.Logger {
  const options = buildOptions();
  if (destination) {
    return pino(options, destination);
  }
  if (usePrettyTransport && !isProd) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          singleLine: false,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }
  return pino(options);
}

export const logger = createLogger();

export type Logger = typeof logger;

// Exported for tests only. Do not import from application code.
export const __internals = { sanitize, serializeError, SENSITIVE_KEYS };
