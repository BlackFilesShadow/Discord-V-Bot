const whitelistFindMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    whitelistEntry: { findMany: whitelistFindMany },
  },
}));

import {
  decideWhitelistRemoteIntent,
  readWhitelistDesiredState,
} from '../../src/modules/nitrado/whitelistIntent';

const GUILD = '123456789012345678';
const CONN = 'c123456789012345678901234';

beforeEach(() => {
  jest.clearAllMocks();
  whitelistFindMany.mockResolvedValue([]);
});

describe('Nitrado-1B whitelist source-of-truth intent', () => {
  it('treats an active matching local entry as PRESENT case/trim-insensitively', async () => {
    whitelistFindMany.mockResolvedValue([
      { gameId: '  PLAYER ONE  ', syncState: 'SYNCED' },
    ]);

    await expect(readWhitelistDesiredState(GUILD, CONN, 'player one')).resolves.toBe('PRESENT');
    expect(whitelistFindMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, nitradoConnId: CONN },
      select: { gameId: true, syncState: true },
    });
  });

  it('lets any active legacy duplicate win over a case-variant PENDING_REMOVE row', async () => {
    whitelistFindMany.mockResolvedValue([
      { gameId: 'PlayerOne', syncState: 'PENDING_REMOVE' },
      { gameId: 'playerone', syncState: 'LOCAL_ONLY' },
    ]);

    await expect(readWhitelistDesiredState(GUILD, CONN, 'PLAYERONE')).resolves.toBe('PRESENT');
  });

  it('suppresses an old ADD retry after the local intent changed to PENDING_REMOVE', async () => {
    whitelistFindMany.mockResolvedValue([
      { gameId: 'PlayerOne', syncState: 'PENDING_REMOVE' },
    ]);

    await expect(decideWhitelistRemoteIntent('WHITELIST_ADD', GUILD, CONN, 'PlayerOne'))
      .resolves.toEqual({
        execute: false,
        desiredState: 'PENDING_REMOVE',
        reason: 'SUPERSEDED_BY_REMOVE',
      });
  });

  it('suppresses an old ADD retry when the local row disappeared completely', async () => {
    await expect(decideWhitelistRemoteIntent('WHITELIST_ADD', GUILD, CONN, 'Ghost'))
      .resolves.toEqual({
        execute: false,
        desiredState: 'UNTRACKED',
        reason: 'SUPERSEDED_BY_REMOVE',
      });
  });

  it('executes ADD only while the current local source-of-truth still wants PRESENT', async () => {
    whitelistFindMany.mockResolvedValue([
      { gameId: 'PlayerOne', syncState: 'LOCAL_ONLY' },
    ]);

    await expect(decideWhitelistRemoteIntent('WHITELIST_ADD', GUILD, CONN, 'PlayerOne'))
      .resolves.toEqual({ execute: true, desiredState: 'PRESENT', reason: 'CURRENT_INTENT' });
  });

  it('suppresses an old REMOVE retry after a later re-add made the entry active again', async () => {
    whitelistFindMany.mockResolvedValue([
      { gameId: 'PlayerOne', syncState: 'SYNCED' },
    ]);

    await expect(decideWhitelistRemoteIntent('WHITELIST_REMOVE', GUILD, CONN, 'PlayerOne'))
      .resolves.toEqual({
        execute: false,
        desiredState: 'PRESENT',
        reason: 'SUPERSEDED_BY_PRESENT',
      });
  });

  it('executes REMOVE for PENDING_REMOVE and also for intentionally remote-only targets', async () => {
    whitelistFindMany.mockResolvedValueOnce([
      { gameId: 'PlayerOne', syncState: 'PENDING_REMOVE' },
    ]);
    await expect(decideWhitelistRemoteIntent('WHITELIST_REMOVE', GUILD, CONN, 'PlayerOne'))
      .resolves.toEqual({ execute: true, desiredState: 'PENDING_REMOVE', reason: 'CURRENT_INTENT' });

    whitelistFindMany.mockResolvedValueOnce([]);
    await expect(decideWhitelistRemoteIntent('WHITELIST_REMOVE', GUILD, CONN, 'RemoteOnly'))
      .resolves.toEqual({ execute: true, desiredState: 'UNTRACKED', reason: 'CURRENT_INTENT' });
  });

  it('fails before DB access for an empty identifier', async () => {
    await expect(readWhitelistDesiredState(GUILD, CONN, '   ')).rejects.toThrow(/leerer Gameserver-Identifier/);
    expect(whitelistFindMany).not.toHaveBeenCalled();
  });
});
