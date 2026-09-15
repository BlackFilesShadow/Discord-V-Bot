const mockUpdateMany = jest.fn();
const mockFindUnique = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    ticketInstance: {
      updateMany: mockUpdateMany,
      findUnique: mockFindUnique,
    },
  },
}));

import { casMutateTicketUserIds } from '../../src/modules/tickets/ticketSystem';

describe('casMutateTicketUserIds (Regressionsschutz: userIds-Race)', () => {
  beforeEach(() => {
    mockUpdateMany.mockReset();
    mockFindUnique.mockReset();
  });

  it('committet im Happy-Path ohne Konflikt und ohne erneutes Lesen', async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });

    const result = await casMutateTicketUserIds('inst-1', ['a'], (curr) => [...curr, 'b']);

    expect(result).toEqual(['a', 'b']);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'inst-1', userIds: { equals: ['a'] } },
      data: { userIds: { set: ['a', 'b'] } },
    });
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('wendet mutate erneut auf den frischen Stand an, statt den fremden Schreibvorgang zu ueberschreiben', async () => {
    // Erster Versuch: userIds hat sich zwischenzeitlich geaendert (jemand anderes hat 'c' hinzugefuegt) -> count 0.
    mockUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mockFindUnique.mockResolvedValueOnce({ userIds: ['a', 'c'] });

    const result = await casMutateTicketUserIds('inst-1', ['a'], (curr) => (curr.includes('b') ? curr : [...curr, 'b']));

    // Der zweite Schreibversuch muss auf dem frischen Snapshot ['a','c'] aufbauen,
    // nicht den urspruenglichen Snapshot ['a'] blind ueberschreiben -> kein Datenverlust von 'c'.
    expect(result).toEqual(['a', 'c', 'b']);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'inst-1', userIds: { equals: ['a', 'c'] } },
      data: { userIds: { set: ['a', 'c', 'b'] } },
    });
  });

  it('ist idempotent, wenn die Mutation nach einem Konflikt bereits durch einen anderen Vorgang erledigt wurde', async () => {
    mockUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    // Ein anderer Aufruf hat 'b' bereits hinzugefuegt.
    mockFindUnique.mockResolvedValueOnce({ userIds: ['a', 'b'] });

    const result = await casMutateTicketUserIds('inst-1', ['a'], (curr) => (curr.includes('b') ? curr : [...curr, 'b']));

    expect(result).toEqual(['a', 'b']);
    expect(mockUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'inst-1', userIds: { equals: ['a', 'b'] } },
      data: { userIds: { set: ['a', 'b'] } },
    });
  });

  it('gibt null zurueck, wenn die Ticket-Instanz waehrend eines Konflikts geloescht wurde', async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindUnique.mockResolvedValueOnce(null);

    const result = await casMutateTicketUserIds('inst-1', ['a'], (curr) => [...curr, 'b']);

    expect(result).toBeNull();
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('gibt nach Ausschoepfen der maximalen Versuche null zurueck, statt endlos zu retryen', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    mockFindUnique.mockResolvedValue({ userIds: ['a'] });

    const result = await casMutateTicketUserIds('inst-1', ['a'], (curr) => [...curr, 'b'], 3);

    expect(result).toBeNull();
    expect(mockUpdateMany).toHaveBeenCalledTimes(3);
    expect(mockFindUnique).toHaveBeenCalledTimes(3);
  });
});
