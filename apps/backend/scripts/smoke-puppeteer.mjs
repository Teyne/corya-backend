import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const DEFAULT_RENDERS = 3;
const MIN_RENDERS = 1;
const MAX_RENDERS = 10;
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CLEANUP_TIMEOUT_MS = 5_000;

function usage() {
  return 'Usage: npm run smoke:puppeteer -- [--renders 1..10] [--timeout-ms 1000..60000]';
}

function parseBoundedInteger(raw, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error('option value is outside the allowed range');
  }
  return value;
}

export function parseOptions(argv) {
  const options = {
    renders: DEFAULT_RENDERS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  if (argv.length % 2 !== 0) throw new Error('invalid arguments');

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const raw = argv[index + 1];

    if (flag === '--renders') {
      options.renders = parseBoundedInteger(raw, MIN_RENDERS, MAX_RENDERS);
    } else if (flag === '--timeout-ms') {
      options.timeoutMs = parseBoundedInteger(raw, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    } else {
      throw new Error('unknown option');
    }
  }
  return options;
}

function nodeRssMiB(memoryUsage) {
  return Number((memoryUsage().rss / 1024 / 1024).toFixed(1));
}

function syntheticHtml(renderNumber) {
  return `<!doctype html>
<html lang=fr>
  <head>
    <meta charset=utf-8>
    <style>
      body { font-family: Arial, sans-serif; margin: 40px; color: #14213d; }
      h1 { font-size: 24px; }
      p { font-size: 14px; }
    </style>
  </head>
  <body>
    <h1>Corya - preflight Puppeteer</h1>
    <p>Rendu synthetique sequentiel ${renderNumber}.</p>
  </body>
</html>`;
}

async function settleWithin(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          () => true,
          () => false,
        ),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runSmoke(
  options,
  {
    puppeteerApi = puppeteer,
    now = () => performance.now(),
    memoryUsage = () => process.memoryUsage(),
    output = console,
    cleanupTimeoutMs = Math.min(options.timeoutMs, MAX_CLEANUP_TIMEOUT_MS),
  } = {},
) {
  let browser;
  let browserCleanupFailed = false;
  const startedAt = now();
  const initialNodeRssMiB = nodeRssMiB(memoryUsage);
  const results = [];

  try {
    browser = await puppeteerApi.launch({
      headless: true,
      timeout: options.timeoutMs,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    for (let index = 1; index <= options.renders; index += 1) {
      const page = await browser.newPage();
      const renderStartedAt = now();
      let renderFailure;
      let pageClosed = false;
      try {
        page.setDefaultTimeout(options.timeoutMs);
        await page.setContent(syntheticHtml(index), {
          waitUntil: 'load',
          timeout: options.timeoutMs,
        });
        const pdf = await page.pdf({
          format: 'A4',
          printBackground: true,
          timeout: options.timeoutMs,
        });
        const result = {
          render: index,
          duration_ms: Math.round(now() - renderStartedAt),
          pdf_bytes: pdf.byteLength,
          node_rss_mib: nodeRssMiB(memoryUsage),
        };
        results.push(result);
        output.log(`[puppeteer-smoke] render ${JSON.stringify(result)}`);
      } catch (error) {
        renderFailure = error;
      } finally {
        pageClosed = await settleWithin(() => page.close(), cleanupTimeoutMs);
      }

      if (renderFailure !== undefined) throw renderFailure;
      if (!pageClosed) {
        output.error?.('[puppeteer-smoke] page cleanup failed');
        throw new Error('page cleanup failed');
      }
    }
  } finally {
    if (browser !== undefined) {
      const closed = await settleWithin(() => browser.close(), cleanupTimeoutMs);
      if (!closed) {
        output.error?.('[puppeteer-smoke] browser cleanup failed');
        // This handle belongs to the browser instance launched above. Never
        // enumerate or terminate unrelated Chromium processes on the host.
        browser.process()?.kill('SIGKILL');
        browserCleanupFailed = true;
      }
    }
  }

  if (browserCleanupFailed) throw new Error('browser cleanup failed');

  const summary = {
    renders: results.length,
    duration_ms: Math.round(now() - startedAt),
    initial_node_rss_mib: initialNodeRssMiB,
    final_node_rss_mib: nodeRssMiB(memoryUsage),
    peak_node_rss_mib: Math.max(
      initialNodeRssMiB,
      ...results.map((result) => result.node_rss_mib),
    ),
  };
  output.log(`[puppeteer-smoke] ok ${JSON.stringify(summary)}`);
  return summary;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  try {
    const options = parseOptions(process.argv.slice(2));
    await runSmoke(options);
  } catch {
    console.error('[puppeteer-smoke] failed');
    console.error(usage());
    process.exitCode = 1;
  }
}
