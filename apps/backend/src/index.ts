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
import express, { type ErrorRequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
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
  genReqId,
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
  pinoHttp({
    logger,
    // Session 4 vague 3 — correlation id. `genReqId` runs BEFORE the
    // request enters our middleware; the resulting id is what pino
    // stamps into every log line as `req.id`. The `correlationMiddleware`
    // below reads the SAME header/regex so `req.correlationId` and
    // `req.id` are guaranteed equal.
    genReqId,
    // Expose the correlation id in the response BEFORE we know if it was
    // supplied by the client (pino-http runs before our middleware). This
    // is a safety net — the middleware also sets the header, but if a
    // downstream error handler short-circuits, the pino-http level here
    // still emits it.
    customProps: (req) => ({ correlation_id: req.id }),
    // Silence 2xx logs at info level to keep signal high; errors still bubble.
    customLogLevel: (_req, res, err) => {
      if (err) return 'error';
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
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
// Bootstrap — only when this file is the process entry point.
// ---------------------------------------------------------------------------
const isEntryPoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function startApiServer(): Promise<void> {
  await runWave7GatedStartup(startApiRuntime);
}

function startApiRuntime(): void {
  const server = createServer(app);
  // Alert pollers live in the API process (a dead worker cannot report its
  // own death). Kept as a mutable ref so shutdown can call stop().
  let pollers: RunningPollers | null = null;

  server.listen(env.PORT, () => {
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

if (isEntryPoint) {
  void startApiServer().catch((err: unknown) => {
    logger.error({ ...toLogFields(err) }, 'api_boot_failed');
    process.exit(1);
  });
}
