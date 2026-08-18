const profileUpsert = jest.fn();
const profileFindUnique = jest.fn();
const profileUpdateMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoAdmProfileConfig: {
      upsert: profileUpsert,
      findUnique: profileFindUnique,
      updateMany: profileUpdateMany,
    },
  },
}));

import {
  setManualAdmProfile,
  type AdmProfileWriteFence,
} from '../../src/modules/nitrado/adm/profileResolver';

const STALE = new Error('stale-binding');

describe('Nitrado-1M ADM profile write fence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    profileUpsert.mockResolvedValue({
      profileDir: '/profiles',
      timeZone: 'Europe/Berlin',
      source: 'MANUAL',
    });
  });

  it('persistiert nach erfolgreicher Remote-Pruefung nichts mehr, wenn die Binding stale wurde', async () => {
    const client = {
      listDir: jest.fn(async () => []),
    };
    const writeFence = jest.fn(
      async <T>(_work: () => Promise<T>): Promise<T> => {
        throw STALE;
      },
    ) as unknown as AdmProfileWriteFence & jest.Mock;

    await expect(setManualAdmProfile(
      { id: 'conn-1', guildId: 'guild-1', nitradoServerId: '123' },
      client as never,
      '/profiles',
      'Europe/Berlin',
      writeFence,
    )).rejects.toBe(STALE);

    expect(client.listDir).toHaveBeenCalledWith('123', '/profiles');
    expect(writeFence).toHaveBeenCalledTimes(1);
    expect(profileUpsert).not.toHaveBeenCalled();
  });

  it('persistiert unter erfolgreichem Fence weiterhin normal', async () => {
    const client = {
      listDir: jest.fn(async () => []),
    };
    const writeFence = jest.fn(
      async <T>(work: () => Promise<T>): Promise<T> => work(),
    ) as unknown as AdmProfileWriteFence & jest.Mock;

    await expect(setManualAdmProfile(
      { id: 'conn-1', guildId: 'guild-1', nitradoServerId: '123' },
      client as never,
      '/profiles',
      null,
      writeFence,
    )).resolves.toEqual({ profileDir: '/profiles', timeZone: 'Europe/Berlin', source: 'MANUAL' });

    expect(profileUpsert).toHaveBeenCalledTimes(1);
  });
});
