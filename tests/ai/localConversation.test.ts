import { answerLocalConversationTurn } from '../../src/modules/ai/localConversation';

describe('provider-unabhaengige Gespraechsoeffner', () => {
  it.each(['hey', 'Hallo!', 'Moin', 'Na du?'])(
    'beantwortet die reine Begruessung %s lokal',
    (question) => {
      expect(answerLocalConversationTurn(question)).toBe('Hey! Was kann ich für dich tun?');
    },
  );

  it.each(['ich hab ne frage', 'Ich habe eine Frage.', 'Kann ich dich was fragen?'])(
    'fordert beim reinen Frage-Oeffner %s lokal zur eigentlichen Frage auf',
    (question) => {
      expect(answerLocalConversationTurn(question)).toBe('Klar – stell deine Frage einfach.');
    },
  );

  it.each([
    'Hey, wie funktioniert die Whitelist?',
    'Ich habe eine Frage zu DayZ.',
    'Kann ich dich fragen, wie spaet es ist?',
  ])('laesst die inhaltliche Nachricht %s beim normalen Antwortpfad', (question) => {
    expect(answerLocalConversationTurn(question)).toBeNull();
  });
});
