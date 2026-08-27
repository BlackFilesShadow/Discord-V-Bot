import {
  answerLiveTimeQuestion,
  answerLocalBotStatusQuestion,
} from '../../src/modules/ai/liveTime';

describe('provider-unabhaengiger Bot-Status-Fast-Path', () => {
  test.each([
    'Status?',
    'Bot Status',
    'V Bot Status?',
    'VBot Status',
    'System-Status?',
    'Wie läufts?',
    'Wie läuft der Bot?',
    'Bist du online?',
  ])('beantwortet "%s" lokal', (question) => {
    const answer = answerLocalBotStatusQuestion(question, 3_661);

    expect(answer).toContain('V-Bot ist online');
    expect(answer).toContain('1h 1m');
    expect(answer).toContain('keinen externen KI-Provider');
  });

  it('liegt im bereits vor Provider-Routing aufgerufenen Live-Preflight', () => {
    const answer = answerLiveTimeQuestion('Status?');

    expect(answer).toContain('V-Bot ist online');
    expect(answer).toContain('lokal');
  });

  test.each([
    'Server Status?',
    'Status vom Server?',
    'Wie läuft der DayZ Server?',
    'Spieler Status?',
  ])('kapert server-/domainbezogene Statusfrage nicht: "%s"', (question) => {
    expect(answerLocalBotStatusQuestion(question, 100)).toBeNull();
  });

  it('laesst bestehende Zeitfragen unveraendert durch den gleichen Preflight laufen', () => {
    const fixedNow = new Date('2026-08-27T20:00:00Z');
    const answer = answerLiveTimeQuestion('Welches Jahr haben wir?', fixedNow);

    expect(answer).toBe('Wir haben **2026**.');
  });
});
