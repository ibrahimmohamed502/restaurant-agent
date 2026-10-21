/**
 * Generates the PWA / iOS icon set from the brand mark (same artwork as favicon.svg).
 *
 * Dev-only tool — `sharp` is NOT a project dependency:
 *   npm i -D sharp --prefix .   (or: npx --yes -p sharp node scripts/generate-pwa-icons.mjs)
 *   node scripts/generate-pwa-icons.mjs
 *
 * Output (committed to the repo, so the Docker build never needs sharp):
 *   public/icons/icon-180.png       → apple-touch-icon (iOS home screen)
 *   public/icons/icon-192.png       → manifest icon
 *   public/icons/icon-512.png       → manifest icon
 *   public/icons/maskable-512.png   → manifest maskable icon (safe zone = inner 80%)
 *   public/icons/icon.svg           → source artwork (editable)
 *   public/icons/maskable.svg       → source artwork (maskable variant)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
/** Optional output directory (used by the one-off icon build on a machine with sharp installed). */
const outDir = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '../public/icons');

const BRAND = '#4a2c1a';
const CREAM = '#f5ece1';

/** The cup + steam artwork, identical to apps/web/public/favicon.svg. */
const ART = `
  <g fill="none" stroke="${CREAM}" stroke-width="1.6" stroke-linecap="round">
    <path d="M12.4 6.6c0-1.2 1.2-1.6 1.2-2.8" opacity="0.9"/>
    <path d="M16 5.6c0-1.2 1.2-1.6 1.2-2.8" opacity="0.7"/>
    <path d="M19.6 6.6c0-1.2 1.2-1.6 1.2-2.8" opacity="0.5"/>
  </g>
  <path d="M8.5 13.5h13.5v4.8a6.75 6.75 0 0 1-6.75 6.75 6.75 6.75 0 0 1-6.75-6.75v-4.8Z" fill="${CREAM}" fill-opacity="0.16" stroke="${CREAM}" stroke-width="1.8"/>
  <path d="M22 15h1.8a3.4 3.4 0 0 1 0 6.8H22" stroke="${CREAM}" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M6.5 26.5h17" stroke="${CREAM}" stroke-width="1.8" stroke-linecap="round"/>
  <ellipse cx="15.25" cy="18.2" rx="2.1" ry="3.1" fill="${CREAM}" transform="rotate(-18 15.25 18.2)"/>
`;

/**
 * @param {object} opts
 * @param {number} opts.scale  artwork scale around the 16/16 centre
 * @param {boolean} opts.rounded  rounded corners (false = full bleed, for maskable)
 */
function buildSvg({ scale, rounded }) {
  const bg = rounded
    ? `<rect width="32" height="32" rx="7" fill="${BRAND}"/>`
    : `<rect width="32" height="32" fill="${BRAND}"/>`;
  const art =
    scale === 1
      ? ART
      : `<g transform="translate(16 16) scale(${scale}) translate(-16 -16)">${ART}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">${bg}${art}</svg>`;
}

const sources = {
  'icon.svg': buildSvg({ scale: 1, rounded: true }),
  'maskable.svg': buildSvg({ scale: 0.62, rounded: false })
};

const targets = [
  { file: 'icon-180.png', size: 180, svg: sources['icon.svg'] },
  { file: 'icon-192.png', size: 192, svg: sources['icon.svg'] },
  { file: 'icon-512.png', size: 512, svg: sources['icon.svg'] },
  { file: 'maskable-512.png', size: 512, svg: sources['maskable.svg'] }
];

mkdirSync(outDir, { recursive: true });
for (const [name, svg] of Object.entries(sources)) {
  writeFileSync(resolve(outDir, name), svg, 'utf8');
}
for (const { file, size, svg } of targets) {
  await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(resolve(outDir, file));
  process.stdout.write(`✓ ${file} (${size}×${size})\n`);
}
process.stdout.write('done\n');
