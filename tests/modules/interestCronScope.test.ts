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

jest.mock('../../src/modules/economy/interestRate', () => ({
  getInterestBasisPoints: jest.fn(),
}));

jest.mock('../../src/modules/economy/virtualAccountInterest', () => ({
  runDailyTreasuryInterestForServer: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn() },
  logAudit: jest.fn(),
}));

import prisma from '../../src/database/prisma';
import { runDailyInterestForServer } from '../../src/modules/economy/bankInterest';
import { getInterestBasisPoints } from '../../src/modules/economy/interestRate';
import { runDailyTreasuryInterestForServer } from '../../src/modules/economy/virtualAccountInterest';
import { logAudit } from '../../src/utils/logger';
import { runInterestSweepOnce } from '../../src/modules/economy/interestCron';

const findMany = prisma.economyConfig.findMany as jest.Mock;
const getBasisPoints = getInterestBasisPoints as jest.Mock;
const runInterest = runDailyInterestForServer as jest.Mock;
const runTreasuryInterest = runDailyTreasuryInterestForServer as jest.Mock;
const audit = logAudit as jest.Mock;

describe('interestCron gameserver scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runInterest.mockResolvedValue({ credited: 0, total: 0n, skipped: false });
    runTreasuryInterest.mockResolvedValue({ credited: 0, total: 0n });
  });

  it('fragt nur aktive servergescopte Configs ab und reicht denselben exakten Satz an Spielerbank und Serverbank weiter', async () => {
    findMany.mockResolvedValue([{ guildId: 'g1', nitradoConnId: 'n1' }]);
    getBasisPoints.mockResolvedValue(250);
    runInterest.mockResolvedValue({ credited: 1, total: 25n, skipped: false });
    runTreasuryInterest.mockResolvedValue({ credited: 1, total: 50n });

    await runInterestSweepOnce(new Date('2026-08-14T10:00:00.000Z'));

    expect(findMany).toHaveBeenCalledWith({
      where: {
        enabled: true,
        nitradoConnId: { not: null },
      },
      select: { guildId: true, nitradoConnId: true },
    });
    expect(getBasisPoints).toHaveBeenCalledWith('g1', 'n1');
    expect(runInterest).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        guildId: 'g1',
        nitradoConnId: 'n1',
        basisPoints: 250,
        runDate: '2026-08-14',
      }),
    );
    expect(runTreasuryInterest).toHaveBeenCalledWith(expect.objectContaining({
      guildId: 'g1', nitradoConnId: 'n1', basisPoints: 250, runDate: '2026-08-14',
    }));
    expect(audit).toHaveBeenCalledWith(
      'BANK_INTEREST_RUN',
      'ECONOMY',
      expect.objectContaining({ guildId: 'g1', nitradoConnId: 'n1', basisPoints: 250 }),
    );
  });

  it('ueberspringt 0 Prozent ohne Bankkonten anzufassen', async () => {
    findMany.mockResolvedValue([{ guildId: 'g1', nitradoConnId: 'n1' }]);
    getBasisPoints.mockResolvedValue(0);

    await runInterestSweepOnce(new Date('2026-08-14T10:00:00.000Z'));

    expect(runInterest).not.toHaveBeenCalled();
    expect(runTreasuryInterest).not.toHaveBeenCalled();
  });

  it('fuehrt defensive NULL-Zeilen nicht aus, falls ein Mock/DB-Treiber den Filter verletzt', async () => {
    findMany.mockResolvedValue([{ guildId: 'legacy-guild', nitradoConnId: null }]);

    await runInterestSweepOnce(new Date('2026-08-14T10:00:00.000Z'));

    expect(getBasisPoints).not.toHaveBeenCalled();
    expect(runInterest).not.toHaveBeenCalled();
    expect(runTreasuryInterest).not.toHaveBeenCalled();
  });
});