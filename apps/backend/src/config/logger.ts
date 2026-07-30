/**
 * Pino logger with mandatory nLPD / art. 321 CP redaction.
 *
 * - pino-pretty transport in development
 * - JSON structured output in production / test
 * - Level driven by env.LOG_LEVEL
 * - Redacts patient identifiers, transcript content and auth headers.
 *   The redaction paths use wildcards to cover nested objects and arrays
 *   (e.g. call.patient_nom, req.body.patient_nom, ...).
 *
 * ANY new logging path that could carry patient data MUST add the field
 * to this list. See docs/compliance.md § "Ce qui ne doit JAMAIS être loggé".
 */
import pino, { type LoggerOptions } from 'pino';
import { env } from './env.js';

const redactPaths: string[] = [
  // Patient PII — top-level and nested (single-level wildcard).
  'patient_nom',
  'patient_prenom',
  'patient_telephone',
  '*.patient_nom',
  '*.patient_prenom',
  '*.patient_telephone',
  '*.*.patient_nom',
  '*.*.patient_prenom',
  '*.*.patient_telephone',

  // Transcript content — never log.
  'transcript',
  '*.transcript',
  '*.*.transcript',

  // Auth material.
  'authorization',
  'Authorization',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-retell-signature"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-retell-signature"]',
];

const isProd = env.NODE_ENV === 'production';

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
    remove: false,
  },
  base: {
    service: 'corya-backend',
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const transport = !isProd
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: false,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

export const logger = pino({
  ...baseOptions,
  ...(transport ? { transport } : {}),
});

export type Logger = typeof logger;
