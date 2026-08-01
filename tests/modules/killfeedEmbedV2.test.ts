/**
 * Killfeed V2 Embed: exakte Rohkoordinaten (KILL-COORD, keine Rundung),
 * Killer wird angezeigt.
 */
import { buildKillfeedEmbedV2 } from '../../src/modules/killfeed/embedBuilder';
import type { KillfeedView } from '../../src/modules/killfeed/killfeedV2';

const VIEW: KillfeedView = {
  category: 'DEATH',
  occurredAt: new Date('2026-08-01T12:00:00Z'),
  victimName: 'Opfer',
  victimGameId: 'v',
  victimPos: '1234.56 6789.01 123.45',
  killerName: 'Killer',
  killerGameId: 'k',
  killerPos: '4321.98 8765.43 210.00',
  weapon: 'M4A1',
  distanceMeters: 137.6,
};

describe('buildKillfeedEmbedV2', () => {
  it('zeigt Opfer + Killer und rohe Opfer-Koordinaten ohne Rundung', () => {
    const json = buildKillfeedEmbedV2(VIEW, '#dc2626').toJSON();
    const fields = JSON.stringify(json.fields);
    expect(fields).toContain('Opfer');
    expect(fields).toContain('Killer');
    expect(fields).toContain('1234.56 6789.01 123.45'); // roh, keine Rundung
    expect(fields).toContain('137.6 m');
  });

  it('Killer-Pos erscheint nur wenn im View gesetzt (roh)', () => {
    const json = buildKillfeedEmbedV2(VIEW, '#dc2626').toJSON();
    expect(JSON.stringify(json.fields)).toContain('4321.98 8765.43 210.00');
  });

  it('ohne killerPos kein Toeter-Pos-Feld', () => {
    const json = buildKillfeedEmbedV2({ ...VIEW, killerPos: null }, '#dc2626').toJSON();
    expect(JSON.stringify(json.fields)).not.toContain('Toeter-Pos');
  });
});
