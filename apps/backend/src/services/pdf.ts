/**
 * PDF récap generation via Puppeteer.
 *
 * ---------------------------------------------------------------------------
 * Why a singleton browser
 * ---------------------------------------------------------------------------
 * `puppeteer.launch()` costs 1-2 s (Chromium boot). Doing this per PDF would
 * blow the "< 5 s PDF, < 10 s email end-to-end" SLA on its own. We keep ONE
 * browser instance per worker process, reuse it across jobs, and lazy-launch
 * on first use. If the browser dies (crash, OOM), the next call transparently
 * re-launches — see `getOrLaunchBrowser`.
 *
 * ---------------------------------------------------------------------------
 * Why we inject data via a <script id="corya-data" type="application/json">
 * rather than string-interpolating into HTML
 * ---------------------------------------------------------------------------
 * A transcript may contain '<', '>', quotes, or a literal '</script>'. String
 * interpolation into HTML would require case-by-case escaping and would still
 * leak on the '</script>' edge case. Injecting as a JSON island read via
 * `textContent` in the template's JS gives us a single, uniform escape rule:
 *   - Replace '</' with '<\/' in the serialized JSON to neutralise the
 *     closing-script pattern.
 *   - JSON.stringify already escapes control chars and quotes.
 *   - The template reads .textContent (never innerHTML), so HTML in a value
 *     is treated as literal text, never parsed.
 *
 * ---------------------------------------------------------------------------
 * Shutdown
 * ---------------------------------------------------------------------------
 * `closeBrowser()` must be called by the worker on SIGTERM/SIGINT. Otherwise
 * Jelastic sends SIGKILL after its grace period and Chromium leaks a
 * lingering process for a few seconds.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser } from 'puppeteer';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type {
  AppelProcessingRow,
  CabinetProcessingRow,
} from '../types/index.js';
import { withTimeout } from '../utils/timeout.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the HTML template. Kept relative to this file so the
 * bundler / tsx / node can all resolve it without config.
 */
const TEMPLATE_PATH = resolve(__dirname, '..', 'templates', 'pdf-recap.html');

/**
 * Template is read from disk exactly once and kept in memory. It is a few
 * KB — no meaningful RAM cost, and it removes disk I/O from the hot path.
 * A code change to the template requires a worker restart, which matches
 * how we deploy anyway.
 */
let templateCache: string | null = null;
function loadTemplate(): string {
  if (templateCache === null) {
    templateCache = readFileSync(TEMPLATE_PATH, 'utf-8');
  }
  return templateCache;
}

/**
 * Test-only hook so a unit test can point the loader at a fixture instead of
 * the real template.
 */
export function __setTemplateForTests(content: string | null): void {
  templateCache = content;
}

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------

let browserPromise: Promise<Browser> | null = null;

async function launchBrowser(): Promise<Browser> {
  // Args matter on Linux/Jelastic where the sandbox often can't work
  // inside a container. `--no-sandbox` is standard for headless server
  // usage. `--disable-dev-shm-usage` avoids /dev/shm exhaustion on
  // small containers.
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  // If Chromium dies unexpectedly, drop the cached promise so the next
  // call triggers a fresh launch.
  browser.on('disconnected', () => {
    logger.warn('puppeteer_browser_disconnected — will relaunch on next PDF');
    browserPromise = null;
  });
  return browser;
}

/**
 * Returns the shared Browser, launching it the first time and after a
 * crash. Concurrent callers await the same in-flight launch, so we never
 * launch twice.
 */
