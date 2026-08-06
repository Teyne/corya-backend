/**
 * Safe pino-http configuration.
 *
 * HTTP requests and responses contain attacker-controlled headers and may
 * carry authentication material. Keep an explicit allowlist instead of
 * serializing those objects and trying to enumerate every possible secret.
 */
import type { Logger } from 'pino';
import type { Options } from 'pino-http';
import { genReqId } from '../middleware/correlation.js';

interface SerializedRequestShape {
  method?: unknown;
  url?: unknown;
}

interface SerializedResponseShape {
  statusCode?: unknown;
}

interface SerializedErrorShape {
  name?: unknown;
  type?: unknown;
}

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
]);

function safeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (value === '*') return value;

  try {
    let parsed: URL;
    if (value.startsWith('//')) {
      parsed = new URL(`http:${value}`);
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) {
      parsed = new URL(value);
    } else {
      // Reject malformed/non-HTTP request targets instead of logging them.
      if (!value.startsWith('/')) return '/';
      parsed = new URL(value, 'http://http-log.invalid');
    }
    const pathname = parsed.pathname.length > 0 ? parsed.pathname : '/';
    return pathname
      .split('/')
      .map((segment) => {
        let decoded = segment;
        try {
          decoded = decodeURIComponent(segment);
        } catch {
          // Malformed percent-encoding stays opaque and bounded to pathname.
        }
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(decoded)
          ? ':id'
          : segment;
      })
      .join('/');
  } catch {
    return '/';
  }
}

function serializeRequest(value: unknown): Record<string, unknown> {
  const request = value as SerializedRequestShape;
  return {
    method: typeof request.method === 'string' ? request.method : '',
    url: safeUrl(request.url),
  };
}

function serializeResponse(value: unknown): Record<string, unknown> {
  const response = value as SerializedResponseShape;
  return {
    statusCode:
      typeof response.statusCode === 'number' ? response.statusCode : null,
  };
}

function serializeError(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return { type: 'Error' };
  }

  try {
    const error = value as SerializedErrorShape;
    const candidate =
      typeof error.type === 'string'
        ? error.type
        : typeof error.name === 'string'
          ? error.name
          : '';
    return {
      type: SAFE_ERROR_TYPES.has(candidate) ? candidate : 'Error',
    };
  } catch {
    return { type: 'Error' };
  }
}

export function buildHttpLoggerOptions(logger: Logger): Options {
  return {
    logger,
    genReqId,
    customProps: (req) => ({ correlation_id: req.id }),
    // Apply the allowlist directly to the native HTTP objects. This avoids
    // constructing pino's standard representation, which includes headers.
    wrapSerializers: false,
    serializers: {
      // No request/response header, socket or remote address can therefore
      // reach either automatic logs or the req.log child binding. Errors keep
      // only a bounded type: never message, stack or custom properties.
      req: serializeRequest,
      res: serializeResponse,
      err: serializeError,
    },
    customLogLevel: (_req, res, err) => {
      if (err) return 'error';
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  };
}

// Exported for tests only. Do not import from application code.
export const __internals = { safeUrl, serializeError };
