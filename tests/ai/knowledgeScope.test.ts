jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findMany: jest.fn(), findFirst: jest.fn() },
    guildKnowledge: { findUnique: jest.fn() },
    guildKnowledgeScope: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

import prisma from '../../src/database/prisma';
import {
  filterKnowledgeRowsForScope,
  listKnowledgeGameservers,
  looksLikeLiveServerKnowledgeQuestion,
  resolveRuntimeKnowledgeScope,
  setKnowledgeScope,
  validateKnowledgeScope,
} from '../../src/modules/ai/knowledgeScope';

const mockedPrisma = prisma as unknown as {
  nitradoConnection: { findMany: jest.Mock; findFirst: jest.Mock };
  guildKnowledge: { findUnique: jest.Mock };
  guildKnowledgeScope: { findMany: jest.Mock; deleteMany: jest.Mock; upsert: jest.Mock };
};

const server = (id: string, slot: number, alias: string) => ({
  id,
  slot,
  alias,
  alias5: `A${slot}BCD`,
  status: 'ACTIVE',
  nitradoServerId: String(1000 + slot),
});

describe('AI-10/AI-13 knowledge gameserver scope', () => {
  beforeEach(() => jest.clearAllMocks());

  it('trennt allgemeines und Live-Server-Wissen VOR dem Ranking strikt', () => {
    const rows = [{ id: 'global' }, { id: 's1' }, { id: 's2' }];
    const scopes = [
      { knowledgeId: 's1', nitradoConnId: 'conn-1' },
      { knowledgeId: 's2', nitradoConnId: 'conn-2' },
    ];
    expect(filterKnowledgeRowsForScope(rows, scopes, 'conn-1').map((r) => r.id)).toEqual(['s1']);
    expect(filterKnowledgeRowsForScope(rows, scopes, 'conn-2').map((r) => r.id)).toEqual(['s2']);
    expect(filterKnowledgeRowsForScope(rows, scopes, null).map((r) => r.id)).toEqual(['global']);
  });

  it('erkennt klare Live-Server-Intention ohne allgemeine DayZ-Fragen hochzustufen', () => {
    expect(looksLikeLiveServerKnowledgeQuestion('Wie ist unser Server eingestellt?')).toBe(true);
    expect(looksLikeLiveServerKnowledgeQuestion('Welchen nominal Wert haben wir bei uns?')).toBe(true);
    expect(looksLikeLiveServerKnowledgeQuestion('Was bedeutet nominal in types.xml?')).toBe(false);
    expect(looksLikeLiveServerKnowledgeQuestion('Wie funktioniert die Central Economy in DayZ?')).toBe(false);
  });

  it('nimmt bei exakt einem produktiven Gameserver nur bei Live-Intention automatisch dessen Scope', async () => {
    mockedPrisma.nitradoConnection.findMany.mockResolvedValue([server('conn-1', 1, 'Chernarus')]);
    await expect(resolveRuntimeKnowledgeScope('guild-1', 'Wie ist unser Restart?')).resolves.toMatchObject({ id: 'conn-1' });
  });

  it('laesst allgemeine DayZ-Fragen auch bei genau einem Gameserver global-only', async () => {
    mockedPrisma.nitradoConnection.findMany.mockResolvedValue([server('conn-1', 1, 'Chernarus')]);
    await expect(resolveRuntimeKnowledgeScope('guild-1', 'Was bedeutet nominal in types.xml?')).resolves.toBeNull();
  });

  it('bleibt bei mehreren Gameservern ohne eindeutige Auswahl global-only', async () => {
    mockedPrisma.nitradoConnection.findMany.mockResolvedValue([
      server('conn-1', 1, 'Chernarus'),
      server('conn-2', 2, 'Livonia'),
    ]);
    await expect(resolveRuntimeKnowledgeScope('guild-1', 'Wie ist unser Restart?')).resolves.toBeNull();
  });

  it('loest einen expliziten Slot/Alias eindeutig auf, ohne Slot-1-Fallback', async () => {
    mockedPrisma.nitradoConnection.findMany.mockResolvedValue([
      server('conn-1', 1, 'Chernarus'),
      server('conn-2', 2, 'Livonia'),
    ]);
    await expect(resolveRuntimeKnowledgeScope('guild-1', 'Was gilt auf Slot 2?')).resolves.toMatchObject({ id: 'conn-2' });
    await expect(resolveRuntimeKnowledgeScope('guild-1', 'Was gilt auf Livonia?')).resolves.toMatchObject({ id: 'conn-2' });
  });

  it('bietet inaktive, ungebundene und Legacy-Slots nicht als Knowledge-Scope an', async () => {
    mockedPrisma.nitradoConnection.findMany.mockResolvedValue([
      server('conn-1', 1, 'Chernarus'),
      { ...server('legacy', 5, 'Legacy'), slot: 5 },
      { ...server('empty', 2, 'Empty'), nitradoServerId: '' },
    ]);
    await expect(listKnowledgeGameservers('guild-1')).resolves.toEqual([
      expect.objectContaining({ id: 'conn-1', slot: 1 }),
    ]);
    expect(mockedPrisma.nitradoConnection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ guildId: 'guild-1', status: 'ACTIVE', slot: { gte: 1, lte: 4 } }),
    }));
  });

  it('weist fremde Guild-, inaktive, Legacy- und ungebundene Scope-IDs fail-closed ab', async () => {
    mockedPrisma.nitradoConnection.findFirst.mockResolvedValueOnce(null);
    await expect(validateKnowledgeScope('guild-1', 'foreign')).resolves.toEqual(expect.objectContaining({ ok: false }));

    mockedPrisma.nitradoConnection.findFirst.mockResolvedValueOnce({ ...server('inactive', 1, 'X'), status: 'EXPIRED' });
    await expect(validateKnowledgeScope('guild-1', 'inactive')).resolves.toEqual(expect.objectContaining({ ok: false }));

    mockedPrisma.nitradoConnection.findFirst.mockResolvedValueOnce(server('legacy', 5, 'Legacy'));
    await expect(validateKnowledgeScope('guild-1', 'legacy')).resolves.toEqual(expect.objectContaining({ ok: false }));

    mockedPrisma.nitradoConnection.findFirst.mockResolvedValueOnce({ ...server('unbound', 1, 'X'), nitradoServerId: null });
    await expect(validateKnowledgeScope('guild-1', 'unbound')).resolves.toEqual(expect.objectContaining({ ok: false }));
  });

  it('globalisiert niemals stillschweigend: scope=null loescht nur die Sidecar-Zeile', async () => {
    mockedPrisma.guildKnowledge.findUnique.mockResolvedValue({ guildId: 'guild-1' });
    mockedPrisma.guildKnowledgeScope.deleteMany.mockResolvedValue({ count: 1 });
    const result = await setKnowledgeScope('guild-1', 'knowledge-1', null);
    expect(result).toEqual(expect.objectContaining({ ok: true, scope: expect.objectContaining({ type: 'GLOBAL' }) }));
    expect(mockedPrisma.guildKnowledgeScope.deleteMany).toHaveBeenCalledWith({
      where: { knowledgeId: 'knowledge-1', guildId: 'guild-1' },
    });
    expect(mockedPrisma.guildKnowledgeScope.upsert).not.toHaveBeenCalled();
  });

  it('persistiert nur einen zuvor gegen dieselbe Guild validierten Gameserver-Scope', async () => {
    mockedPrisma.guildKnowledge.findUnique.mockResolvedValue({ guildId: 'guild-1' });
    mockedPrisma.nitradoConnection.findFirst.mockResolvedValue(server('conn-2', 2, 'Livonia'));
    mockedPrisma.guildKnowledgeScope.upsert.mockResolvedValue({});

    const result = await setKnowledgeScope('guild-1', 'knowledge-1', 'conn-2');
    expect(result).toEqual(expect.objectContaining({ ok: true, scope: expect.objectContaining({ nitradoConnId: 'conn-2' }) }));
    expect(mockedPrisma.guildKnowledgeScope.upsert).toHaveBeenCalledWith({
      where: { knowledgeId: 'knowledge-1' },
      create: { knowledgeId: 'knowledge-1', guildId: 'guild-1', nitradoConnId: 'conn-2' },
      update: { guildId: 'guild-1', nitradoConnId: 'conn-2' },
    });
  });
});
