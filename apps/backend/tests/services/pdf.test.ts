/**
 * Unit tests — services/pdf.ts
 *
 * Puppeteer is MOCKED. We do NOT launch Chromium in CI (slow, flaky, would
 * require the browser binary in the CI image). What we prove here:
 *   - the HTML template gets the injection point replaced with valid JSON
 *   - the injected JSON is safe against `</script>` breakouts
 *   - dangerous transcript content is embedded as JSON string, not raw HTML
 *   - the browser singleton is reused across calls
 *   - `closeBrowser` is idempotent
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// -- Mock puppeteer before importing the module under test. ----------------
// Async-returning fns are written as `() => Promise.resolve(...)` rather
// than `async () => ...` to keep ESLint's `require-await` happy — the body
// contains no await, so the async keyword is decorative.
const setContentMock = vi.fn(() => Promise.resolve(undefined));
const pageClose = vi.fn(() => Promise.resolve(undefined));
const pdfMock = vi.fn(() => Promise.resolve(Buffer.from('%PDF-1.4-mock')));
const newPageMock = vi.fn(() =>
  Promise.resolve({
    setContent: setContentMock,
    pdf: pdfMock,
    close: pageClose,
  }),
);
const browserCloseMock = vi.fn(() => Promise.resolve(undefined));
const browserOnMock = vi.fn();
const launchMock = vi.fn(() =>
  Promise.resolve({
    newPage: newPageMock,
    close: browserCloseMock,
    on: browserOnMock,
  }),
);

vi.mock('puppeteer', () => ({
  default: {
    launch: launchMock,
  },
}));

const {
  __setTemplateForTests,
  closeBrowser,
  getOrLaunchBrowser,
  renderAppelPdf,
  renderRecapHtml,
} = await import('../../src/services/pdf.js');

const TEMPLATE_STUB = `
<html><body>
<script type="application/json" id="corya-data"></script>
</body></html>`;

const APPEL = {
  id: 'appel-1',
  cabinet_id: 'cab-1',
  retell_call_id: 'call-1',
  date_appel: '2026-07-31T09:00:00.000Z',
  duree_secondes: 60,
  resultat: 'rdv_pris' as const,
  motif_appel: 'consultation',
  patient_nom: 'Nom',
  patient_prenom: 'Prenom',
  patient_telephone: '+41780000000',
  rdv_date: null,
  rdv_praticien: null,
  transcript: 'Agent: Hello\nUser: World',
  pdf_url: null,
  email_status: 'pending' as const,
};
const CABINET = { nom: 'Cabinet Test' };

beforeEach(() => {
  __setTemplateForTests(TEMPLATE_STUB);
  launchMock.mockClear();
  newPageMock.mockClear();
  setContentMock.mockClear();
  pdfMock.mockClear();
  pageClose.mockClear();
  browserCloseMock.mockClear();
  browserOnMock.mockClear();
  // Reset the module-level singleton so each test starts from a clean state.
  return closeBrowser();
});

afterEach(() => {
  __setTemplateForTests(null);
  vi.clearAllMocks();
});

describe('renderRecapHtml', () => {
  it('injects a JSON payload into the corya-data script tag', () => {
    const html = renderRecapHtml(APPEL, CABINET);
    expect(html).toMatch(/<script type="application\/json" id="corya-data">.+<\/script>/);
    // The template stub had an empty tag before; now it should carry JSON.
    const match = /<script type="application\/json" id="corya-data">(.+?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    interface InjectedShape {
      cabinet: { nom: string };
      appel: {
        retell_call_id?: string;
        transcript: string | null;
      };
    }
    const parsed = JSON.parse(match![1]) as InjectedShape;
    expect(parsed.cabinet.nom).toBe('Cabinet Test');
    expect(parsed.appel.retell_call_id).toBeUndefined(); // not injected
    expect(parsed.appel.transcript).toBe(APPEL.transcript);
  });

  it('neutralises a </script> sequence inside a transcript to prevent breakout', () => {
    const badAppel = {
      ...APPEL,
      transcript: 'Agent: hello </script><script>alert(1)</script>',
    };
    const html = renderRecapHtml(badAppel, CABINET);
    // The literal '</script>' from the transcript must NOT appear inside
    // the injected block (it would close the JSON island tag prematurely).
    // We scan the CONTENT between the opening/closing tag we injected.
    const match = /<script type="application\/json" id="corya-data">(.*?)<\/script>/s.exec(
      html,
    );
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain('</script>');
    // The escaped form is what our serializer produces.
    expect(match![1]).toContain('<\\/script');
  });

  it('throws when the template has no injection point (fail loud)', () => {
    __setTemplateForTests('<html><body>no injection here</body></html>');
    expect(() => renderRecapHtml(APPEL, CABINET)).toThrow(
      /pdf_template_missing_injection_point/,
    );
  });
});

describe('getOrLaunchBrowser', () => {
  it('launches once and reuses the same browser', async () => {
    const b1 = await getOrLaunchBrowser();
    const b2 = await getOrLaunchBrowser();
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(b1).toBe(b2);
  });
});

describe('closeBrowser', () => {
  it('is idempotent — no throw when called before any launch', async () => {
    await expect(closeBrowser()).resolves.toBeUndefined();
  });

  it('closes the underlying browser when one was launched', async () => {
    await getOrLaunchBrowser();
    await closeBrowser();
    expect(browserCloseMock).toHaveBeenCalledTimes(1);
  });
});

describe('renderAppelPdf', () => {
  it('produces bytes and closes the page even on success', async () => {
    const bytes = await renderAppelPdf(APPEL, CABINET);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(0);
    expect(setContentMock).toHaveBeenCalledTimes(1);
    expect(pdfMock).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'A4' }),
    );
    expect(pageClose).toHaveBeenCalledTimes(1);
  });
});
