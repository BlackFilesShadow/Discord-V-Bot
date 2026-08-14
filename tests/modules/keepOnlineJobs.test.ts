import { cancelPendingKeepOnlineJobs } from '../../src/modules/nitrado/keepOnlineJobs';

describe('KEEP — pending Auto-Start-Cancellation', () => {
  it('markiert nur wartende RESTART_IF_DOWN-Jobs des exakten Guild+Slot-Scopes als DEAD', async () => {
    const updateMany = jest.fn(async () => ({ count: 2 }));
    const now = new Date('2026-08-14T06:00:00.000Z');

    const count = await cancelPendingKeepOnlineJobs(
      { nitradoJob: { updateMany } },
      { guildId: 'guild-1', nitradoConnId: 'conn-1' },
      now,
    );

    expect(count).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        guildId: 'guild-1',
        nitradoConnId: 'conn-1',
        operation: 'RESTART_IF_DOWN',
        status: 'PENDING',
      },
      data: {
        status: 'DEAD',
        lastError: 'Keep-Online deaktiviert; geplanter Auto-Start verworfen.',
        updatedAt: now,
      },
    });
  });
});
