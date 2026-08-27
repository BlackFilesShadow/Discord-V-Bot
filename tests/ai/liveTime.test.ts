import {
  answerLiveTimeQuestion,
  buildLiveTimeContext,
  getBerlinLiveTimeSnapshot,
} from '../../src/modules/ai/liveTime';

describe('provider-unabhaengige Live-Zeit', () => {
  it('beantwortet exakt die Screenshot-Frage ohne Provider', () => {
    const now = new Date('2026-08-27T08:54:00.000Z'); // 10:54 Europe/Berlin
    expect(answerLiveTimeQuestion('was für ein Jahr haben wir heute?', now)).toBe('Wir haben **2026**.');
  });

  it('verwendet Europe/Berlin auch an der UTC-Jahresgrenze', () => {
    const now = new Date('2026-12-31T23:30:00.000Z'); // 00:30 am 01.01.2027 in Berlin
    const snapshot = getBerlinLiveTimeSnapshot(now);
    expect(snapshot.year).toBe(2027);
    expect(snapshot.monthNumber).toBe(1);
    expect(snapshot.season).toBe('Winter');
    expect(buildLiveTimeContext(now)).toContain('- Jahr: 2027');
  });

  it('beantwortet Datum, Wochentag, Uhrzeit, Monat und Jahreszeit deterministisch', () => {
    const now = new Date('2026-08-27T08:54:00.000Z');
    expect(answerLiveTimeQuestion('Welches Datum haben wir?', now)).toContain('27. August 2026');
    expect(answerLiveTimeQuestion('Welcher Wochentag ist heute?', now)).toContain('Donnerstag');
    expect(answerLiveTimeQuestion('Wie spät ist es?', now)).toContain('10:54 Uhr');
    expect(answerLiveTimeQuestion('Welchen Monat haben wir?', now)).toContain('August');
    expect(answerLiveTimeQuestion('Welche Jahreszeit haben wir?', now)).toContain('Sommer');
  });

  it('kapert keine normale Wissensfrage', () => {
    expect(answerLiveTimeQuestion('Wie funktioniert die DayZ Central Economy?', new Date())).toBeNull();
    expect(answerLiveTimeQuestion('Wer ist Bundeskanzler?', new Date())).toBeNull();
  });
});
