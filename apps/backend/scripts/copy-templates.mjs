/**
 * Post-build asset copy: HTML templates -> dist/templates.
 *
 * tsc only emits compiled JS. Our runtime resolves templates relative to
 * the compiled file (`<dist>/services/pdf.js` -> `../templates`), so the
 * templates must be copied alongside the JS. Kept as a plain .mjs so no
 * TypeScript / dep chain is required to run it.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, '..', 'src', 'templates');
const dst = resolve(__dirname, '..', 'dist', 'templates');

if (!existsSync(src)) {
  console.error(`copy-templates: source not found: ${src}`);
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`copy-templates: copied ${src} -> ${dst}`);
