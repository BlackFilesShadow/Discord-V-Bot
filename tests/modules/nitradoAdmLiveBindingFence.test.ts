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

const STALE = new Error('stale-binding');
const BINDING = {
  id: 'conn-1',
  guildId: 'guild-1',
  encryptedToken: 'cipher-a',
  nitradoServerId: '123',
  bindingVersion: 2,
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
  listDir.mockResolvedValue([{
    name: 'DayZServer.ADM',
    type: 'file',
    modified_at: 100,
    size: 4,
    path: '/games/example/noftp/dayzps/config/DayZServer.ADM',
  }]);
  downloadFileRange.mockResolvedValue('abc\n');
  cursorFindFirst.mockResolvedValue(null);
  cursorFindUnique.mockResolvedValue(null);
  eventFindFirst.mockResolvedValue(null);
  feedUpdateMany.mockResolvedValue({ count: 1 });
  recordSourceError.mockResolvedValue(undefined);
  persistAdmEvents.mockResolvedValue({ inserted: 0 });
  verifyChallenges.mockResolvedValue({ verified: 0 });
  ingestChunk.mockReturnValue({
    events: [{ rawLine: 'line', byteStart: 0, byteEnd: 2 }],
    newOffset: 2,
    trailingPartial: '',
    wasReset: false,
  });
  withFreshBinding.mockImplementation(async (_binding: unknown, work: () => Promise<unknown>) => work());
  isFenceError.mockImplementation((error: unknown) => error === STALE);
});

describe('Nitrado-1M live ADM binding fence', () => {
  it('baselined einen neuen Service in einem disjunkten Binding-Namespace', async () => {
    await runAdmLiveSyncOnce();

    expect(readBinding).toHaveBeenCalledWith({ id: BINDING.id, guildId: BINDING.guildId });
    expect(listDir).toHaveBeenCalledWith(BINDING.nitradoServerId, '/profiles');
    expect(downloadFileRange).toHaveBeenCalledWith(
      BINDING.nitradoServerId,
      '/games/example/noftp/dayzps/config/DayZServer.ADM',
      0,
      4,
    );
    expect(cursorFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: BINDING.guildId,
        nitradoConnId: BINDING.id,
        fileIdentity: { startsWith: 'adm-binding:2:' },
      }),
    }));
    expect(persistAdmEvents).toHaveBeenCalledWith(
      expect.anything(),
      { guildId: BINDING.guildId, nitradoConnId: BINDING.id },
      expect.objectContaining({
        fileIdentity: 'adm-binding:2:DayZServer.ADM',
        fileName: 'DayZServer.ADM',
        sourceFile: 'adm-binding:2:DayZServer.ADM',
      }),
      expect.objectContaining({ events: [], newOffset: 4 }),
      expect.anything(),
    );
  });

  it('verwirft einen bereits remote gelesenen Chunk vollstaendig wenn die Binding vor Persistenz stale wird', async () => {
    cursorFindFirst.mockResolvedValue({ lastModifiedAt: 100, fileName: 'DayZServer.ADM' });
    cursorFindUnique.mockResolvedValue({
      processedByteOffset: BigInt(0),
      lastKnownSize: BigInt(0),
    });
    withFreshBinding.mockRejectedValueOnce(STALE);

    await runAdmLiveSyncOnce();

    expect(downloadFileRange).toHaveBeenCalledWith(
      BINDING.nitradoServerId,
      '/games/example/noftp/dayzps/config/DayZServer.ADM',
      0,
      4,
    );
    expect(persistAdmEvents).not.toHaveBeenCalled();
    expect(verifyChallenges).not.toHaveBeenCalled();
    expect(feedUpdateMany).not.toHaveBeenCalled();
    expect(recordSourceError).not.toHaveBeenCalled();
    expect(cursorFindUnique).toHaveBeenCalledWith({
      where: {
        guildId_nitradoConnId_fileIdentity: {
          guildId: BINDING.guildId,
          nitradoConnId: BINDING.id,
          fileIdentity: 'adm-binding:2:DayZServer.ADM',
        },
      },
    });
  });
});
