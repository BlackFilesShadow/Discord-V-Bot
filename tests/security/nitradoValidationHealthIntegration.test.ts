process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import prisma from '../../src/database/prisma';
import {
  recordValidationFailure,
  resetValidationHealth,
} from '../../src/modules/nitrado/validationHealth';
import { asGuildId, asNitradoConnId } from '../../src/types/scope';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const guildId = asGuildId('923456789012345678');
const connId = asNitradoConnId('c923456789012345678901234');

describeDb('NIT-001 PostgreSQL integration', () => {
  beforeEach(async () => {
    await prisma.nitradoValidationHealth.deleteMany({
      where: { guildId, nitradoConnId: connId },
    });
  });

  afterAll(async () => {
    await prisma.nitradoValidationHealth.deleteMany({
      where: { guildId, nitradoConnId: connId },
    });
  });

  it('inkrementiert parallel atomar und vergibt genau einen Alert-Claim pro Streak', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => recordValidationFailure(
        guildId,
        connId,
        new Error(`provider timeout token=super-secret attempt=${i}`),
        new Date(`2026-08-14T09:00:0${i}Z`),
      )),
    );

    expect(results.map(r => r.failureCount).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(results.filter(r => r.shouldAlert)).toHaveLength(1);

    const stored = await prisma.nitradoValidationHealth.findUnique({
      where: { guildId_nitradoConnId: { guildId, nitradoConnId: connId } },
    });
    expect(stored).not.toBeNull();
    expect(stored?.failureCount).toBe(4);
    expect(stored?.lastAlertAt).not.toBeNull();
    expect(stored?.lastErrorMessage).toContain('[REDACTED]');
    expect(stored?.lastErrorMessage).not.toContain('super-secret');

    await resetValidationHealth(guildId, connId);
    const reset = await prisma.nitradoValidationHealth.findUnique({
      where: { guildId_nitradoConnId: { guildId, nitradoConnId: connId } },
    });
    expect(reset).toMatchObject({
      failureCount: 0,
      lastErrorMessage: null,
      lastFailureAt: null,
      lastAlertAt: null,
    });
  });
});
