const findConnections = jest.fn();
const cursorFindFirst = jest.fn();
const cursorFindUnique = jest.fn();
const eventFindFirst = jest.fn();
const feedUpdateMany = jest.fn();
const resolveProfile = jest.fn();
const recordSourceError = jest.fn();
const listDir = jest.fn();
const downloadFileRange = jest.fn();
const persistAdmEvents = jest.fn();
const ingestChunk = jest.fn();
const verifyChallenges = jest.fn();
const readBinding = jest.fn();
const withFreshBinding = jest.fn();
const isFenceError = jest.fn();

const BINDING = {
  id: 'conn-safe-range',
  guildId: 'guild-safe-range',
  encryptedToken: 'cipher-safe-range',
  nitradoServerId: '19513993',
  bindingVersion: 0,
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findMany: findConnections },
    gameplayFeedConfig: { updateMany: feedUpdateMany },
    admSourceCursor: { findFirst: cursorFindFirst, findUnique: cursorFindUnique },
    admEvent: { findFirst: eventFindFirst },
  },
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '12345678901234567890123456789012' } },
}));

jest.mock('../../src/utils/security', () => ({ decrypt: jest.fn(() => 'token') }));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({ listDir, downloadFileRange })),
}));

jest.mock('../../src/modules/nitrado/adm/profileResolver', () => ({
  resolveAdmProfile: (...args: unknown[]) => resolveProfile(...args),
  recordAdmSourceError: (...args: unknown[]) => recordSourceError(...args),
}));

jest.mock('../../src/modules/nitrado/adm/serverLogIngestor', () => ({
  ingestChunk: (...args: unknown[]) => ingestChunk(...args),
  persistAdmEvents: (...args: unknown[]) => persistAdmEvents(...args),
}));

jest.mock('../../src/modules/linking/admChallengeVerifier', () => ({
  verifyLinkChallengesInAdmText: (...args: unknown[]) => verifyChallenges(...args),
}));

jest.mock('../../src/modules/nitrado/adm/bindingFence', () => ({
  readCurrentAdmBinding: (...args: unknown[]) => readBinding(...args),
  withFreshAdmBinding: (...args: unknown[]) => withFreshBinding(...args),
  isAdmBindingFenceError: (...args: unknown[]) => isFenceError(...args),
}));

import { runAdmLiveSyncOnce } from '../../src/modules/nitrado/adm/admLiveSyncCron';

beforeEach(() => {
  jest.clearAllMocks();
  findConnections.mockResolvedValue([{ id: BINDING.id, guildId: BINDING.guildId }]);
  readBinding.mockResolvedValue(BINDING);
  resolveProfile.mockResolvedValue({ profileDir: '/profiles', timeZone: null, source: 'AUTO' });
  cursorFindFirst.mockResolvedValue(null);
  cursorFindUnique.mockResolvedValue(null);
  eventFindFirst.mockResolvedValue(null);
  feedUpdateMany.mockResolvedValue({ count: 1 });
  recordSourceError.mockResolvedValue(undefined);
  persistAdmEvents.mockResolvedValue({ inserted: 0 });
  verifyChallenges.mockResolvedValue({ verified: 0 });
  ingestChunk.mockImplementation((chunk: string, offset: number) => ({
    events: [],
    newOffset: offset + Buffer.byteLength(chunk, 'utf8'),
    trailingPartial: '',
    wasReset: false,
  }));
  withFreshBinding.mockImplementation(async (_binding: unknown, work: () => Promise<unknown>) => work());
  isFenceError.mockReturnValue(false);
});

describe('ADM live safe Nitrado ranges', () => {
  it('begrenzt auch den Baseline-Tail auf 4048 Byte', async () => {
    listDir.mockResolvedValue([{
      name: 'DayZServer_PS4_x64_2026-08-30_16-04-13.ADM',
      type: 'file',
      modified_at: 100,
      size: 10_000,
      path: '/profiles/DayZServer_PS4_x64_2026-08-30_16-04-13.ADM',
    }]);
    downloadFileRange.mockResolvedValue('ok\n');

    await runAdmLiveSyncOnce();

    expect(downloadFileRange).toHaveBeenCalledTimes(1);
    expect(downloadFileRange).toHaveBeenCalledWith(
      BINDING.nitradoServerId,
      '/profiles/DayZServer_PS4_x64_2026-08-30_16-04-13.ADM',
      5952,
      4048,
    );
  });

  it('verwirft eine ignorierte Range fail-closed und verarbeitet die naechste ADM-Datei weiter', async () => {
    cursorFindFirst.mockResolvedValue({ lastModifiedAt: 100, fileName: 'older.ADM' });
    listDir.mockResolvedValue([
      {
        name: 'A-large.ADM',
        type: 'file',
        modified_at: 101,
        size: 5000,
        path: '/profiles/A-large.ADM',
      },
      {
        name: 'B-good.ADM',
        type: 'file',
        modified_at: 102,
        size: 3,
        path: '/profiles/B-good.ADM',
      },
    ]);
    downloadFileRange.mockImplementation(async (_service: string, path: string) => {
      if (path.endsWith('/A-large.ADM')) return 'x'.repeat(4049);
      if (path.endsWith('/B-good.ADM')) return 'ok\n';
      throw new Error(`unexpected path ${path}`);
    });

    await runAdmLiveSyncOnce();

    expect(downloadFileRange).toHaveBeenCalledWith(
      BINDING.nitradoServerId,
      '/profiles/A-large.ADM',
      0,
      4048,
    );
    expect(downloadFileRange).toHaveBeenCalledWith(
      BINDING.nitradoServerId,
      '/profiles/B-good.ADM',
      0,
      3,
    );
    expect(persistAdmEvents).toHaveBeenCalledWith(
      expect.anything(),
      { guildId: BINDING.guildId, nitradoConnId: BINDING.id },
      expect.objectContaining({ fileName: 'B-good.ADM' }),
      expect.objectContaining({ newOffset: 3 }),
      expect.anything(),
    );
    expect(recordSourceError).toHaveBeenCalledWith(
      { id: BINDING.id, guildId: BINDING.guildId },
      expect.stringContaining('A-large.ADM'),
    );
  });

  it('begrenzt historische Nachholarbeit auf acht kleine Ranges pro Datei und Poll', async () => {
    cursorFindFirst.mockResolvedValue({ lastModifiedAt: 100, fileName: 'older.ADM' });
    listDir.mockResolvedValue([{
      name: 'backlog.ADM',
      type: 'file',
      modified_at: 101,
      size: 100_000,
      path: '/profiles/backlog.ADM',
    }]);
    downloadFileRange.mockResolvedValue(`${'x'.repeat(4047)}\n`);

    await runAdmLiveSyncOnce();

    expect(downloadFileRange).toHaveBeenCalledTimes(8);
    expect(downloadFileRange).toHaveBeenNthCalledWith(
      8,
      BINDING.nitradoServerId,
      '/profiles/backlog.ADM',
      28_336,
      4048,
    );
    expect(persistAdmEvents).toHaveBeenCalledTimes(8);
    expect(recordSourceError).toHaveBeenCalledWith(
      { id: BINDING.id, guildId: BINDING.guildId },
      null,
    );
  });
});
