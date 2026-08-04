/**
 * Corya backend HTTP module.
 *
 * Exports:
 *   - `app`            : Express instance (used by supertest, no port bound)
 *   - `version`        : from package.json (ESM-safe read, no require)
 *   - `startApiServer` : gated HTTP bootstrap used by `src/server.ts`
 *
 * Importing this module never binds a port. The dedicated `src/server.ts`
 * entrypoint owns the implicit bootstrap used by Node, tsx and PM2.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { buildHttpLoggerOptions } from './config/http-logging.js';
import { webhooksRouter } from './routes/webhooks.js';
import { healthRouter, setHealthPackageVersion } from './routes/health.js';
import { logRetellSecretSourceOnce } from './services/retell.js';
import { closeAlertTransporter, logAlertingModeOnce } from './services/alert.js';
import {
  closeReceiptTransporter,
  startAlertPollers,
  type RunningPollers,
} from './services/alert-pollers.js';
import {
  CORRELATION_HEADER,
  correlationMiddleware,
} from './middleware/correlation.js';
import { buildWebhookRateLimiter } from './middleware/rate-limit.js';
import { toLogFields } from './utils/errors.js';
import { runWave7GatedStartup } from './services/startup.js';

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

// Session 4 vague 4 — trust the FIRST N reverse-proxy hops (Jelastic
// front). Numeric value ONLY: `true` blindly trusts every hop and lets a
// hostile client spoof X-Forwarded-For. Kept even though our webhook
// rate limit is global (not per-IP) because pino-http uses req.ip in log
// lines — without this, every request would appear to originate from
// the local Jelastic proxy.
app.set('trust proxy', env.TRUST_PROXY_HOPS);

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
  pinoHttp(buildHttpLoggerOptions(logger)),
);

// Middleware order matters: pino-http first (stamps req.id via genReqId),
// then our correlation middleware (writes req.correlationId + response
// header). Both derive from the same regex so the values match.
app.use(correlationMiddleware);
// Expose the correlation header for CORS-mode reads by the browser.
app.use((_req, res, next) => {
  const existing = res.getHeader('Access-Control-Expose-Headers');
  const list = typeof existing === 'string' ? existing.split(',').map((s) => s.trim()) : [];
  if (!list.includes(CORRELATION_HEADER)) list.push(CORRELATION_HEADER);
  res.setHeader('Access-Control-Expose-Headers', list.join(', '));
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Session 4 vague 4 — global fixed-window rate limit on /webhooks/*.
// See src/middleware/rate-limit.ts for the "not per IP" rationale. Mount
// BEFORE the router so a burst is rejected before entering any handler.
app.use('/webhooks', buildWebhookRateLimiter());
app.use('/webhooks', webhooksRouter);

// Session 4 vague 4 — /health (liveness) and /health/deep (readiness).
// The old inline handler moved to src/routes/health.ts. `uptime_seconds`
// is added to the /health body (bootTimeMs latch inside the module).
setHealthPackageVersion(version);
app.use('/health', healthRouter);

// ---------------------------------------------------------------------------
// Error handler (must have 4 args to be picked up by Express as an error mw).
// Never leaks stack traces in production.
// ---------------------------------------------------------------------------
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // pino-http attached a request-scoped logger to req.log.
  req.log.error({ ...toLogFields(err) }, 'unhandled error in request pipeline');
  if (res.headersSent) return;
  const body =
    env.NODE_ENV === 'production'
      ? { error: 'internal_server_error' }
      : {
          error: 'internal_server_error',
          error_name: toLogFields(err).err_name,
        };
  res.status(500).json(body);
};
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Explicit bootstrap. Importing this module never starts the API.
// ---------------------------------------------------------------------------
export async function startApiServer(): Promise<void> {
  await runWave7GatedStartup(startApiRuntime);
}

function startApiRuntime(): Promise<void> {
  const server = createServer(app);
  // Alert pollers live in the API process (a dead worker cannot report its
  // own death). Kept as a mutable ref so shutdown can call stop().
  let pollers: RunningPollers | null = null;

  const listening = new Promise<void>((resolveListening, rejectListening) => {
    const onBindError = (err: Error): void => {
      rejectListening(err);
    };

    server.once('error', onBindError);
    server.listen(env.PORT, () => {
      server.off('error', onBindError);
      resolveListening();
      logger.info(
        { port: env.PORT, env: env.NODE_ENV, version },
        'corya-backend listening',
      );
      // Emit the "which secret are we signing with?" log EXACTLY ONCE per
      // process (not per request). Placed here so it appears right after the
      // listening line — easy to spot in Jelastic logs.
      logRetellSecretSourceOnce();
      // Session 4: same visibility contract for the alerting mode. WARN when
      // disabled (founder requirement).
      logAlertingModeOnce();
      // Start the periodic alert checks (worker_stale, jobs_backlog,
      // dead_letter poller). Also runs one pass at startup.
      pollers = startAlertPollers();
    });
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'received signal, shutting down');
    const forceTimer = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    // Stop pollers first so no new alert emails are dispatched during
    // shutdown. The stopped Promise resolves once the running pass (if
    // any) finishes.
    if (pollers) {
      pollers.stop();
    }

    server.close((err) => {
      // Close the local alert transporters last — closing them before
      // pollers finished could truncate an in-flight alert.
      try {
        closeAlertTransporter();
        closeReceiptTransporter();
      } catch (closeErr: unknown) {
        logger.warn(
          { ...toLogFields(closeErr) },
          'api_alert_close_failed',
        );
      }
      if (err) {
        logger.error(
          { ...toLogFields(err) },
          'error while closing HTTP server',
        );
        process.exit(1);
      }
      logger.info('HTTP server closed cleanly');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return listening;
}
