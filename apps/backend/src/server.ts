/** Dedicated executable entrypoint for the Corya API. */
import { logger } from './config/logger.js';
import { startApiServer } from './index.js';
import { toLogFields } from './utils/errors.js';

void startApiServer().catch((err: unknown) => {
  logger.error({ ...toLogFields(err) }, 'api_boot_failed');
  process.exitCode = 1;
});
