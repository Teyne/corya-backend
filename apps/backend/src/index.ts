/**
 * Corya backend HTTP entry point.
 *
 * Exports:
 *   - `app`     : Express instance (used by supertest, no port bound)
 *   - `version` : from package.json (ESM-safe read, no require)
 *
 * When this module is the process entry point, it also binds the port and
 * wires SIGTERM / SIGINT for graceful shutdown.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
} from 'express';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { webhooksRouter } from './routes/webhooks.js';
import { logRetellSecretSourceOnce } from './services/retell.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// -- version from package.json (ESM: no require, no JSON import assertion) --
interface PackageJsonShape {
  version: string;
}
const pkgPath = resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJsonShape;
export const version: string = pkg.version;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export const app = express();

// Do not advertise the framework. Removes the `x-powered-by: Express`
// response header on every route. Cheap defence-in-depth.
app.disable('x-powered-by');

// CORS: origin comes from env, comma-separated list, no wildcard tolerated.
const allowedOrigins = env.CORS_ORIGIN.split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin / server-to-server calls (no Origin header) AND
      // any explicitly whitelisted origin. Reject everything else.
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }),
);

// Capture the raw body Buffer for downstream signature verification
// (Retell HMAC-SHA256). The parsed JSON still lands in `req.body` for
// normal use; `req.rawBody` is consumed by the webhook route.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);

app.use(
  pinoHttp({
    logger,
    // Silence 2xx logs at info level to keep signal high; errors still bubble.
    customLogLevel: (_req, res, err) => {
      if (err) return 'error';
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/webhooks', webhooksRouter);

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    version,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Error handler (must have 4 args to be picked up by Express as an error mw).
// Never leaks stack traces in production.
// ---------------------------------------------------------------------------
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // pino-http attached a request-scoped logger to req.log.
  req.log.error({ err }, 'unhandled error in request pipeline');
  if (res.headersSent) return;
  const body =
    env.NODE_ENV === 'production'
      ? { error: 'internal_server_error' }
      : {
          error: 'internal_server_error',
          message: err instanceof Error ? err.message : String(err),
        };
  res.status(500).json(body);
};
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Bootstrap — only when this file is the process entry point.
// ---------------------------------------------------------------------------
const isEntryPoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const server = createServer(app);

  server.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, version },
      'corya-backend listening',
    );
    // Emit the "which secret are we signing with?" log EXACTLY ONCE per
    // process (not per request). Placed here so it appears right after the
    // listening line — easy to spot in Jelastic logs.
    logRetellSecretSourceOnce();
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'received signal, shutting down');
    const forceTimer = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    server.close((err) => {
      if (err) {
        logger.error({ err }, 'error while closing HTTP server');
        process.exit(1);
      }
      logger.info('HTTP server closed cleanly');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
