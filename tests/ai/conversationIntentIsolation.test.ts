import {
  classifyAiConversationDomain,
  filterCompatibleMemoryTurns,
  isMemoryTurnCompatible,
  mayUseExternalConversationContext,
} from '../../src/modules/ai/conversationIntent';

describe('AI conversation-domain isolation', () => {
  test.each([
    'Mit was fühlst du dich mal nicht angesprochen?',
    'status?',
    'weißt du wie ich einen guten Kuchen backen kann?',
    'na alles fit? 😁',
    'Was ist Photosynthese?',
    'Erzähl mir einen Witz.',
  ])('normale Frage bleibt general und bekommt keinen Server-/DayZ-Kontext: %s', (question) => {
    expect(classifyAiConversationDomain(question)).toBe('general');
    expect(mayUseExternalConversationContext(question)).toBe(false);
  });

  test.each([
    'Wie ändere ich den Loot in DayZ?',
    'Was macht events.xml?',
    'Wie ist unser nominal eingestellt?',
    'Nitrado Server Status',
    'Welche lifetime hat das Item in types.xml?',
  ])('DayZ-/Nitrado-Frage wird eindeutig als dayz klassifiziert: %s', (question) => {
    expect(classifyAiConversationDomain(question)).toBe('dayz');
    expect(mayUseExternalConversationContext(question)).toBe(true);
  });

  test('Discord-Server-Kontext bleibt separat von DayZ', () => {
    expect(classifyAiConversationDomain('Welche Regeln hat unser Discord-Server?')).toBe('discord_server');
    expect(classifyAiConversationDomain('Wie viele Mitglieder hat der Discord-Server?')).toBe('discord_server');
  });

  test('User-Profil bleibt separat von Server- und DayZ-Kontext', () => {
    expect(classifyAiConversationDomain('Was ist mein Level?')).toBe('user_profile');
    expect(classifyAiConversationDomain('Wann bin ich diesem Server beigetreten?')).toBe('user_profile');
  });

  test('eine alte DayZ-Antwort darf keine normale Frage beeinflussen', () => {
    const question = 'Mit was fühlst du dich mal nicht angesprochen?';
    expect(isMemoryTurnCompatible(question, 'In events.xml steht nominal=3.')).toBe(false);
    expect(isMemoryTurnCompatible(question, 'Ich würde mich nicht von jedem Nebensatz angesprochen fühlen.')).toBe(true);
  });

  test('DayZ-Memory bleibt innerhalb der DayZ-Domain', () => {
    const question = 'Wie ändere ich den Loot in DayZ?';
    expect(isMemoryTurnCompatible(question, 'In types.xml steuerst du nominal und lifetime.')).toBe(true);
    expect(isMemoryTurnCompatible(question, 'Der Bundeskanzler ist ...')).toBe(false);
  });

  test('Assistentenantworten erben die Domain der auslösenden Nutzerfrage', () => {
    const turns = [
      { role: 'user' as const, content: 'Was bedeutet nominal in DayZ?' },
      { role: 'assistant' as const, content: 'Das ist der angestrebte Zielbestand.' },
      { role: 'user' as const, content: 'Kann man einen guten Kuchen backen?' },
      { role: 'assistant' as const, content: 'Ja. DayZ wäre dafür allerdings kein gutes Beispiel.' },
    ];

    expect(filterCompatibleMemoryTurns('Na, alles fit?', turns)).toEqual(turns.slice(2));
    expect(filterCompatibleMemoryTurns('Wie ändere ich nominal in DayZ?', turns)).toEqual(turns.slice(0, 2));
  });
});
