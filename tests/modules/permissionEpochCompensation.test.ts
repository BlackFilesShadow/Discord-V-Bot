const directFindUnique = jest.fn();
const directDeleteMany = jest.fn();
const transaction = jest.fn();

const tx = {
  guildPermissionGrant: {
    findUnique: (...args: unknown[]) => directFindUnique(...args),
    deleteMany: (...args: unknown[]) => directDeleteMany(...args),
  },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: (...args: unknown[]) => transaction(...args),
    guildPermissionGrant: { findUnique: jest.fn(), findMany: jest.fn() },
    guildPermissionRoleGrant: { findMany: jest.fn() },
  },
}));

import { asGuildId, asUserDiscordId } from '../../src/types/scope';
import { membershipEpochMarker } from '../../src/modules/permissions/access';
import { deleteGrantForMembershipEpoch } from '../../src/modules/permissions/repository';

const GUILD_ID = asGuildId('123456789012345678');
const USER_ID = asUserDiscordId('111111111111111111');
const EPOCH_A = new Date('2026-08-20T00:00:00.000Z');
const EPOCH_B = new Date('2026-08-20T00:05:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  directDeleteMany.mockResolvedValue({ count: 1 });
  transaction.mockImplementation(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
});

describe('permission membership epoch compensation', () => {
  test('removes exactly the stale generation written by the old request', async () => {
    directFindUnique.mockResolvedValue({
      permissions: [membershipEpochMarker(EPOCH_A), 'economy.view'],
    });

    await expect(deleteGrantForMembershipEpoch(GUILD_ID, USER_ID, EPOCH_A)).resolves.toBe(true);
    expect(directDeleteMany).toHaveBeenCalledWith({
      where: { guildId: GUILD_ID, userDiscordId: USER_ID },
    });
  });

  test('never deletes a newer membership generation that won the ABA race', async () => {
    directFindUnique.mockResolvedValue({
      permissions: [membershipEpochMarker(EPOCH_B), 'whitelist.view'],
    });

    await expect(deleteGrantForMembershipEpoch(GUILD_ID, USER_ID, EPOCH_A)).resolves.toBe(false);
    expect(directDeleteMany).not.toHaveBeenCalled();
  });

  test('legacy or malformed rows are not guessed as the target generation', async () => {
    directFindUnique.mockResolvedValue({ permissions: ['economy.view'] });
    await expect(deleteGrantForMembershipEpoch(GUILD_ID, USER_ID, EPOCH_A)).resolves.toBe(false);
    expect(directDeleteMany).not.toHaveBeenCalled();

    directFindUnique.mockResolvedValue({
      permissions: ['__vbot_membership_joined_at:not-a-date', 'economy.view'],
    });
    await expect(deleteGrantForMembershipEpoch(GUILD_ID, USER_ID, EPOCH_A)).resolves.toBe(false);
    expect(directDeleteMany).not.toHaveBeenCalled();
  });
});
