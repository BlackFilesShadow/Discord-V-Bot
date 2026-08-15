const findUniqueMock = jest.fn();
const upsertMock = jest.fn();
const loggerErrorMock = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    botConfig: {
      findUnique: findUniqueMock,
      upsert: upsertMock,
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    error: loggerErrorMock,
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

import { addTrigger, type AiTrigger } from '../../src/modules/ai/triggers';

const trigger: AiTrigger = {
  id: 'persist-failure',
  trigger: 'persist test',
  triggerType: 'keyword',
  responseMode: 'text',
  responseText: 'ok',
  cooldownSeconds: 10,
  createdAt: '2026-08-15T00:00:00.000Z',
  createdBy: '223456789012345678',
};

describe('AI trigger persistence contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
  });

  it('returns ok=false instead of leaking a database exception to media callers', async () => {
    upsertMock.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(addTrigger('123456789012345678', trigger)).resolves.toEqual({
      ok: false,
      message: 'Trigger konnte wegen eines Persistenzfehlers nicht gespeichert werden.',
    });

    expect(loggerErrorMock).toHaveBeenCalledWith(
      'AI-Trigger konnte nicht gespeichert werden.',
      expect.objectContaining({
        guildId: '123456789012345678',
        triggerId: 'persist-failure',
        error: 'database unavailable',
      }),
    );
  });
});
