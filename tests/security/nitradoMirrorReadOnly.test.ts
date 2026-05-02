/**
 * Hard Safety Test:
 *  - Der Mirror ist STRIKT READ-ONLY.
 *  - Keine Datei in src/modules/nitrado/mirror/* darf je schreibende
 *    HTTP-Verben oder schreibende Nitrado-Helper enthalten.
 *  - Wenn dieser Test rot wird, wurde die Read-Only-Garantie verletzt.
 */

import { promises as fs } from 'fs';
import path from 'path';

const MIRROR_DIR = path.resolve(__dirname, '../../src/modules/nitrado/mirror');

const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'HTTP method POST', re: /method\s*:\s*['"]POST['"]/i },
  { name: 'HTTP method PUT', re: /method\s*:\s*['"]PUT['"]/i },
  { name: 'HTTP method PATCH', re: /method\s*:\s*['"]PATCH['"]/i },
  { name: 'HTTP method DELETE', re: /method\s*:\s*['"]DELETE['"]/i },
  { name: 'axios.post', re: /axios\.post\s*\(/ },
  { name: 'axios.put', re: /axios\.put\s*\(/ },
  { name: 'axios.patch', re: /axios\.patch\s*\(/ },
  { name: 'axios.delete', re: /axios\.delete\s*\(/ },
  { name: 'http.post', re: /\.http\.post\s*\(/ },
  { name: 'http.put', re: /\.http\.put\s*\(/ },
  { name: 'http.delete', re: /\.http\.delete\s*\(/ },
  { name: 'NitradoClient import (write-capable)', re: /from\s+['"][^'"]*nitradoClient['"]/ },
  { name: 'setSetting call', re: /\bsetSetting\s*\(/ },
  { name: 'mutateWhitelist call', re: /\bmutateWhitelist\s*\(/ },
  { name: 'restart call (Nitrado)', re: /['"]\/services\/[^'"]*\/restart['"]/ },
  { name: 'file_server upload', re: /file_server\/upload/ },
  { name: 'file_server delete', re: /file_server\/delete/ },
  { name: 'file_server move', re: /file_server\/move/ },
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) out.push(...await walk(p));
    else if (it.isFile() && it.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('Nitrado Mirror — Read-Only-Garantie', () => {
  test('keine schreibenden Verben/Importe in src/modules/nitrado/mirror/*', async () => {
    const files = await walk(MIRROR_DIR);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      // Kommentare/Strings, die in Test- oder Doku-Zeilen erlaubt sind, ignorieren:
      // Wir sind hier streng — selbst Kommentare würden den Test reizen, daher
      // bleiben die Mirror-Dateien sauber von diesen Wörtern (außer in Doku-Header,
      // siehe folgende Whitelist).
      const cleaned = text;
      for (const p of FORBIDDEN_PATTERNS) {
        if (p.re.test(cleaned)) {
          violations.push(`${path.relative(process.cwd(), file)}: ${p.name}`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(`READ-ONLY-Garantie verletzt:\n  - ${violations.join('\n  - ')}`);
    }
  });
});
