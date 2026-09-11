import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/factions/factionEmbed.ts'),
  'utf8',
);

describe('faction live-sync serialization wiring', () => {
  it('serialisiert einzelne Fraktions-Embeds strikt pro factionId', () => {
    expect(source).toContain("import { runKeyedSerial } from '../../utils/keyedPromiseQueue';");
    expect(source).toContain('return runKeyedSerial(postLocks, factionId, async () => {');
    expect(source).not.toContain('const prev = postLocks.get(factionId);');
  });

  it('serialisiert die Fraktions-Uebersicht strikt pro Guild', () => {
    expect(source).toContain('await runKeyedSerial(listLocks, key, async () => {');
    expect(source).not.toContain('const prev = listLocks.get(key);');
  });

  it('laedt den Fraktionszustand innerhalb der serialisierten Arbeit frisch aus der DB', () => {
    const queue = source.indexOf('return runKeyedSerial(postLocks, factionId, async () => {');
    const load = source.indexOf('const f = await loadFaction(factionId);', queue);
    expect(queue).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(queue);
  });
});
