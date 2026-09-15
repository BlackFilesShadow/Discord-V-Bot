process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const mockAnswerQuestion = jest.fn(async (..._args: unknown[]) => ({ success: true, result: 'Antwort.' }));
jest.mock('../../src/modules/ai/aiHandler', () => ({
  __esModule: true,
  answerQuestion: (...a: unknown[]) => mockAnswerQuestion(...a),
  analyzeSentiment: jest.fn(),
  detectToxicity: jest.fn(),
  translateText: jest.fn(),
}));

jest.mock('../../src/modules/ai/contextBuilder', () => ({
  __esModule: true,
  buildServerUserContext: jest.fn(async () => null),
}));

jest.mock('../../src/modules/ai/botIdentity', () => ({
  __esModule: true,
  isDeveloperIdentityQuestion: jest.fn(() => false),
  getDeveloperIdentityAnswer: jest.fn(() => ''),
}));

import aiCommand from '../../src/commands/user/ai';

// Regressionsschutz: answerQuestion() aktiviert den Per-User-AI-Rate-Limiter
// nur, wenn opts.userId gesetzt ist (aiHandler.ts: `if (opts.userId && ...)`).
// /ai ask rief answerQuestion() frueher ohne userId auf - der Mention-/
// Trigger-Pfad ist rate-limitiert, dieser Slash-Command-Pfad war es nicht.
describe('/ai ask uebergibt userId an answerQuestion (Rate-Limiter-Scope)', () => {
  it('setzt opts.userId auf die aufrufende Discord-ID', async () => {
    const interaction = {
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      options: {
        getSubcommand: () => 'ask',
        getString: () => 'Was ist die Hauptstadt von Frankreich?',
      },
      guild: null,
      guildId: null,
      channel: null,
      user: { id: 'user-42' },
    };

    await aiCommand.execute(interaction as never);

    expect(mockAnswerQuestion).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userId: 'user-42' }),
    );
  });
});
