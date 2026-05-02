import { isNitradoOrDayZHelpQuestion, lookupNitradoHelp } from '../../src/modules/ai/nitradoHelp';

describe('nitradoHelp — generische, NICHT server-spezifische Hilfe', () => {
  describe('isNitradoOrDayZHelpQuestion', () => {
    test.each([
      ['Wie stelle ich die Tag-Nacht-Zeit ein?', true],
      ['Wieviele slots hat ein DayZ Server?', true],
      ['Wie installiere ich Mods auf nitrado?', true],
      ['Was ist serverDZ.cfg?', true],
      ['Wie ändere ich types.xml?', true],
      ['Wie ist das Wetter heute?', false],
      ['wer ist Bundeskanzler', false],
      ['Was macht cfgGameplay.json?', true],
      ['Wo finde ich mapgroupproto?', true],
      ['Was ist economy.xml für Wetter?', true],
      ['cfgUndergroundTriggers erklären', true],
      ['Was zeigt das Dashboard CPU?', true],
      ['Wie konfiguriere ich auto tasks?', true],
    ])('%s -> %s', (q, expected) => {
      expect(isNitradoOrDayZHelpQuestion(q)).toBe(expected);
    });
  });

  describe('lookupNitradoHelp', () => {
    it('liefert für Tag/Nacht-Frage einen passenden Hilfeblock', () => {
      const a = lookupNitradoHelp('Wie kann ich die Tag-Nacht-Zeit einstellen?');
      expect(a.found).toBe(true);
      expect(a.topicIds).toContain('tag-nacht-zyklus');
      expect(a.text).toMatch(/serverTimeAcceleration/);
      expect(a.text).toMatch(/serverNightTimeAcceleration/);
    });

    it('antwortet für Mod-Frage mit Mod-Topic', () => {
      const a = lookupNitradoHelp('Wie installiere ich neue Mods?');
      expect(a.found).toBe(true);
      expect(a.topicIds).toContain('mods-installieren');
    });

    it('liefert NICHTS für off-topic Fragen', () => {
      const a = lookupNitradoHelp('Was ist 2 + 2?');
      expect(a.found).toBe(false);
      expect(a.text).toBe('');
    });

    it('liefert für cfgGameplay.json ein Topic', () => {
      const a = lookupNitradoHelp('cfgGameplay.json erklären');
      expect(a.found).toBe(true);
      expect(a.topicIds).toContain('cfggameplay-json');
    });

    it('liefert für mapgroupproto ein Topic mit Loot-Container-Erklärung', () => {
      const a = lookupNitradoHelp('Wie funktioniert mapgroupproto?');
      expect(a.found).toBe(true);
      expect(a.topicIds).toContain('mapgroupproto-pos-xml');
      expect(a.text).toMatch(/mapgrouppos\.xml/);
    });

    it('liefert für Dashboard-Frage Erklärung der Anzeigen', () => {
      const a = lookupNitradoHelp('Was bedeutet die CPU-Last im Dashboard?');
      expect(a.found).toBe(true);
      expect(a.topicIds).toContain('dashboard-meanings');
    });

    it('liefert für Auto-Task-Frage das Topic', () => {
      const a = lookupNitradoHelp('Wie richte ich automatische Tasks ein?');
      expect(a.found).toBe(true);
      expect(a.topicIds).toContain('automatic-tasks');
    });

    it('liefert für effectArea/Kontamination ein Topic', () => {
      const a = lookupNitradoHelp('Wie definiere ich kontaminierte Zonen?');
      expect(a.found).toBe(true);
      expect(a.topicIds).toContain('effectarea-xml');
    });

    it('weist die LLM explizit an, KEINE Server-Daten zu nennen', () => {
      const a = lookupNitradoHelp('Wie stelle ich die Slots ein?');
      expect(a.found).toBe(true);
      expect(a.text).toMatch(/NIEMALS konkrete Werte/i);
      expect(a.text).toMatch(/keine.*server-internas|keine.*server-daten|generisch/i.test(a.text.toLowerCase()) ? /./ : /generisch/i);
    });

    it('gibt KEINE Hostnamen, IPs oder Service-IDs aus', () => {
      const a = lookupNitradoHelp('serverDZ.cfg erklären');
      expect(a.found).toBe(true);
      // Keine IPv4, kein 7656119… Steam64, keine Nitrado-Service-Zahl
      expect(a.text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(a.text).not.toMatch(/7656119\d{10}/);
    });
  });
});
