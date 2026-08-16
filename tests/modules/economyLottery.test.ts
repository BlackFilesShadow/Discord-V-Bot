import { selectWeightedWinner, validateLotteryConfig } from '../../src/modules/economy/lottery';

describe('Economy-Lotterie — pure Invarianten', () => {
  it('ordnet gewichtete Ticketindizes deterministisch den Usern zu', () => {
    const entries = [
      { userDiscordId: '111', ticketCount: 2 },
      { userDiscordId: '222', ticketCount: 3 },
      { userDiscordId: '333', ticketCount: 1 },
    ];
    expect(selectWeightedWinner(entries, 0)).toEqual({ userDiscordId: '111', winningTicketNumber: 1 });
    expect(selectWeightedWinner(entries, 1)).toEqual({ userDiscordId: '111', winningTicketNumber: 2 });
    expect(selectWeightedWinner(entries, 2)).toEqual({ userDiscordId: '222', winningTicketNumber: 3 });
    expect(selectWeightedWinner(entries, 4)).toEqual({ userDiscordId: '222', winningTicketNumber: 5 });
    expect(selectWeightedWinner(entries, 5)).toEqual({ userDiscordId: '333', winningTicketNumber: 6 });
  });

  it('verweigert Ziehungsindizes ausserhalb des Ticketpools', () => {
    const entries = [{ userDiscordId: '111', ticketCount: 1 }];
    expect(() => selectWeightedWinner(entries, -1)).toThrow();
    expect(() => selectWeightedWinner(entries, 1)).toThrow();
  });

  it('verweigert kaputte Ticketgewichte', () => {
    expect(() => selectWeightedWinner([{ userDiscordId: '111', ticketCount: 0 }], 0)).toThrow();
    expect(() => selectWeightedWinner([{ userDiscordId: '111', ticketCount: 1.5 }], 0)).toThrow();
  });

  it('akzeptiert nur begrenzte produktive Round-Konfiguration', () => {
    expect(() => validateLotteryConfig({
      ticketPrice: 100n,
      maxTicketsPerUser: 10,
      minParticipants: 2,
      endsAt: new Date(Date.now() + 120_000),
    })).not.toThrow();
    expect(() => validateLotteryConfig({ ticketPrice: 0n, maxTicketsPerUser: 10, minParticipants: 2, endsAt: new Date(Date.now() + 120_000) })).toThrow();
    expect(() => validateLotteryConfig({ ticketPrice: 100n, maxTicketsPerUser: 0, minParticipants: 2, endsAt: new Date(Date.now() + 120_000) })).toThrow();
    expect(() => validateLotteryConfig({ ticketPrice: 100n, maxTicketsPerUser: 10, minParticipants: 1, endsAt: new Date(Date.now() + 120_000) })).toThrow();
    expect(() => validateLotteryConfig({ ticketPrice: 100n, maxTicketsPerUser: 10, minParticipants: 2, endsAt: new Date(Date.now() + 30_000) })).toThrow();
  });
});