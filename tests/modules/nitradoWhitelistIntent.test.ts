const whitelistFindMany = jest.fn();
const jobFindMany = jest.fn();
const enqueueWhitelistAdd = jest.fn();
const enqueueWhitelistRemove = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    whitelistEntry: { findMany: whitelistFindMany },
    nitradoJob: { findMany: jobFindMany },
  },
}));

jest.mock('../../src/modules/whitelist/whitelistOutbox', () => ({
  enqueueWhitelistAdd,
  enqueueWhitelistRemove,
}));

import {
  decideWhitelistRemoteIntent,
  readWhitelistDesiredState,
  reconcileWhitelistRemoteIntent,
} from '../../src/modules/nitrado/whitelistIntent';
import { WHITELIST_REMOVE_SAFETY_INTENT } from '../../src/modules/whitelist/whitelistJobSafety';

const GUILD = '123456789012345678';
const CONN = 'c123456789012345678901234';

beforeEach(() => {
  jest.clearAllMocks();
  whitelistFindMany.mockResolvedValue([]);
  jobFindMany.mockResolvedValue([]);
  enqueueWhitelistAdd.mockResolvedValue(true);
  enqueueWhitelistRemove.mockResolvedValue(true);
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

  it('executes REMOVE for PENDING_REMOVE without requiring a remote-only marker', async () => {
    whitelistFindMany.mockResolvedValue([
      { gameId: 'PlayerOne', syncState: 'PENDING_REMOVE' },
    ]);

    await expect(decideWhitelistRemoteIntent('WHITELIST_REMOVE', GUILD, CONN, 'PlayerOne'))
      .resolves.toEqual({ execute: true, desiredState: 'PENDING_REMOVE', reason: 'CURRENT_INTENT' });
    expect(jobFindMany).not.toHaveBeenCalled();
  });

  it('fails an untracked legacy REMOVE closed when its RUNNING job has no safety marker', async () => {
    jobFindMany.mockResolvedValue([
      { payload: { gameId: 'RemoteOnly' } },
    ]);

    await expect(decideWhitelistRemoteIntent('WHITELIST_REMOVE', GUILD, CONN, 'RemoteOnly'))
      .resolves.toEqual({
        execute: false,
        desiredState: 'UNTRACKED',
        reason: 'UNTRACKED_REMOVE_NOT_AUTHORIZED',
      });
  });

  it('executes an untracked REMOVE only for exactly one matching marked RUNNING job', async () => {
    jobFindMany.mockResolvedValue([
      {
        payload: {
          gameId: ' RemoteOnly ',
          removeSafetyIntent: WHITELIST_REMOVE_SAFETY_INTENT,
        },
      },
    ]);

    await expect(decideWhitelistRemoteIntent('WHITELIST_REMOVE', GUILD, CONN, 'remoteonly'))
      .resolves.toEqual({ execute: true, desiredState: 'UNTRACKED', reason: 'CURRENT_INTENT' });
    expect(jobFindMany).toHaveBeenCalledWith({
      where: {
        guildId: GUILD,
        nitradoConnId: CONN,
        operation: 'WHITELIST_REMOVE',
        status: 'RUNNING',
      },
      select: { payload: true },
    });
  });

  it('fails closed when two matching RUNNING remove jobs make provenance ambiguous', async () => {
    jobFindMany.mockResolvedValue([
      { payload: { gameId: 'RemoteOnly', removeSafetyIntent: WHITELIST_REMOVE_SAFETY_INTENT } },
      { payload: { gameId: 'remoteonly' } },
    ]);

    await expect(decideWhitelistRemoteIntent('WHITELIST_REMOVE', GUILD, CONN, 'RemoteOnly'))
      .resolves.toEqual({
        execute: false,
        desiredState: 'UNTRACKED',
        reason: 'UNTRACKED_REMOVE_NOT_AUTHORIZED',
      });
  });

  it('queues a REMOVE compensation before a superseded ADD can be treated as complete', async () => {
    whitelistFindMany.mockResolvedValue([
      { gameId: 'PlayerOne', syncState: 'PENDING_REMOVE' },
    ]);

    await expect(reconcileWhitelistRemoteIntent('WHITELIST_ADD', GUILD, CONN, 'PlayerOne'))
      .resolves.toEqual({
        execute: false,
        desiredState: 'PENDING_REMOVE',
        reason: 'SUPERSEDED_BY_REMOVE',
        compensationQueued: true,
      });

    expect(enqueueWhitelistRemove).toHaveBeenCalledWith(
      expect.anything(),
      { guildId: GUILD, nitradoConnId: CONN },
      'PlayerOne',
    );
    expect(enqueueWhitelistAdd).not.toHaveBeenCalled();
  });

  it('queues an ADD compensation before a superseded REMOVE can be treated as complete', async () => {
    whitelistFindMany.mockResolvedValue([
      { gameId: 'PlayerOne', syncState: 'SYNCED' },
    ]);

    await expect(reconcileWhitelistRemoteIntent('WHITELIST_REMOVE', GUILD, CONN, 'PlayerOne'))
      .resolves.toEqual({
        execute: false,
        desiredState: 'PRESENT',
        reason: 'SUPERSEDED_BY_PRESENT',
        compensationQueued: true,
      });

    expect(enqueueWhitelistAdd).toHaveBeenCalledWith(
      expect.anything(),
      { guildId: GUILD, nitradoConnId: CONN },
      'PlayerOne',
    );
    expect(enqueueWhitelistRemove).not.toHaveBeenCalled();
  });

  it('does not speculate with an ADD compensation for an unauthorized untracked REMOVE', async () => {
    jobFindMany.mockResolvedValue([{ payload: { gameId: 'RemoteOnly' } }]);

    await expect(reconcileWhitelistRemoteIntent('WHITELIST_REMOVE', GUILD, CONN, 'RemoteOnly'))
      .resolves.toEqual({
        execute: false,
        desiredState: 'UNTRACKED',
        reason: 'UNTRACKED_REMOVE_NOT_AUTHORIZED',
        compensationQueued: false,
      });
    expect(enqueueWhitelistAdd).not.toHaveBeenCalled();
    expect(enqueueWhitelistRemove).not.toHaveBeenCalled();
  });

  it('does not enqueue compensation while the historical operation is still current', async () => {
    whitelistFindMany.mockResolvedValue([
      { gameId: 'PlayerOne', syncState: 'SYNCED' },
    ]);

    await expect(reconcileWhitelistRemoteIntent('WHITELIST_ADD', GUILD, CONN, 'PlayerOne'))
      .resolves.toEqual({
        execute: true,
        desiredState: 'PRESENT',
        reason: 'CURRENT_INTENT',
        compensationQueued: false,
      });

    expect(enqueueWhitelistAdd).not.toHaveBeenCalled();
    expect(enqueueWhitelistRemove).not.toHaveBeenCalled();
  });

  it('propagates compensation-outbox failures so the worker retries instead of falsely marking DONE', async () => {
    whitelistFindMany.mockResolvedValue([
      { gameId: 'PlayerOne', syncState: 'PENDING_REMOVE' },
    ]);
    enqueueWhitelistRemove.mockRejectedValue(new Error('outbox unavailable'));

    await expect(reconcileWhitelistRemoteIntent('WHITELIST_ADD', GUILD, CONN, 'PlayerOne'))
      .rejects.toThrow('outbox unavailable');
  });

  it('fails before DB access for an empty identifier', async () => {
    await expect(readWhitelistDesiredState(GUILD, CONN, '   ')).rejects.toThrow(/leerer Gameserver-Identifier/);
    expect(whitelistFindMany).not.toHaveBeenCalled();
  });
});
