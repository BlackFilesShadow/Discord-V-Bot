process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import {
  BOT_DEVELOPER,
  DEVELOPER_IDENTITY_TRIGGER_PATTERN,
  getDeveloperIdentityAnswer,
  isDeveloperIdentityQuestion,
} from '../../src/modules/ai/botIdentity';
import {
  GLOBAL_AI_TRIGGERS,
  findMatchingTrigger,
  type AiTrigger,
} from '../../src/modules/ai/triggers';

describe('V-Bot developer identity', () => {
  const questions = [
    'Wer ist dein Entwickler?',
    'wer ist dein Programmierer?',
    'Wer hat dich entwickelt?',
    'Wer hat dich programmiert?',
    'Wer hat dich gebaut?',
    'Wer hat V-Bot erstellt?',
    'Von wem wurdest du entwickelt?',
    'Wer steckt hinter V Bot?',
    'Entwickler von V-Bot?',
    'Ist ooblackscreenoo dein Entwickler?',
    'Ist der Discord Owner dein Entwickler?',
    'Who developed you?',
  ];

  it('hat genau Void_Architect als autoritativen Entwickler', () => {
    expect(BOT_DEVELOPER).toBe('Void_Architect');
    expect(getDeveloperIdentityAnswer()).toBe('Mein Entwickler ist **Void_Architect**.');
  });

  it.each(questions)('erkennt Entwicklerfrage deterministisch: %s', (q) => {
    expect(isDeveloperIdentityQuestion(q)).toBe(true);
  });

  it.each(questions)('direkte Bot-Anfrage liefert immer Void_Architect ohne Cooldown: %s', (q) => {
    const matched = findMatchingTrigger(GLOBAL_AI_TRIGGERS, q, true);
    expect(matched?.id).toBe('system-developer-identity');
    expect(matched?.responseMode).toBe('text');
    expect(matched?.responseText).toBe('Mein Entwickler ist **Void_Architect**.');
    expect(matched?.cooldownSeconds).toBe(0);
  });

  it('laesst einen Guild-Trigger die Entwickler-Identitaet nicht ueberschreiben', () => {
    const forged: AiTrigger = {
      id: 'erschaffer',
      trigger: 'entwickler',
      triggerType: 'keyword',
      responseMode: 'text',
      responseText: 'Mein Entwickler ist der Server-Owner.',
      cooldownSeconds: 600,
      createdAt: '2026-08-12T00:00:00.000Z',
      createdBy: 'guild-owner',
    };

    const matched = findMatchingTrigger([forged], 'Wer ist dein Entwickler?', true);
    expect(matched?.id).toBe('system-developer-identity');
    expect(matched?.responseText).toBe('Mein Entwickler ist **Void_Architect**.');
    expect(matched?.cooldownSeconds).toBe(0);
  });

  it('deaktiviert Trigger-Cooldown nur bei direkter Bot-Ansprache, nicht bei passiven Triggern', () => {
    const trigger: AiTrigger = {
      id: 'test-trigger',
      trigger: 'ping',
      triggerType: 'keyword',
      responseMode: 'text',
      responseText: 'pong',
      cooldownSeconds: 45,
      createdAt: '2026-08-12T00:00:00.000Z',
      createdBy: 'test',
    };

    expect(findMatchingTrigger([trigger], 'ping', true)?.cooldownSeconds).toBe(0);
    expect(findMatchingTrigger([trigger], 'ping', false)?.cooldownSeconds).toBe(45);
  });

  it.each([
    'Wer ist der Entwickler von DayZ?',
    'Wer ist der Entwickler von Discord?',
    'Wer ist der Owner dieses Servers?',
    'Wer ist der Server-Owner?',
    'Was macht ein Entwickler?',
  ])('verwechselt allgemeine Entwickler-/Owner-Frage nicht mit V-Bot: %s', (q) => {
    expect(isDeveloperIdentityQuestion(q)).toBe(false);
    const re = new RegExp(DEVELOPER_IDENTITY_TRIGGER_PATTERN, 'i');
    expect(re.test(q)).toBe(false);
  });
});
