/**
 * diagnose-retell-signature.ts
 * ---------------------------------------------------------------------------
 * Local-only diagnostic tool. Given a captured Retell webhook (its
 * `X-Retell-Signature` header + its raw body), tries every plausible
 * combination of {secret, signed-material scheme, digest encoding} and
 * reports which one, if any, reproduces the digest carried by the header.
 *
 * NOT a production dependency. NOT wired into the running app. Purely
 * diagnostic — no DB, no network, stdout only.
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
const dim = (s: string) => paint('2', s);
const bold = (s: string) => paint('1', s);

// ---------------------------------------------------------------------------
// CLI: minimal manual parser. Supported flags:
//   --header <string>
//   --body   <string>
//   --body-file <path>       (bytes read verbatim, no JSON round-trip)
//   --max-age-seconds <n>    (override, default from env or 300)
//   --json-file <path>       (implicit if a positional arg is passed)
//   --help
// ---------------------------------------------------------------------------
interface CliArgs {
  header?: string;
  body?: string;
  bodyFile?: string;
  jsonFile?: string;
  maxAgeSeconds?: number;
  help: boolean;
}

function parseCli(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
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
    '  1. Positional JSON file  { "header": "...", "body": "..." }',
    '     npm run diag:retell -- capture.json',
    '  2. Explicit flags:',
    '     npm run diag:retell -- --header "v=...,d=..." --body \'{"event":"..."}\'',
    '  3. Raw body file (BEST FIDELITY — bytes read verbatim, no JSON re-encode):',
    '     npm run diag:retell -- --header "v=...,d=..." --body-file body.raw',
    '  4. Stdin (pipe the JSON capture):',
    '     cat capture.json | npm run diag:retell',
    '',
    'Options:',
    '  --max-age-seconds <n>   Override the anti-replay window (default 300).',
    '  -h, --help              Show this help.',
    '',
    'Environment: reads RETELL_WEBHOOK_SECRET and RETELL_API_KEY from',
    '<monorepo-root>/.env.local then apps/backend/.env.local.',
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
  // Node's Readable async-iterator yields `any`; we narrow explicitly to
  // avoid unsafe-argument on Buffer.concat.
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
// Combinations to test. 2 secrets x 3 schemes x 3 encodings = 18 rows.
// ---------------------------------------------------------------------------
type SecretName = 'webhook_secret' | 'api_key';
type Scheme = 'body' | 'ts.body' | 'tsbody';
type Encoding = 'hex-lower' | 'hex-upper' | 'base64';

const SCHEMES: readonly Scheme[] = ['body', 'ts.body', 'tsbody'] as const;
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
  secret: SecretName;
  scheme: Scheme;
  encoding: Encoding;
  match: boolean;
}

function renderTable(rows: readonly Row[]): string {
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

  // ------- Resolve header + body (mode priority: file > flags > stdin) -----
  let header: string | undefined;
  let body: Buffer | undefined;

  // Mode: --body-file (raw bytes) — combines with --header
  if (args.bodyFile !== undefined) {
    if (!existsSync(args.bodyFile)) {
      die(`--body-file not found: ${args.bodyFile}`);
    }
    body = readFileSync(args.bodyFile);
    header = args.header;
  }

  // Mode: JSON file
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

  // Mode: explicit --header/--body flags
  if (body === undefined && args.body !== undefined) {
    body = Buffer.from(args.body, 'utf8');
    header = args.header;
  }

  // Mode: stdin JSON
  if (body === undefined) {
    const stdinContent = await readStdin();
    if (stdinContent.trim().length === 0) {
      die(
        'no input provided',
        'pass a JSON capture as arg, or use --header/--body, --body-file, or pipe JSON via stdin. Run --help for details.',
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
      'copy the exact value of X-Retell-Signature — no quotes, no whitespace edits',
    );
  }

  // ------- Resolve secrets from env --------------------------------------
  const webhookSecret = process.env.RETELL_WEBHOOK_SECRET ?? '';
  const apiKey = process.env.RETELL_API_KEY ?? '';
  if (webhookSecret.length === 0 && apiKey.length === 0) {
    die(
      'no Retell secret found in env',
      'set RETELL_WEBHOOK_SECRET and/or RETELL_API_KEY in .env.local (repo root or apps/backend)',
    );
  }

  const secretsToTry: Array<{ name: SecretName; value: string }> = [];
  if (webhookSecret.length > 0) {
    secretsToTry.push({ name: 'webhook_secret', value: webhookSecret });
  }
  if (apiKey.length > 0) {
    secretsToTry.push({ name: 'api_key', value: apiKey });
  }

  // ------- Header echo (safe: no secrets, no body dump) ------------------
  process.stdout.write(bold('Retell signature diagnostic\n'));
  process.stdout.write(
    dim(
      `body: ${body.length} bytes | header ts: ${parsed.timestampMs} | header digest length: ${parsed.digest.length}\n`,
    ),
  );

  // Secret info — NEVER the value. Length + are-they-identical only.
  const secretInfo: string[] = [];
  for (const s of secretsToTry) {
    secretInfo.push(`${s.name}(len=${s.value.length})`);
  }
  if (webhookSecret.length > 0 && apiKey.length > 0) {
    secretInfo.push(
      `identical=${webhookSecret === apiKey ? 'YES' : 'no'}`,
    );
  }
  process.stdout.write(dim(`secrets: ${secretInfo.join(', ')}\n\n`));

  // ------- Run the 18 combinations (or 9 if only one secret set) --------
  const rows: Row[] = [];
  for (const secret of secretsToTry) {
    for (const scheme of SCHEMES) {
      const material = buildSignedMaterial(
        scheme,
        parsed.timestampMs,
        body,
      );
      const hmacBytes = createHmac('sha256', secret.value)
        .update(material)
        .digest();
      for (const encoding of ENCODINGS) {
        const candidate = encodeDigest(hmacBytes, encoding);
        rows.push({
          secret: secret.name,
          scheme,
          encoding,
          match: safeEqual(candidate, parsed.digest),
        });
      }
    }
  }

  process.stdout.write(renderTable(rows) + '\n\n');

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
  process.stdout.write(`  matching combinations: ${matches.length}\n`);
  if (matches.length === 0) {
    process.stdout.write(
      `  ${red('no combination matches — the secret in .env.local is almost certainly wrong (or the body was reformatted; try --body-file)')}\n`,
    );
  } else if (matches.length === 1) {
    const m = matches[0];
    process.stdout.write(
      `  ${green(`use: secret=${m.secret}, scheme=${m.scheme}, encoding=${m.encoding}`)}\n`,
    );
  } else {
    process.stdout.write(
      `  ${red('multiple matches — this is astronomically improbable for HMAC-SHA256. Suspect a script bug, not a success.')}\n`,
    );
    for (const m of matches) {
      process.stdout.write(
        `    - secret=${m.secret}, scheme=${m.scheme}, encoding=${m.encoding}\n`,
      );
    }
  }

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
