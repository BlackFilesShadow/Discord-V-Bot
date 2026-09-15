process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const mockLogAudit = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: mockLogger,
  logAudit: mockLogAudit,
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { autoModFilter: { findMany: jest.fn(async () => []) } },
}));

jest.mock('../../src/utils/rateLimiter', () => ({
  __esModule: true,
  detectSpam: jest.fn(() => false),
}));

const mockAnswerQuestion = jest.fn();
jest.mock('../../src/modules/ai/aiHandler', () => ({
  __esModule: true,
  answerQuestion: (...a: unknown[]) => mockAnswerQuestion(...a),
}));

jest.mock('../../src/modules/ai/contextBuilder', () => ({
  __esModule: true,
  buildServerUserContext: jest.fn(async () => null),
}));

jest.mock('../../src/modules/ai/triggers', () => ({
  __esModule: true,
  listTriggers: jest.fn(async () => []),
  findMatchingTrigger: jest.fn(),
  isOnCooldown: jest.fn(),
  renderTemplate: jest.fn(),
}));

import messageCreateEvent from '../../src/events/messageCreate';

let messageIdCounter = 0;

function makeMessage(replyImpl: () => Promise<unknown>, sendImpl: (opts: { content: string }) => Promise<unknown>) {
  const send = jest.fn(sendImpl);
  const channel = {
    send,
    sendTyping: jest.fn().mockResolvedValue(undefined),
    messages: { fetch: jest.fn(async () => new Map()) },
  };
  const reply = jest.fn(replyImpl);
  messageIdCounter += 1;
  const msg = {
    // Der Handler dedupliziert Nachrichten anhand von msg.id ueber die
    // gesamte Modul-Lebensdauer (Gateway-Replay-Schutz) - jeder Testfall
    // braucht deshalb eine eigene ID, sonst wird er als Duplikat verworfen.
    id: `msg-${messageIdCounter}`,
    createdTimestamp: Date.now(),
    author: { id: 'user-1', bot: false, username: 'Tester' },
    guild: { id: 'guild-1' },
    guildId: 'guild-1',
    member: undefined,
    channelId: 'chan-1',
    channel,
    content: '<@bot-1> Was ist die Hauptstadt von Frankreich?',
    mentions: { users: { has: (id: string) => id === 'bot-1' }, everyone: false },
    reference: undefined,
    client: { user: { id: 'bot-1' } },
    reply,
  };
  return { msg, reply, send, channel };
}

describe('messageCreate AI-Mention-Responder: Sende-Fallback (Regressionsschutz)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAnswerQuestion.mockResolvedValue({ success: true, result: 'Testantwort vom Modell.' });
  });

  it('faellt auf channel.send() zurueck, wenn msg.reply() fehlschlaegt, und liefert die Antwort trotzdem aus', async () => {
    const { msg, reply, send } = makeMessage(
      () => Promise.reject(new Error('Unknown Message')),
      async () => ({}),
    );

    await messageCreateEvent.execute(msg as never);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const sentContent = (send.mock.calls[0][0] as { content: string }).content;
    expect(sentContent).toContain('<@user-1>');
    expect(sentContent).toContain('Testantwort vom Modell.');
    expect(mockLogAudit).toHaveBeenCalledWith('AI_MENTION_RESPONSE', 'AI', expect.objectContaining({
      userId: 'user-1',
      channelId: 'chan-1',
    }));
  });

  it('loggt einen Fehler statt die Antwort spurlos zu verlieren, wenn auch der Fallback fehlschlaegt', async () => {
    const { msg, reply, send } = makeMessage(
      () => Promise.reject(new Error('Missing Access')),
      () => Promise.reject(new Error('Missing Access')),
    );

    await messageCreateEvent.execute(msg as never);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).not.toHaveBeenCalledWith('AI_MENTION_RESPONSE', 'AI', expect.anything());
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Antwort verloren'),
      expect.any(Error),
    );
  });

  it('nutzt weiterhin ausschliesslich msg.reply(), wenn der Versand direkt klappt', async () => {
    const { msg, reply, send } = makeMessage(
      async () => ({}),
      async () => ({}),
    );

    await messageCreateEvent.execute(msg as never);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith('AI_MENTION_RESPONSE', 'AI', expect.objectContaining({ userId: 'user-1' }));
  });
});
