jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findMany: jest.fn() },
    gameplayFeedConfig: { updateMany: jest.fn() },
    nitradoAdmProfileConfig: { updateMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
    admSourceCursor: { findFirst: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
    admEvent: { findFirst: jest.fn(), createMany: jest.fn() },
    gameIdentityLinkChallenge: { findFirst: jest.fn() },
  },
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '12345678901234567890123456789012' } },
}));

jest.mock('../../src/utils/security', () => ({
  decrypt: jest.fn(() => 'token'),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../src/modules/nitrado/adm/profileResolver', () => ({
  resolveAdmProfile: jest.fn(),
  recordAdmSourceError: jest.fn(),
}));

import prisma from '../../src/database/prisma';
import { runAdmLiveSyncOnce } from '../../src/modules/nitrado/adm/admLiveSyncCron';

const findConnections = prisma.nitradoConnection.findMany as jest.Mock;

describe('ADM V2 single-source discovery', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fragt alle aktiven gebundenen Nitrado-Connections ab statt nur Feed-Configs', async () => {
    findConnections.mockResolvedValue([]);

    await runAdmLiveSyncOnce();

    expect(findConnections).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', nitradoServerId: { not: null } },
      select: { id: true, guildId: true, encryptedToken: true, nitradoServerId: true },
    });
  });
});
