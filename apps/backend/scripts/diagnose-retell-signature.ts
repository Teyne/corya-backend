/**
 * diagnose-retell-signature.ts
 * ---------------------------------------------------------------------------
 * Local-only diagnostic tool. Given a captured Retell webhook (its
 * `X-Retell-Signature` header + its raw body), tries every plausible
 * combination of {secret, signed-material scheme, digest encoding} and
 * reports which one, if any, reproduces the digest carried by the header.
 *
 * Session 2.2 additions:
 *   - **SDK verdict row**. In addition to the 18 manual combinations, we
 *     now call the official `retell-sdk#verify` on the exact same capture
 *     and print its boolean verdict on a dedicated line of the table.
 *     This lets us compare "what the SDK accepts" vs "what our manual
 *     schemas produce" — the whole point of keeping this tool around now
 *     that production delegates to the SDK.
 *   - **--capture-from-ngrok flag**. Fetches the LAST request seen by ngrok
 *     via its inspector API (127.0.0.1:4040), decodes the raw base64 body,
 *     and runs the analysis on the exact bytes ngrok received. This is the
 *     definitive antidote to the "manually reconstructed capture is off by
 *     one bit" trap that spawned this whole migration.
 *
 * NOT a production dependency. NOT wired into the running app. Purely
 * diagnostic — no DB access, and the ONLY network call is the localhost
 * ngrok inspector, gated behind --capture-from-ngrok.
 *
 * IMPORTANT: this script deliberately never prints the value of any secret.
 * It is expected to be pasted into tickets / chat transcripts.
 * ---------------------------------------------------------------------------
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { verify as retellSdkVerify } from 'retell-sdk';

// ---------------------------------------------------------------------------
// .env loading — mirrors apps/backend/src/config/env.ts. We deliberately do
// NOT `import { env } from '../src/config/env.js'`: env.ts calls
// process.exit(1) on any validation failure, which is the wrong behaviour
// for a diagnostic tool run by a developer with a possibly-broken config.
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..'); // apps/backend
const monorepoRoot = resolve(backendRoot, '..', '..'); // <repo root>

for (const candidate of [
  resolve(backendRoot, '.env.local'),
  resolve(monorepoRoot, '.env.local'),
]) {
  if (existsSync(candidate)) {
    // quiet: true silences dotenv's "injected env" tip line so our stdout
    // stays copy-paste-clean for tickets.
    dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

// ---------------------------------------------------------------------------
// ANSI helpers. No color if not a TTY, or NO_COLOR is set, or FORCE_COLOR=0.
// ---------------------------------------------------------------------------
const colorEnabled =
  process.stdout.isTTY === true &&
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== '0';

function paint(code: string, s: string): string {
  return colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const green = (s: string) => paint('32', s);
const red = (s: string) => paint('31', s);
const yellow = (s: string) => paint('33', s);
const dim = (s: string) => paint('2', s);
const bold = (s: string) => paint('1', s);

// ---------------------------------------------------------------------------
// CLI: minimal manual parser. Supported flags:
//   --header <string>
//   --body   <string>
//   --body-file <path>       (bytes read verbatim, no JSON round-trip)
//   --max-age-seconds <n>    (override, default from env or 300)
//   --json-file <path>       (implicit if a positional arg is passed)
//   --capture-from-ngrok     (fetch last request from 127.0.0.1:4040)
//   --help
// ---------------------------------------------------------------------------
interface CliArgs {
  header?: string;
  body?: string;
  bodyFile?: string;
  jsonFile?: string;
  maxAgeSeconds?: number;
  captureFromNgrok: boolean;
  help: boolean;
}

function parseCli(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, captureFromNgrok: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--header':
        args.header = argv[++i];
        break;
      case '--body':
        args.body = argv[++i];
        break;
      case '--body-file':
        args.bodyFile = argv[++i];
        break;
      case '--json-file':
        args.jsonFile = argv[++i];
        break;
      case '--max-age-seconds':
        args.maxAgeSeconds = Number(argv[++i]);
        break;
      case '--capture-from-ngrok':
        args.captureFromNgrok = true;
        break;
      default:
        if (a !== undefined && !a.startsWith('-')) rest.push(a);
    }
  }
  // First positional arg = JSON file (backwards-friendly shorthand).
  if (args.jsonFile === undefined && rest[0] !== undefined) {
    args.jsonFile = rest[0];
  }
  return args;
}

function printHelp(): void {
  const lines = [
    'Usage: npm run diag:retell -- [options]',
    '',
    'Input modes (priority order):',
    '  1. --capture-from-ngrok  (RECOMMENDED — bypasses copy/paste errors):',
    '     npm run diag:retell -- --capture-from-ngrok',
    '     Fetches the last POST captured by ngrok at http://127.0.0.1:4040',
    '     and analyses its EXACT bytes.',
    '  2. Positional JSON file:',
    '     npm run diag:retell -- capture.json',
    '  3. Explicit flags:',
    '     npm run diag:retell -- --header "v=...,d=..." --body \'{"event":"..."}\'',
    '  4. Raw body file:',
    '     npm run diag:retell -- --header "v=...,d=..." --body-file body.raw',
    '  5. Stdin (pipe the JSON capture):',
    '     cat capture.json | npm run diag:retell',
    '',
    'Options:',
    '  --max-age-seconds <n>   Override the anti-replay window (default 300).',
    '  -h, --help              Show this help.',
    '',
    'Environment: reads RETELL_API_KEY from <monorepo-root>/.env.local then',
    'apps/backend/.env.local.',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Small failure helper. Never throws with stack traces to stdout.
// ---------------------------------------------------------------------------
function die(msg: string, hint?: string): never {
  const out = hint !== undefined ? `${msg}\n  hint: ${hint}` : msg;
  process.stderr.write(`${red('error:')} ${out}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Stdin reader. Returns '' if stdin is a TTY (no pipe attached).
// ---------------------------------------------------------------------------
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// ngrok inspector fetch. Defensive: NEVER assumes the response shape;
// checks each field and gives a clear message if anything is off.
// ---------------------------------------------------------------------------
interface NgrokCapture {
  header: string;
  body: Buffer;
}

async function fetchFromNgrok(): Promise<NgrokCapture> {
  const url = 'http://127.0.0.1:4040/api/requests/http';
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (e) {
    die(
      `could not reach ngrok inspector at ${url}`,
      `is ngrok running? start it with "ngrok http 3000". Underlying: ${(e as Error).message}`,
    );
  }
  if (!resp.ok) {
    die(
      `ngrok inspector returned HTTP ${resp.status}`,
      'ngrok is running but the inspector is not answering as expected',
    );
  }

  // Parse defensively. The ngrok inspector JSON shape can drift between
  // versions; we validate every field we touch and give the user something
  // actionable rather than a stack trace.
  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch (e) {
    die(
      'ngrok inspector response was not valid JSON',
      (e as Error).message,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    die('ngrok inspector JSON is not an object');
  }

  const root = parsed as { requests?: unknown };
  const requests = root.requests;
  if (!Array.isArray(requests)) {
    die(
      'ngrok inspector JSON has no `requests` array',
      'the ngrok API contract may have changed. Inspect http://127.0.0.1:4040/api/requests/http manually and update this script.',
    );
  }
  if (requests.length === 0) {
    die(
      'no HTTP requests captured by ngrok yet',
      'trigger a webhook first (Retell dashboard test call), then re-run this script',
    );
  }

  // Take the LAST request. ngrok returns most-recent-first in current
  // versions, but we check both possibilities defensively by picking the
  // one with the largest timestamp when available; otherwise index 0.
  const last = pickLastRequest(requests);
  if (last === null) {
    die(
      'ngrok returned requests but none had a recognisable shape',
      'expected each request to be an object with a `request` field carrying headers + body',
    );
  }

  return last;
}

/**
 * Extract { header, body } from an ngrok request entry. Returns null if
 * the entry does not look like an HTTP POST with a signature header and a
 * base64-encoded body. Defensive: EVERY narrowing step is checked.
 */
