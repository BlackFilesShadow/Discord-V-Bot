/**
 * Coverage fuer pure (state-/network-freie) Helfer in aiHandler.ts.
 *
 * Bewusst kein Mock von axios / prisma / providerStats — wir testen nur
 * die rein deterministischen String-Helfer. Damit bleibt der Test schnell,
 * stabil und liefert echte Coverage fuer die haeufig genutzten Pfade
 * (Self-Intro-Detection, Time-Context, Knowledge-Boundary, Persona-Konstante).
 */

// Pflicht-ENV fuer config.ts (gleicher Trick wie tests/commands/handler.test.ts).
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import {
  asksForSelfIntroduction,
  buildSelfIntroductionInstructions,
  getKnowledgeBoundary,
  getLiveTimeContext,
  BOT_PERSONA,
} from '../../src/modules/ai/aiHandler';

describe('aiHandler – pure helpers', () => {
  describe('asksForSelfIntroduction', () => {
    it.each([
      'Wer bist du?',
      'wer bist du eigentlich',
      'Was bist du?',
      'Stell dich vor',
      'stelle dich kurz vor',
      'Stell dich mal kurz vor bitte',
      'Magst du dich vorstellen?',
      'Was kannst du?',
      'was machst du hier',
      'Was bringst du mir?',
      'Wozu bist du da?',
      'wozu bist du gut',
      'Was für ein Bot bist du?',
      'Was fuer ein Bot ist das?',
      'Erzaehl mir deine Faehigkeiten',
      'Was sind deine Funktionen?',
      'Erkläre deine Möglichkeiten',
    ])('matched Self-Intro: %s', (q) => {
      expect(asksForSelfIntroduction(q)).toBe(true);
    });

    it.each([
      'Wie spät ist es?',
      'Was kostet ein Brot?',
      'Wer ist der Bundeskanzler?',
      'erkläre mir XP-System',
      'Wie geht es dir?',
      'Hi',
      'Was ist 2+2?',
      // bewusst tricky – darf NICHT matchen:
      'Wer ist der beste Spieler?',
      'Was bedeutet RAG?',
    ])('matched NICHT Self-Intro: %s', (q) => {
      expect(asksForSelfIntroduction(q)).toBe(false);
    });
  });

  describe('buildSelfIntroductionInstructions', () => {
    it('liefert nicht-leeren Markdown-Block mit allen Pflicht-Sektionen', () => {
      const out = buildSelfIntroductionInstructions();
      expect(out.length).toBeGreaterThan(200);
      // Pflicht-Strukturpunkte
      expect(out).toMatch(/Identitaet/);
      expect(out).toMatch(/Kernfaehigkeiten/);
      expect(out).toMatch(/Slash-Commands/);
      // darf KEINE Admin-/Dev-Commands erwaehnen
      expect(out).not.toMatch(/\/dev-/);
      expect(out).not.toMatch(/\/admin-/);
    });

    it('ist deterministisch (gleicher Input -> gleicher Output)', () => {
      expect(buildSelfIntroductionInstructions()).toBe(buildSelfIntroductionInstructions());
    });
  });

  describe('getKnowledgeBoundary', () => {
    it('enthaelt aktuelles Jahr und Quellen-Prioritaet', () => {
      const out = getKnowledgeBoundary();
      const year = new Date().getFullYear();
      expect(out).toMatch(new RegExp(String(year)));
      expect(out).toMatch(/PRIORITAET/i);
    });
  });

  describe('getLiveTimeContext', () => {
    let out: string;
    beforeAll(() => { out = getLiveTimeContext(); });

    it('enthaelt Datum, Uhrzeit, Wochentag, Jahr', () => {
      expect(out).toMatch(/Heutiges Datum/);
      expect(out).toMatch(/Aktuelle Uhrzeit/);
      expect(out).toMatch(/Wochentag/);
      expect(out).toMatch(new RegExp(String(new Date().getFullYear())));
    });

    it('enthaelt einen plausiblen Tageszeit-Wert', () => {
      expect(out).toMatch(/Tageszeit:\s+(Morgen|Mittag|Nachmittag|Abend|Nacht)/);
    });

    it('enthaelt eine plausible Jahreszeit', () => {
      expect(out).toMatch(/Jahreszeit:\s+(Fr\u00fchling|Sommer|Herbst|Winter)/);
    });

    it('enthaelt explizite Anti-Halluzinations-Regeln', () => {
      expect(out).toMatch(/NIEMALS/);
      expect(out).toMatch(/HOECHSTENS EINMAL/);
    });
  });

  describe('BOT_PERSONA', () => {
    it('ist ein nicht-leerer String mit Identitaets-Header', () => {
      expect(typeof BOT_PERSONA).toBe('string');
      expect(BOT_PERSONA.length).toBeGreaterThan(200);
      expect(BOT_PERSONA).toMatch(/V-Bot Prime/);
    });

    it('enthaelt Adaptive-Laenge-Regeln', () => {
      expect(BOT_PERSONA).toMatch(/KURZ/);
      expect(BOT_PERSONA).toMatch(/MITTEL/);
      expect(BOT_PERSONA).toMatch(/LANG/);
    });

    it('enthaelt Anti-Floskel-Regeln und Persona-Kerncharakter', () => {
      expect(BOT_PERSONA).toMatch(/KERNCHARAKTER/);
      expect(BOT_PERSONA).toMatch(/Marketing/);
    });
  });
});
