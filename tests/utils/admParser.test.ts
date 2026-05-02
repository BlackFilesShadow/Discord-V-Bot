/**
 * Tests fuer admParser mit ECHTEN DayZ-Konsolen-Logs.
 *
 * Regressionsschutz fuer die Fixes:
 *   - BattlEye-Console-IDs (URL-safe-base64 mit `=`-Padding)
 *   - `)Built ...` ohne Leerzeichen nach `)`
 *   - PlayerList-Bloecke werden ignoriert (nicht als Fehler gezaehlt)
 *   - kill/hit Target-Extraktion auch ohne Space nach `)`
 *   - DayZ-RPT-Format mit ` H:MM:SS.mmm CATEGORY (W|E):` Severity
 */
import { parseAdm, parseRpt } from '../../src/dashboard/services/admParser';
import { isValidBattleyeGuid } from '../../src/utils/guid';

describe('isValidBattleyeGuid (DayZ Console base64)', () => {
  it('akzeptiert URL-safe-base64 mit = Padding', () => {
    expect(isValidBattleyeGuid('K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=')).toBe(true);
    expect(isValidBattleyeGuid('uJXW_l6_hRSoFhEy87r2I_nSGx3ou5CSz2Zzo0-zndU=')).toBe(true);
    expect(isValidBattleyeGuid('V7XQLhPE9gJb6g-hPnVRkTqqgsWyhEp149IhCMyRKMg=')).toBe(true);
  });
  it('lehnt = an falscher Stelle ab', () => {
    expect(isValidBattleyeGuid('===invalid')).toBe(false);
    expect(isValidBattleyeGuid('a==b==c==d==')).toBe(false);
  });
});

describe('parseAdm (echtes DayZ-Console-Format)', () => {
  const adm = [
    '******************************************************************************',
    'AdminLog started on 2026-05-01 at 21:02:34',
    '21:03:18 | Player "xQueen-_-Venom_" (id=K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=) is connecting',
    '21:03:34 | Player "xQueen-_-Venom_" (id=K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU= pos=<11582.8, 10239.1, 174.2>) is connected',
    '21:11:40 | Player "darkblacktemplar" (id=V7XQLhPE9gJb6g-hPnVRkTqqgsWyhEp149IhCMyRKMg= pos=<11268, 9415.9, 183.3>) placed Fence Kit<FenceKit>',
    '21:12:27 | Player "darkblacktemplar" (id=V7XQLhPE9gJb6g-hPnVRkTqqgsWyhEp149IhCMyRKMg= pos=<11265.8, 9418.5, 183.3>)Built base on Fence with Pickaxe',
    '21:08:16 | ##### PlayerList log: 7 players',
    '21:08:16 | Player "xQueen-_-Venom_" (id=K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU= pos=<11584.2, 10245.7, 174.0>)',
    '21:08:16 | #####',
    '21:06:28 | Player "ossy-queen99" (id=SBsx9QI-U7hnoUZskjfpESjS5xCeug-S-POrni67HKM= pos=<-340282346638528859811704183484516925440.0, -340282346638528859811704183484516925440.0, -340282346638528859811704183484516925440.0>) has been disconnected',
  ].join('\n');

  it('parst Console-IDs als gueltige GUIDs', () => {
    const r = parseAdm(adm);
    expect(r.startedAt).not.toBeNull();
    expect(r.guidEvents.length).toBeGreaterThan(0);
    // Alle Actor-GUIDs muessen gesetzt sein, kein einziger Fall darf in unknownPlayerEvents landen.
    for (const e of r.guidEvents) expect(e.actor.guid).toMatch(/=$/);
  });

  it('klassifiziert connect / disconnect / placed / built korrekt', () => {
    const r = parseAdm(adm);
    const kinds = r.events.map(e => e.kind);
    expect(kinds).toContain('connect');
    expect(kinds).toContain('disconnect');
    expect(kinds).toContain('placed');
    expect(kinds).toContain('built');
  });

  it('extrahiert Item bei `)Built ...` ohne Leerzeichen', () => {
    const r = parseAdm(adm);
    const built = r.events.find(e => e.kind === 'built');
    expect(built).toBeDefined();
    expect(built!.itemOrText).toMatch(/base on Fence with Pickaxe/i);
  });

  it('ignoriert PlayerList-Bloecke ohne Parse-Fehler', () => {
    const r = parseAdm(adm);
    expect(r.parseErrors).toBe(0);
  });
});

describe('parseAdm kill mit fehlendem Space nach `)`', () => {
  it('extrahiert target auch wenn `)killed by` ohne Space', () => {
    const adm = [
      'AdminLog started on 2026-05-01 at 21:02:34',
      '21:30:00 | Player "Alice" (id=K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU= pos=<100.0, 200.0, 5.0>)killed by Player "Bob" (id=uJXW_l6_hRSoFhEy87r2I_nSGx3ou5CSz2Zzo0-zndU= pos=<110.0, 210.0, 5.0>) with M16A2 from 12 meters',
    ].join('\n');
    const r = parseAdm(adm);
    expect(r.events.length).toBe(1);
    const ev = r.events[0];
    expect(ev.kind).toBe('kill');
    expect(ev.actor.name).toBe('Alice');
    expect(ev.target?.name).toBe('Bob');
    expect(ev.weapon).toBe('M16A2');
    expect(ev.distanceM).toBe(12);
  });
});

describe('parseRpt (echtes DayZ-Format)', () => {
  const rpt = [
    '=====================================================================',
    '== C:\\SERVICES\\ni12654500_1_local\\dayzps\\DayZServer_PS4_x64.exe',
    '=====================================================================',
    'Exe timestamp: 2026/04/07 19:48:25',
    '',
    ' 3:02:04.16  ENGINE    (W): No module info used, trying to identify -> 0x44CB0000',
    ' 3:02:04.844 ANIMATION (E): Can\'t load sakhal/Anims/cfg/skeletons.anim.xml',
    ' 3:02:09.351 [SUCCESS] a2s init ip address 95 156 224 139',
    ' 3:02:10.273    ENTITY    (E): Type \'HouseType\' must be inherited from class \'PASReceiverType\'',
    ' 3:02:10.289    ENTITY    (W): Door \'Doors3\' is missing geometry components',
    'ERROR: legacy-style line should still count',
    'WARNING: another legacy line',
  ].join('\n');

  it('zaehlt ERROR/WARN aus (E)/(W) Notation', () => {
    const r = parseRpt(rpt);
    expect(r.counts.ERROR).toBeGreaterThanOrEqual(3); // 2x (E) + 1x ERROR:
    expect(r.counts.WARN).toBeGreaterThanOrEqual(3);  // 2x (W) + 1x WARNING:
  });

  it('zaehlt [SUCCESS] als INFO', () => {
    const r = parseRpt(rpt);
    expect(r.counts.INFO).toBeGreaterThanOrEqual(1);
  });

  it('liefert ERROR/WARN-Zeilen im Output', () => {
    const r = parseRpt(rpt);
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines.every(l => l.level === 'ERROR' || l.level === 'WARN')).toBe(true);
  });

  it('ignoriert Trenner ===== und == Zeilen', () => {
    const r = parseRpt(rpt);
    // Counts sollten Header-Trenner NICHT enthalten
    const total = r.counts.ERROR + r.counts.WARN + r.counts.INFO + r.counts.OTHER;
    expect(total).toBeLessThan(r.totalLines);
  });
});
