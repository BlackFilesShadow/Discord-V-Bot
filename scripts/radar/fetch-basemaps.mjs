import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(await readFile(resolve(root, 'scripts/radar/asset-manifest.json'), 'utf8'));
const outputDirectory = resolve(root, 'dashboard-ui/public/radar/maps');
const verifyOnly = process.argv.includes('--verify');

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

for (const [map, definition] of Object.entries(manifest.maps)) {
  const output = resolve(outputDirectory, `${map.toLowerCase()}.png`);
  let bytes;
  try {
    bytes = await readFile(output);
  } catch {
    if (verifyOnly) throw new Error(`${map}: lokale Basemap fehlt (${output}).`);
    const url = `https://raw.githubusercontent.com/BohemiaInteractive/DayZ-Central-Economy/${manifest.source.commit}/${definition.basemap.path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${map}: Download fehlgeschlagen (${response.status}).`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const actual = checksum(bytes);
  if (actual !== definition.basemap.sha256) throw new Error(`${map}: SHA-256 stimmt nicht mit dem Manifest ueberein.`);
  if (!verifyOnly) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(output, bytes);
  }
  console.log(`${map}: ${verifyOnly ? 'geprueft' : 'bereitgestellt'} (${actual})`);
}