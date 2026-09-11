const readCurrentAdmBinding = jest.fn();
const withFreshAdmBinding = jest.fn();
const getWhitelist = jest.fn();
const decrypt = jest.fn((..._args: unknown[]) => 'plain-token');

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: 'test-key' } },
}));

jest.mock('../../src/utils/security', () => ({
  decrypt: (...args: unknown[]) => decrypt(...args),
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({
    getWhitelist: (...args: unknown[]) => getWhitelist(...args),
  })),
}));

jest.mock('../../src/modules/nitrado/adm/bindingFence', () => ({
  readCurrentAdmBinding: (...args: unknown[]) => readCurrentAdmBinding(...args),
  withFreshAdmBinding: (...args: unknown[]) => withFreshAdmBinding(...args),
}));

import { isAlreadyOnRemoteWhitelist } from '../../src/modules/whitelist/whitelistRequestPreflight';

const SCOPE = { guildId: '111111111111111111', nitradoConnId: 'conn-a' };
const BINDING = {
  id: 'conn-a',
  guildId: SCOPE.guildId,
  encryptedToken: 'cipher',
  nitradoServerId: '12345',
  bindingVersion: 7,
};

describe('Whitelist request remote preflight', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readCurrentAdmBinding.mockResolvedValue(BINDING);
    withFreshAdmBinding.mockImplementation(async (_binding: unknown, work: () => Promise<unknown>) => work());
  });

  it('erkennt einen Remote-only Eintrag case-insensitive und ohne lokale Mutation', async () => {
    getWhitelist.mockResolvedValue([
      { identifier: 'OtherPlayer' },
      { identifier: 'Void_Architect' },
    ]);

    await expect(isAlreadyOnRemoteWhitelist(SCOPE, 'void_architect')).resolves.toBe(true);
    expect(readCurrentAdmBinding).toHaveBeenCalledWith({ id: SCOPE.nitradoConnId, guildId: SCOPE.guildId });
    expect(decrypt).toHaveBeenCalledWith('cipher', 'test-key');
    expect(getWhitelist).toHaveBeenCalledWith('12345');
    expect(withFreshAdmBinding).toHaveBeenCalledWith(BINDING, expect.any(Function));
  });

  it('liefert false wenn der Spieler remote nicht vorhanden ist', async () => {
    getWhitelist.mockResolvedValue([{ identifier: 'SomeoneElse' }]);
    await expect(isAlreadyOnRemoteWhitelist(SCOPE, 'Void_Architect')).resolves.toBe(false);
  });

  it('bricht fail-closed ab wenn keine aktive Bindung verfuegbar ist', async () => {
    readCurrentAdmBinding.mockResolvedValue(null);
    await expect(isAlreadyOnRemoteWhitelist(SCOPE, 'Void_Architect'))
      .rejects.toThrow('Aktive Nitrado-Bindung fuer Whitelist-Preflight nicht verfuegbar.');
    expect(getWhitelist).not.toHaveBeenCalled();
  });

  it('gibt Binding-Fence-Fehler weiter statt mit einem veralteten Snapshot fortzufahren', async () => {
    getWhitelist.mockResolvedValue([{ identifier: 'Void_Architect' }]);
    withFreshAdmBinding.mockRejectedValue(new Error('STALE'));
    await expect(isAlreadyOnRemoteWhitelist(SCOPE, 'Void_Architect')).rejects.toThrow('STALE');
  });
});
