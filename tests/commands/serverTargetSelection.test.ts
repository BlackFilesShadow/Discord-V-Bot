const findMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findMany },
  },
}));

import {
  autocompleteServerAlias,
  resolveSelectedOrAllServers,
  resolveSingleServer,
} from '../../src/commands/dashboard/serverTargetSelection';

const rows = [
  {
    id: 'conn-a', guildId: 'guild-1', slot: 1, alias: 'Chernarus Main',
    nitradoServerId: 'srv-a', encryptedToken: 'enc-a',
  },
  {
    id: 'conn-b', guildId: 'guild-1', slot: 2, alias: 'Livonia PVE',
    nitradoServerId: 'srv-b', encryptedToken: 'enc-b',
  },
];

function chatInteraction(slotValue: string | null = null) {
  return {
    options: { getString: jest.fn(() => slotValue) },
    reply: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('serverTargetSelection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue(rows);
  });

  it('liefert ohne Auswahl ausnahmslos alle nutzbaren verknuepften Server', async () => {
    const interaction = chatInteraction(null);
    const result = await resolveSelectedOrAllServers(interaction, 'guild-1');

    expect(result?.map(r => r.id)).toEqual(['conn-a', 'conn-b']);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: 'guild-1',
        status: 'ACTIVE',
        nitradoServerId: { not: null },
      }),
    }));
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('loest die vom Autocomplete uebertragene Connection-ID auf genau einen Alias auf', async () => {
    const interaction = chatInteraction('conn-b');
    const result = await resolveSelectedOrAllServers(interaction, 'guild-1');

    expect(result).toHaveLength(1);
    expect(result?.[0]).toEqual(expect.objectContaining({ id: 'conn-b', alias: 'Livonia PVE', slot: 2 }));
  });

  it('akzeptiert aus Robustheitsgruenden auch einen exakt eingegebenen eindeutigen Alias', async () => {
    const interaction = chatInteraction('chernarus main');
    const result = await resolveSelectedOrAllServers(interaction, 'guild-1');

    expect(result?.[0]?.id).toBe('conn-a');
  });

  it('waehlt bei doppeltem manuellem Alias niemals still den ersten Server', async () => {
    findMany.mockResolvedValue([
      { ...rows[0], alias: 'Production' },
      { ...rows[1], alias: 'Production' },
    ]);
    const interaction = chatInteraction('production');
    const result = await resolveSelectedOrAllServers(interaction, 'guild-1');

    expect(result).toBeNull();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('nicht eindeutig'),
    }));
  });

  it('weist fremde/ungueltige Alias-Werte fail-closed ab', async () => {
    const interaction = chatInteraction('fremder-server');
    const result = await resolveSelectedOrAllServers(interaction, 'guild-1');

    expect(result).toBeNull();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it('verlangt bei einem serverspezifischen Workflow und mehreren Servern einen Alias', async () => {
    const interaction = chatInteraction(null);
    const result = await resolveSingleServer(interaction, 'guild-1');

    expect(result).toBeNull();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Chernarus Main'),
    }));
  });

  it('liefert bei genau einem Server ohne Auswahl automatisch diesen Server', async () => {
    findMany.mockResolvedValue([rows[0]]);
    const interaction = chatInteraction(null);
    const result = await resolveSingleServer(interaction, 'guild-1');

    expect(result?.id).toBe('conn-a');
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('zeigt im Discord-Autocomplete den Alias, uebertraegt aber die stabile Connection-ID', async () => {
    const interaction = {
      guildId: 'guild-1',
      options: { getFocused: jest.fn(() => 'livo') },
      respond: jest.fn().mockResolvedValue(undefined),
    } as any;

    await autocompleteServerAlias(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'Livonia PVE (Slot 2)', value: 'conn-b' },
    ]);
  });
});
