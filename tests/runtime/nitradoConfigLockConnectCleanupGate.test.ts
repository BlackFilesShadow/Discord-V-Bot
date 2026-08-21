import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const source = normalizeSourceNewlines(fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/nitrado/configMutationLock.ts'),
  'utf8',
));

describe('Nitrado-1P config-lock connect cleanup gate', () => {
  it('haelt connect und advisory-lock query gemeinsam innerhalb derselben Cleanup-try-Grenze', () => {
    const fn = source.indexOf('export async function tryAcquireNitradoConfigMutationLock(');
    const client = source.indexOf('const client = new PgClient(', fn);
    const tryBlock = source.indexOf('try {', client);
    const connect = source.indexOf('await client.connect();', tryBlock);
    const query = source.indexOf("SELECT pg_try_advisory_lock($1, $2) AS locked", connect);
    const catchBlock = source.indexOf('} catch (error) {', query);
    const cleanup = source.indexOf('await client.end().catch(() => undefined);', catchBlock);
    const rethrow = source.indexOf('throw error;', cleanup);

    expect(fn).toBeGreaterThanOrEqual(0);
    expect(client).toBeGreaterThan(fn);
    expect(tryBlock).toBeGreaterThan(client);
    expect(connect).toBeGreaterThan(tryBlock);
    expect(query).toBeGreaterThan(connect);
    expect(catchBlock).toBeGreaterThan(query);
    expect(cleanup).toBeGreaterThan(catchBlock);
    expect(rethrow).toBeGreaterThan(cleanup);
    expect(source.slice(client, tryBlock)).not.toContain('await client.connect();');
  });

  it('behaelt den normalen Busy-Pfad und den idempotenten Release-Vertrag unveraendert', () => {
    expect(source).toContain("if (result.rows?.[0]?.locked !== true) {");
    expect(source).toContain('await client.end();\n      return null;');
    expect(source).toContain('let released = false;');
    expect(source).toContain('if (released) return;');
    expect(source).toContain("SELECT pg_advisory_unlock($1, $2)");
    expect(source).toContain('await client.end().catch(() => undefined);');
  });

  it('behaelt Namespace und Key-Ableitung identisch zum 1C-Vertrag', () => {
    expect(source).toContain('const CONN_LOCK_NAMESPACE = 0x4e495452;');
    expect(source).toContain("crypto.createHash('sha256').update(nitradoConnId).digest();");
    expect(source).toContain('return [CONN_LOCK_NAMESPACE, digest.readInt32BE(0)];');
  });
});
