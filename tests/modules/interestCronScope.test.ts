jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    economyConfig: { findMany: jest.fn() },
  },
}));

jest.mock('../../src/modules/economy/bankInterest', () => ({
  interestDateKey: jest.fn(() => '2026-08-14'),
  runDailyInterestForServer: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn() },
  logAudit: jest.fn(),
}));

import prisma from '../../src/database/prisma';
import { runDailyInterestForServer } from '../../src/modules/economy/bankInterest';
import { logger, logAudit } from '../../src/utils/logger';
import { runInterestSweepOnce } from '../../src/modules/economy/interestCron';

const findMany = prisma.economyConfig.findMany as jest.Mock;
const runInterest = runDailyInterestForServer as jest.Mock;
const warn = logger.warn as jest.Mock;
const audit = logAudit as jest.Mock;

describe('interestCron gameserver scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reicht Guild und nitradoConnId gemeinsam an den Tageslauf weiter', async () => {
    findMany.mockResolvedValue([
      { guildId: 'g1', nitradoConnId: 'n1', bankInterestPercent: 5 },
    ]);
    runInterest.mockResolvedValue({ credited: 1, total: 50n, skipped: false });

    await runInterestSweepOnce(new Date('2026-08-14T10:00:00.000Z'));

    expect(runInterest).toHaveBeenCalledTimes(1);
    expect(runInterest).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        guildId: 'g1',
        nitradoConnId: 'n1',
        percent: 5,
        runDate: '2026-08-14',
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      'BANK_INTEREST_RUN',
      'ECONOMY',
      expect.objectContaining({ guildId: 'g1', nitradoConnId: 'n1' }),
    );
  });

  it('ueberspringt Legacy-Configs ohne Gameserver-Scope fail-closed', async () => {
    findMany.mockResolvedValue([
      { guildId: 'legacy-guild', nitradoConnId: null, bankInterestPercent: 5 },
    ]);

    await runInterestSweepOnce(new Date('2026-08-14T10:00:00.000Z'));

    expect(runInterest).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ohne Gameserver-Scope'));
  });
});
