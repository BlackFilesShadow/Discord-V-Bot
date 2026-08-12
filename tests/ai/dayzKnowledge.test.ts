import {
  DAYZ_129_PROFILES,
  buildDayzKnowledgeContext,
  detectDayzMaps,
  detectDayzTypeReference,
  getDayzGroundingTruthBlock,
} from '../../src/modules/ai/dayzKnowledge';

describe('DayZ 1.29 grounded knowledge', () => {
  it('enthaelt die empirischen Kartenprofile aus den drei Referenz-ZIPs', () => {
    expect(DAYZ_129_PROFILES.chernarus.typesCount).toBe(1942);
    expect(DAYZ_129_PROFILES.livonia.typesCount).toBe(1939);
    expect(DAYZ_129_PROFILES.sakhal.typesCount).toBe(1955);
    expect(DAYZ_129_PROFILES.chernarus.maxTypeNominal).toBe(120);
    expect(DAYZ_129_PROFILES.livonia.maxTypeNominal).toBe(110);
    expect(DAYZ_129_PROFILES.sakhal.maxTypeNominal).toBe(150);
  });

  it('erkennt Kartenaliases', () => {
    expect(detectDayzMaps('Livonia / Enoch')).toEqual(['livonia']);
    expect(detectDayzMaps('Chernarus und Sakhal vergleichen')).toEqual(['chernarus', 'sakhal']);
  });

  it('erkennt konkrete eingebettete Type-Referenzen', () => {
    expect(detectDayzTypeReference('M4A1 nominal?')).toBe('M4A1');
    expect(detectDayzTypeReference('Wie ist die Wasserflasche?')).toBe('WaterBottle');
  });

  it('erklaert Kartenvariation statt Universalwert', () => {
    const r = buildDayzKnowledgeContext('Mosin9130 types.xml Chernarus Livonia Sakhal vergleichen');
    expect(r.found).toBe(true);
    expect(r.text).toMatch(/Chernarus: nominal=40, min=35/);
    expect(r.text).toMatch(/Livonia: nominal=16, min=10/);
    expect(r.text).toMatch(/Sakhal: nominal=10, min=7/);
    expect(r.text).toMatch(/KEINEN davon als universellen Vanilla-Wert/i);
  });

  it('kodiert den vierfachen Halluzinationscheck', () => {
    const t = getDayzGroundingTruthBlock();
    expect(t).toMatch(/1\. DATEI-BELEG/);
    expect(t).toMatch(/2\. KARTEN-VERGLEICH/);
    expect(t).toMatch(/3\. OFFIZIELLE SEMANTIK/);
    expect(t).toMatch(/4\. ANTWORT-CHECK/);
  });
});
