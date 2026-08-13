import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

describe('TEMP DayZ payload diagnostic', () => {
  test('prints damaged JSON context', () => {
    const names = ['chunk00','chunk01','chunk02','chunk03','tail00','tail01','tail02','tail03','tail04','tail05','tail06'];
    const root = path.resolve(process.cwd(), 'src/modules/ai/generated/dayz129IndexChunks');
    const encoded = names.map((name) => {
      const text = fs.readFileSync(path.join(root, `${name}.ts`), 'utf8');
      const match = text.match(/export default\s+'([A-Za-z0-9+/=]+)'(?:\s+as\s+const)?;/);
      if (!match) throw new Error(`${name}: bad module`);
      return match[1];
    }).join('');
    const normalized = encoded + '='.repeat((4 - encoded.length % 4) % 4);
    const packed = Buffer.from(normalized, 'base64');
    let pos = 10;
    const flags = packed[3];
    if (flags & 4) { const n = packed.readUInt16LE(pos); pos += 2 + n; }
    if (flags & 8) pos = packed.indexOf(0, pos) + 1;
    if (flags & 16) pos = packed.indexOf(0, pos) + 1;
    if (flags & 2) pos += 2;
    const raw = zlib.inflateRawSync(packed.subarray(pos, packed.length - 8)).toString('utf8');
    try { JSON.parse(raw); }
    catch (error) {
      const m = String(error).match(/position\s+(\d+)/i);
      const at = m ? Number(m[1]) : 0;
      console.log(`PAYLOAD_DIAGNOSTIC encoded=${encoded.length} raw=${raw.length} position=${at}`);
      console.log(`PAYLOAD_CONTEXT ${JSON.stringify(raw.slice(Math.max(0, at - 500), at + 500))}`);
    }
    expect(true).toBe(true);
  });
});