function extractCapture(entry: unknown): NgrokCapture | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const req = (entry as { request?: unknown }).request;
  if (typeof req !== 'object' || req === null) return null;

  // Headers: ngrok exposes them as `{ Header-Name: ["value"] }`.
  const headers = (req as { headers?: unknown }).headers;
  if (typeof headers !== 'object' || headers === null) return null;

  const headerValue = findHeader(headers, 'x-retell-signature');
  if (headerValue === null) return null;

  // Body: ngrok exposes it as base64 in `raw` (name varies across versions:
  // `raw`, `body`, `rawBase64`). We try each.
  const body = extractBodyBytes(req as Record<string, unknown>);
  if (body === null) return null;

  return { header: headerValue, body };
}

function findHeader(headers: object, name: string): string | null {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== target) continue;
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  }
  return null;
}

function extractBodyBytes(req: Record<string, unknown>): Buffer | null {
  // Try known field names in order of likelihood.
  for (const key of ['raw', 'body', 'rawBase64', 'raw_body']) {
    const v = req[key];
    if (typeof v !== 'string' || v.length === 0) continue;
    // ngrok returns base64. If it turns out to be plain UTF-8 in some
    // version, base64 decoding is idempotent-ish for pure-ASCII JSON
    // (invalid chars = fail) — we catch and fall through.
    try {
      const decoded = Buffer.from(v, 'base64');
      // Sanity check: if the base64 decoded to a plausibly-JSON payload
      // (starts with '{' or '['), accept it. Otherwise assume the field
      // was already raw text.
      if (decoded.length > 0) {
        const first = String.fromCharCode(decoded[0]);
        if (first === '{' || first === '[') return decoded;
      }
    } catch {
      // fall through
    }
    // Fallback: treat the string as UTF-8 raw body.
    return Buffer.from(v, 'utf8');
  }
  return null;
}

