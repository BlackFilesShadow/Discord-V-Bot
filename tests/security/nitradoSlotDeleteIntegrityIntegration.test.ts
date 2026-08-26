process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import prisma from '../../src/database/prisma';
import { runDatabaseConsistencyScan } from '../../src/database/consistencyScanner';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';
import { describeDb } from '../helpers/dbIntegration';

const guildId = asGuildId('923456789012345678');
const actorId = asUserDiscordId('923456789012345679');
const oldConnId = asNitradoConnId('c333333333333333333333333');
const replacementConnId = asNitradoConnId('c444444444444444444444444');

async function cleanup(): Promise<void> {
  await prisma.economyScopeMigration.deleteMany({ where: { guildId } });
  await prisma.rewardProcessingCursor.deleteMany({ where: { guildId } });
  await prisma.nitradoAdmProfileConfig.deleteMany({ where: { guildId } });
  await prisma.nitradoConnection.deleteMany({ where: { guildId } });
}

describeDb('Nitrado slot delete/recreate integrity', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('deletes dynamically discovered gameserver rows and resolved economy binding before slot recreation', async () => {
    await prisma.nitradoConnection.create({
      data: {
        id: oldConnId,
        guildId,
        slot: 1,
        alias: 'Old Server',
        alias5: 'DEL01',
        encryptedToken: 'integration-token-old',
        nitradoServerId: '90000001',
        status: 'ACTIVE',
        addedByDiscordId: actorId,
      },
    });

    await prisma.economyScopeMigration.create({
      data: {
        guildId,
        status: 'RESOLVED',
        primaryNitradoConnId: oldConnId,
        detectedActiveServerCount: 1,
        resolvedByDiscordId: actorId,
        resolvedAt: new Date('2026-08-26T20:00:00.000Z'),
      },
    });

    await prisma.rewardProcessingCursor.createMany({
      data: [
        {
          guildId,
          nitradoConnId: oldConnId,
          stream: 'pvp:pvp:default',
          lastTimestamp: new Date('1970-01-01T00:00:00.000Z'),
          lastEntityId: '',
        },
        {
          guildId,
          nitradoConnId: oldConnId,
          stream: 'playtime:closed',
          lastTimestamp: new Date('1970-01-01T00:00:00.000Z'),
          lastEntityId: '',
        },
      ],
    });

    await prisma.nitradoAdmProfileConfig.create({
      data: {
        guildId,
        nitradoConnId: oldConnId,
        profileDir: '/games/test/noftp/dayzps/config',
        source: 'AUTO',
      },
    });

    await prisma.nitradoConnection.delete({ where: { id: oldConnId } });

    await expect(prisma.rewardProcessingCursor.count({ where: { guildId, nitradoConnId: oldConnId } }))
      .resolves.toBe(0);
    await expect(prisma.nitradoAdmProfileConfig.count({ where: { guildId, nitradoConnId: oldConnId } }))
      .resolves.toBe(0);
    await expect(prisma.economyScopeMigration.count({ where: { guildId } }))
      .resolves.toBe(0);

    await prisma.nitradoConnection.create({
      data: {
        id: replacementConnId,
        guildId,
        slot: 1,
        alias: 'Replacement Server',
        alias5: 'DEL02',
        encryptedToken: 'integration-token-new',
        nitradoServerId: '90000002',
        status: 'ACTIVE',
        addedByDiscordId: actorId,
      },
    });

    const report = await runDatabaseConsistencyScan();
    const ownFindings = report.findings.filter((finding) =>
      finding.relation.includes('RewardProcessingCursor')
      || finding.relation.includes('NitradoAdmProfileConfig')
      || finding.relation.includes('EconomyScopeMigration'),
    );
    expect(ownFindings).toEqual([]);
  });
});