export async function getOrLaunchBrowser(): Promise<Browser> {
  if (browserPromise === null) {
    browserPromise = launchBrowser().catch((err: unknown) => {
      // Reset on launch failure so a retry actually retries.
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/**
 * Close the shared browser. Idempotent — safe to call multiple times or
 * before the browser has ever been launched.
 */
export async function closeBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  if (p === null) return;
  try {
    const b = await p;
    await b.close();
  } catch (err: unknown) {
    // Best-effort. A failing close on shutdown must not mask the actual
    // shutdown cause. Log and move on.
    logger.warn(
      { err_name: err instanceof Error ? err.name : 'unknown' },
      'puppeteer_close_failed',
    );
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Serialize a value for safe embedding inside `<script type="application/json">`.
 * The `</` -> `<\/` replacement is the one thing JSON.stringify does not do
 * and would otherwise let a value containing `</script>` break out.
 */
function safeJsonForScriptTag(value: unknown): string {
  return JSON.stringify(value).replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * Public entry: build the HTML for a given appel + cabinet by injecting
 * data into the template. Kept as a separate function so tests can assert
 * on the HTML without spinning up Puppeteer.
 */
export function renderRecapHtml(
  appel: AppelProcessingRow,
  cabinet: Pick<CabinetProcessingRow, 'nom'>,
  extras?: { summary?: string | null },
): string {
  const tpl = loadTemplate();
  const dataset = {
    cabinet: { nom: cabinet.nom },
    appel: {
      date_appel: appel.date_appel,
      duree_secondes: appel.duree_secondes,
      patient_nom: appel.patient_nom,
      patient_prenom: appel.patient_prenom,
      patient_telephone: appel.patient_telephone,
      motif_appel: appel.motif_appel,
      resultat: appel.resultat,
      rdv_date: appel.rdv_date,
      rdv_praticien: appel.rdv_praticien,
      transcript: appel.transcript,
      summary: extras?.summary ?? null,
    },
  };
  const jsonPayload = safeJsonForScriptTag(dataset);

  // Replace the EMPTY <script id="corya-data" ...></script> with a filled
  // one. The regex is intentionally narrow — matches the exact tag in the
  // template. A more permissive regex would risk matching arbitrary future
  // additions.
  const rendered = tpl.replace(
    /<script type="application\/json" id="corya-data"><\/script>/,
    `<script type="application/json" id="corya-data">${jsonPayload}</script>`,
  );
  if (rendered === tpl) {
    // The regex didn't match. Fail loudly rather than emit an empty PDF.
    throw new Error('pdf_template_missing_injection_point');
  }
  return rendered;
}

/**
 * Render a PDF for a given appel + cabinet. Returns the raw PDF bytes.
 *
 * Time budget: under 5 s in normal operation. Puppeteer's `waitUntil:
 * 'networkidle0'` is not strictly required (we have zero external
 * resources) but is cheap here — it becomes a no-op immediately after
 * `setContent` resolves.
 */
export async function renderAppelPdf(
  appel: AppelProcessingRow,
  cabinet: Pick<CabinetProcessingRow, 'nom'>,
  extras?: { summary?: string | null },
): Promise<Buffer> {
  const html = renderRecapHtml(appel, cabinet, extras);
  const browser = await getOrLaunchBrowser();
  const page = await browser.newPage();
  // Session 4 vague 3: enforce the timeout at TWO layers.
  //   1. `page.setDefaultTimeout` — Puppeteer's OWN cancellation, which
  //      also closes the underlying CDP session cleanly. Without this,
  //      a runaway render keeps a renderer tab alive forever even after
  //      our outer promise rejects.
  //   2. `withTimeout` around the whole render — our contract error
  //      class (TimeoutError) is what the retry classifier keys on.
  // If they disagree, Puppeteer usually wins first (it holds the tab
  // control); if not, withTimeout rejects and the finally-block below
  // still closes the page — both paths reclaim resources.
  page.setDefaultTimeout(env.TIMEOUT_PDF_MS);
  try {
    const bytes = await withTimeout(
      (async (): Promise<Uint8Array> => {
        // waitUntil: 'load' is sufficient — the template has ZERO external
        // resources (font-family stack is system-only). 'networkidle0'
        // would add a needless idle window on every render.
        await page.setContent(html, { waitUntil: 'load' });
        return page.pdf({
          format: 'A4',
          printBackground: true,
          // A slight extra margin buffer; @page in the CSS is authoritative.
          preferCSSPageSize: true,
        });
      })(),
      env.TIMEOUT_PDF_MS,
      'pdf:renderAppelPdf',
    );
    return Buffer.from(bytes);
  } finally {
    // Always close the page — a leaked page holds an entire renderer tab.
    await page.close().catch(() => {
      // ignore
    });
  }
}