function pickLastRequest(requests: readonly unknown[]): NgrokCapture | null {
  // Iterate from index 0 (most-recent-first assumption); as soon as we
  // find one we can decode, return it. If none decode, return null.
  for (const entry of requests) {
    const c = extractCapture(entry);
    if (c !== null) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Signature header parse. Same regex as production code — intentionally
// duplicated so this tool is self-contained.
// ---------------------------------------------------------------------------
const SIGNATURE_HEADER_RE = /^v=(\d+),d=([a-fA-F0-9]+)$/;

interface ParsedHeader {
  timestampMs: number;
  digest: string;
}

function parseHeader(raw: string): ParsedHeader | null {
  const m = SIGNATURE_HEADER_RE.exec(raw.trim());
  if (!m) return null;
  const ts = Number(m[1]);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return { timestampMs: ts, digest: m[2] };
}

// ---------------------------------------------------------------------------
// Combinations to test.
//
// Note (session 2.2): we now know from inspecting the SDK that Retell signs
// with HMAC-SHA256(apiKey, body + timestampMs) — the timestamp goes at the
// END, not the start, and there is no separator. We added `body.ts` to the
// schemes to reflect that, alongside the historical guesses.
//
// The manual grid remains as a diagnostic AID: if the SDK verdict disagrees
// with our matching row, that's a real signal something has drifted.
// ---------------------------------------------------------------------------
type Scheme = 'body' | 'ts.body' | 'tsbody' | 'body.ts' | 'bodyts';
type Encoding = 'hex-lower' | 'hex-upper' | 'base64';

const SCHEMES: readonly Scheme[] = ['body', 'ts.body', 'tsbody', 'body.ts', 'bodyts'] as const;
const ENCODINGS: readonly Encoding[] = [
  'hex-lower',
  'hex-upper',
  'base64',
] as const;

function buildSignedMaterial(
  scheme: Scheme,
  timestampMs: number,
  body: Buffer,
): Buffer {
  switch (scheme) {
    case 'body':
      return body;
    case 'ts.body':
      return Buffer.concat([Buffer.from(`${timestampMs}.`, 'utf8'), body]);
    case 'tsbody':
      return Buffer.concat([Buffer.from(`${timestampMs}`, 'utf8'), body]);
    case 'body.ts':
      return Buffer.concat([body, Buffer.from(`.${timestampMs}`, 'utf8')]);
    case 'bodyts':
      // This is the Retell SDK's actual scheme (body + timestampMs).
      return Buffer.concat([body, Buffer.from(`${timestampMs}`, 'utf8')]);
  }
}

function encodeDigest(hmacBytes: Buffer, encoding: Encoding): string {
  switch (encoding) {
    case 'hex-lower':
      return hmacBytes.toString('hex');
    case 'hex-upper':
      return hmacBytes.toString('hex').toUpperCase();
    case 'base64':
      return hmacBytes.toString('base64');
  }
}

/** Timing-safe equality on the ASCII representation of the digests. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Keep compute cost roughly constant even in the mismatch branch.
    const dummy = Buffer.alloc(ab.length);
    timingSafeEqual(ab, dummy);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Table rendering. Fixed column widths, ASCII borders.
// ---------------------------------------------------------------------------
interface Row {
  secret: string;
  scheme: string;
  encoding: string;
  match: boolean;
}

function renderTable(rows: readonly Row[], sdkVerdict: boolean | null): string {
  const headers = ['secret', 'signed material', 'digest', 'match'];
  const widths = [16, 16, 10, 5];
  const sep = `+-${'-'.repeat(widths[0])}-+-${'-'.repeat(widths[1])}-+-${'-'.repeat(
    widths[2],
  )}-+-${'-'.repeat(widths[3])}-+`;
  const line = (cells: readonly string[]): string =>
    `| ${cells
      .map((c, i) => c.padEnd(widths[i]))
      .join(' | ')} |`;
  const out: string[] = [sep, line(headers), sep];
  for (const r of rows) {
    const mark = r.match ? green('OK') : red('no');
    out.push(line([r.secret, r.scheme, r.encoding, mark]));
  }
  // Dedicated SDK row, visually separated.
  out.push(sep);
  const sdkMark =
    sdkVerdict === null
      ? yellow('n/a')
      : sdkVerdict
      ? green('OK')
      : red('no');
  out.push(line([bold('sdk'), 'retell-sdk#verify', '(sdk)', sdkMark]));
  out.push(sep);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main(): Promise<number> {
  const args = parseCli(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  // ------- Resolve header + body (mode priority: ngrok > file > flags > stdin)
  let header: string | undefined;
  let body: Buffer | undefined;

  // Mode 1: --capture-from-ngrok (RECOMMENDED)
  if (args.captureFromNgrok) {
    process.stdout.write(dim('fetching last request from ngrok (127.0.0.1:4040)...\n'));
    const cap = await fetchFromNgrok();
    header = cap.header;
    body = cap.body;
  }

  // Mode 2: --body-file (raw bytes) — combines with --header
  if (body === undefined && args.bodyFile !== undefined) {
    if (!existsSync(args.bodyFile)) {
      die(`--body-file not found: ${args.bodyFile}`);
    }
    body = readFileSync(args.bodyFile);
    header = args.header;
  }

  // Mode 3: JSON file
  if (body === undefined && args.jsonFile !== undefined) {
    if (!existsSync(args.jsonFile)) {
      die(`JSON file not found: ${args.jsonFile}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(args.jsonFile, 'utf8'));
    } catch (e) {
      die(
        `JSON file is not valid JSON: ${args.jsonFile}`,
        (e as Error).message,
      );
    }
    const p = parsed as { header?: unknown; body?: unknown };
    if (typeof p.header !== 'string' || typeof p.body !== 'string') {
      die(
        'JSON capture must have shape { "header": "...", "body": "..." }',
        'or use --body-file for raw-byte fidelity',
      );
    }
    header = p.header;
    body = Buffer.from(p.body, 'utf8');
  }

  // Mode 4: explicit --header/--body flags
  if (body === undefined && args.body !== undefined) {
    body = Buffer.from(args.body, 'utf8');
    header = args.header;
  }

  // Mode 5: stdin JSON
  if (body === undefined) {
    const stdinContent = await readStdin();
    if (stdinContent.trim().length === 0) {
      die(
        'no input provided',
        'pass --capture-from-ngrok (recommended), a JSON capture as arg, use --header/--body, --body-file, or pipe JSON via stdin. Run --help for details.',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdinContent);
    } catch (e) {
      die('stdin content is not valid JSON', (e as Error).message);
    }
    const p = parsed as { header?: unknown; body?: unknown };
    if (typeof p.header !== 'string' || typeof p.body !== 'string') {
      die('stdin JSON must have shape { "header": "...", "body": "..." }');
    }
    header = p.header;
    body = Buffer.from(p.body, 'utf8');
  }

  if (header === undefined || header.length === 0) {
    die(
      'missing signature header',
      'pass --header "v=...,d=..." or include it in the JSON capture',
    );
  }

  // ------- Parse header --------------------------------------------------
  const parsed = parseHeader(header);
  if (!parsed) {
    die(
      'signature header does not match `v=<digits>,d=<hex>` format',
      'copy the exact value of X-Retell-Signature — no quotes, no whitespace edits. If Retell has changed their format, the SDK may still accept it; check its verdict specifically.',
    );
  }

  // ------- Resolve secret from env --------------------------------------
  // Session 2.2: only RETELL_API_KEY is used (webhook secret is gone).
  const apiKey = process.env.RETELL_API_KEY ?? '';
  if (apiKey.length === 0) {
    die(
      'RETELL_API_KEY not found in env',
      'set RETELL_API_KEY in .env.local (repo root or apps/backend)',
    );
  }

  // ------- Header echo (safe: no secrets, no body dump) ------------------
  process.stdout.write(bold('Retell signature diagnostic\n'));
  process.stdout.write(
    dim(
      `body: ${body.length} bytes | header ts: ${parsed.timestampMs} | header digest length: ${parsed.digest.length}\n`,
    ),
  );
  process.stdout.write(dim(`secrets: api_key(len=${apiKey.length})\n\n`));

  // ------- Run the manual combinations ----------------------------------
  const rows: Row[] = [];
  for (const scheme of SCHEMES) {
    const material = buildSignedMaterial(scheme, parsed.timestampMs, body);
    const hmacBytes = createHmac('sha256', apiKey).update(material).digest();
    for (const encoding of ENCODINGS) {
      const candidate = encodeDigest(hmacBytes, encoding);
      rows.push({
        secret: 'api_key',
        scheme,
        encoding,
        match: safeEqual(candidate, parsed.digest),
      });
    }
  }

  // ------- Ask the SDK ---------------------------------------------------
  // The whole point of the SDK migration: this is the ground truth.
  let sdkVerdict: boolean | null = null;
  try {
    sdkVerdict = await retellSdkVerify(
      body.toString('utf-8'),
      apiKey,
      header,
    );
  } catch (e) {
    // Log without stack; the SDK might throw on a runtime without Web Crypto.
    process.stderr.write(
      `${yellow('warn:')} retell-sdk#verify threw: ${(e as Error).message}\n`,
    );
    sdkVerdict = null;
  }

  process.stdout.write(renderTable(rows, sdkVerdict) + '\n\n');

  // ------- Freshness block ----------------------------------------------
  const maxAgeSeconds =
    args.maxAgeSeconds ??
    Number(process.env.RETELL_SIGNATURE_MAX_AGE_SECONDS ?? 300);
  const nowMs = Date.now();
  const driftSeconds = (parsed.timestampMs - nowMs) / 1000; // signed
  const inWindow = Math.abs(driftSeconds) <= maxAgeSeconds;
  const iso = new Date(parsed.timestampMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  process.stdout.write(bold('Timestamp freshness\n'));
  process.stdout.write(`  header ts   : ${parsed.timestampMs} ms  (${iso})\n`);
  process.stdout.write(`  script now  : ${nowMs} ms  (${nowIso})\n`);
  process.stdout.write(
    `  drift       : ${driftSeconds >= 0 ? '+' : ''}${driftSeconds.toFixed(3)} s  (positive = header in the future)\n`,
  );
  process.stdout.write(`  max-age     : ${maxAgeSeconds} s\n`);
  process.stdout.write(
    `  in window   : ${inWindow ? green('YES') : red('NO — replay window would REJECT this webhook')}\n\n`,
  );

  // ------- Final summary -------------------------------------------------
  const matches = rows.filter((r) => r.match);
  process.stdout.write(bold('Summary\n'));
  process.stdout.write(`  matching manual combinations: ${matches.length}\n`);
  process.stdout.write(
    `  SDK verdict                 : ${
      sdkVerdict === null
        ? yellow('n/a (SDK threw)')
        : sdkVerdict
        ? green('OK')
        : red('rejected')
    }\n`,
  );
  if (matches.length === 0 && sdkVerdict === true) {
    process.stdout.write(
      `  ${yellow('note: the SDK accepts this signature but no manual scheme matches — the SDK is using a scheme we have not enumerated. Trust the SDK; the manual grid is stale.')}\n`,
    );
  } else if (matches.length > 0 && sdkVerdict === false) {
    process.stdout.write(
      `  ${red('note: manual scheme matches but SDK rejects — probably a timestamp / replay window discrepancy inside the SDK.')}\n`,
    );
  } else if (matches.length === 0 && sdkVerdict === false) {
    process.stdout.write(
      `  ${red('no combination matches. Most likely: wrong RETELL_API_KEY in .env.local, or the body was reformatted between capture and diagnosis. Try --capture-from-ngrok for byte-exact fidelity.')}\n`,
    );
  } else if (matches.length > 0 && sdkVerdict === true) {
    const m = matches[0];
    process.stdout.write(
      `  ${green(`match agreed: secret=${m.secret}, scheme=${m.scheme}, encoding=${m.encoding} (SDK also OK)`)}\n`,
    );
  }

  // Exit code: prefer the SDK verdict when we have it, otherwise fall back
  // to the manual grid.
  if (sdkVerdict !== null) return sdkVerdict ? 0 : 1;
  return matches.length > 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Last-resort guard — should never trigger because die() handles the
    // known error paths. If it does fire, we print only the message, never
    // the stack, to keep the output copy-paste-safe.
    const msg =
      err instanceof Error ? err.message : 'unknown error in diagnostic';
    process.stderr.write(`${red('fatal:')} ${msg}\n`);
    process.exit(1);
  },
);
