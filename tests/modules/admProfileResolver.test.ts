jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoAdmProfileConfig: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import prisma from '../../src/database/prisma';
import type { NitradoClient } from '../../src/modules/nitrado/nitradoClient';
import { resolveAdmProfile } from '../../src/modules/nitrado/adm/profileResolver';

const profileDb = prisma.nitradoAdmProfileConfig as unknown as {
  findUnique: jest.Mock;
  upsert: jest.Mock;
  updateMany: jest.Mock;
};

function makeClient(overrides: Partial<Record<'listAdmFiles' | 'getGameserverInfo' | 'searchFiles' | 'listDir', jest.Mock>> = {}): NitradoClient {
  return {
    listAdmFiles: overrides.listAdmFiles ?? jest.fn(),
    getGameserverInfo: overrides.getGameserverInfo ?? jest.fn(),
    searchFiles: overrides.searchFiles ?? jest.fn(),
    listDir: overrides.listDir ?? jest.fn(),
  } as unknown as NitradoClient;
}

describe('ADM profile resolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    profileDb.upsert.mockImplementation(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
      profileDir: update.profileDir ?? create.profileDir,
      source: update.source ?? create.source,
      timeZone: update.timeZone ?? create.timeZone ?? null,
    }));
  });

  it('heilt einen gecachten leeren /logs-Pfad und findet DayZ-PS-ADM unter gamePath/config', async () => {
    profileDb.findUnique.mockResolvedValue({
      id: 'profile-1',
      guildId: 'guild-1',
      nitradoConnId: 'conn-1',
      profileDir: '/games/ni10428225_2/noftp/dayzps/logs',
      source: 'AUTO',
      timeZone: null,
      lastVerifiedAt: new Date(),
      lastError: null,
    });

    const listAdmFiles = jest.fn(async (_serviceId: string, dir: string) => {
      if (dir === '/games/ni10428225_2/noftp/dayzps/config') {
        return [{ name: 'DayZServer_PS4_x64_2026-08-15_04-09-20.ADM', modified_at: 1786759760, size: 124 }];
      }
      return [];
    });
    const client = makeClient({
      listAdmFiles,
      getGameserverInfo: jest.fn().mockResolvedValue({
        game: 'dayzps',
        status: 'started',
        username: 'ni10428225_2',
        path: '/games/ni10428225_2/noftp/dayzps/',
      }),
      searchFiles: jest.fn().mockResolvedValue([]),
      listDir: jest.fn().mockResolvedValue([]),
    });

    const resolved = await resolveAdmProfile(
      { id: 'conn-1', guildId: 'guild-1', nitradoServerId: '19644115' },
      client,
    );

    expect(resolved).toEqual({
      profileDir: '/games/ni10428225_2/noftp/dayzps/config',
      source: 'AUTO',
      timeZone: null,
    });
    expect(listAdmFiles).toHaveBeenCalledWith('19644115', '/games/ni10428225_2/noftp/dayzps/logs');
    expect(listAdmFiles).toHaveBeenCalledWith('19644115', '/games/ni10428225_2/noftp/dayzps/config');
    expect(profileDb.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        profileDir: '/games/ni10428225_2/noftp/dayzps/config',
        source: 'AUTO',
        lastError: null,
      }),
    }));
  });

  it('wechselt nach dem Freshness-Fenster von einer alten nichtleeren AUTO-Quelle zur frischesten ADM-Quelle', async () => {
    const oldDir = '/games/ni10428225_2/noftp/dayzps/logs';
    const liveDir = '/games/ni10428225_2/noftp/dayzps/config';
    profileDb.findUnique.mockResolvedValue({
      id: 'profile-1',
      guildId: 'guild-1',
      nitradoConnId: 'conn-1',
      profileDir: oldDir,
      source: 'AUTO',
      timeZone: 'Europe/Berlin',
      lastVerifiedAt: new Date(Date.now() - 11 * 60_000),
      lastError: null,
    });

    const listAdmFiles = jest.fn(async (_serviceId: string, dir: string) => {
      if (dir === oldDir) {
        return [{ name: 'DayZServer_PS4_x64_2026-09-04_10-00-00.ADM', modified_at: 1_786_000_000, size: 12_000 }];
      }
      if (dir === liveDir) {
        return [{ name: 'DayZServer_PS4_x64_2026-09-05_20-00-00.ADM', modified_at: 1_786_100_000, size: 16_000 }];
      }
      return [];
    });
    const client = makeClient({
      listAdmFiles,
      getGameserverInfo: jest.fn().mockResolvedValue({
        game: 'dayzps',
        status: 'started',
        username: 'ni10428225_2',
        path: '/games/ni10428225_2/noftp/dayzps/',
      }),
      searchFiles: jest.fn().mockResolvedValue([]),
      listDir: jest.fn().mockResolvedValue([]),
    });

    const resolved = await resolveAdmProfile(
      { id: 'conn-1', guildId: 'guild-1', nitradoServerId: '19644115' },
      client,
    );

    expect(resolved).toEqual({ profileDir: liveDir, source: 'AUTO', timeZone: 'Europe/Berlin' });
    expect(listAdmFiles).toHaveBeenCalledWith('19644115', oldDir);
    expect(listAdmFiles).toHaveBeenCalledWith('19644115', liveDir);
    expect(profileDb.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        profileDir: liveDir,
        source: 'AUTO',
        timeZone: 'Europe/Berlin',
        lastError: null,
      }),
    }));
  });

  it('laesst ein leeres existierendes Verzeichnis die rekursive ADM-Suche nicht mehr kurzschliessen', async () => {
    profileDb.findUnique.mockResolvedValue(null);

    const searchFiles = jest.fn().mockResolvedValue([
      {
        name: 'DayZServer_PS4_x64.ADM',
        path: '/games/ni10428225_2/noftp/dayzps/custom/DayZServer_PS4_x64.ADM',
      },
    ]);
    const client = makeClient({
      listAdmFiles: jest.fn().mockResolvedValue([]),
      getGameserverInfo: jest.fn().mockResolvedValue({
        game: 'dayzps',
        status: 'started',
        username: 'ni10428225_2',
        path: '/games/ni10428225_2/noftp/dayzps/',
      }),
      searchFiles,
      listDir: jest.fn().mockResolvedValue([]),
    });

    const resolved = await resolveAdmProfile(
      { id: 'conn-1', guildId: 'guild-1', nitradoServerId: '19644115' },
      client,
    );

    expect(searchFiles).toHaveBeenCalled();
    expect(resolved).toEqual({
      profileDir: '/games/ni10428225_2/noftp/dayzps/custom',
      source: 'AUTO_SEARCH',
      timeZone: null,
    });
  });
});
