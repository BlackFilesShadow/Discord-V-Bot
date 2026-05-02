/**
 * Tiefen-Tests fuer die Casino + Bank Embed-Umstellung.
 *
 * Garantien:
 *  - /bank antwortet mit einem EmbedBuilder, NICHT ephemeral, ohne pingbare Mentions.
 *  - /slot, /coinflip, /dice, /blackjack antworten public mit Embed.
 *  - allowedMentions.parse: [] verhindert Self-Ping / @everyone-Eskalation.
 *  - Provably-Fair-Footer ist gesetzt (Hash + Nonce).
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    economyAccount: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    economyTransaction: { create: jest.fn() },
    economyConfig: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    casinoGame: { findUnique: jest.fn() },
    casinoRound: { count: jest.fn(), create: jest.fn() },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      economyAccount: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      economyTransaction: { create: jest.fn().mockResolvedValue({}) },
      casinoRound: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({}),
      },
    }),
  },
}));

jest.mock('../../src/commands/middleware/withGuildScope', () => ({
  withGuildScope: (_opts: unknown, fn: (i: unknown, scope: unknown) => Promise<unknown>) =>
    (i: unknown) => fn(i, { guildId: 'GUILD_X', actorDiscordId: '123456789012345678' }),
}));

jest.mock('../../src/modules/economy/repository', () => ({
  __esModule: true,
  getOrCreateAccount: jest.fn().mockResolvedValue({
    walletBalance: 1234n,
    bankBalance: 5678n,
  }),
  getConfig: jest.fn().mockResolvedValue({
    emoji: ':coin:',
    bankInterestPercent: 1.5,
  }),
  recentTransactions: jest.fn(),
  pay: jest.fn(),
  adminPay: jest.fn(),
  deposit: jest.fn(),
  withdraw: jest.fn(),
  transferBank: jest.fn(),
}));

jest.mock('../../src/dashboard/socket/emitter', () => ({
  emitGuildEvent: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logAudit: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { bankCommand } from '../../src/commands/dashboard/economy';
import {
  slotCommand, coinflipCommand, diceCommand, blackjackCommand,
} from '../../src/commands/dashboard/casino';
import prisma from '../../src/database/prisma';

interface FakeReplyArg {
  embeds?: EmbedBuilder[];
  flags?: number;
  allowedMentions?: { parse: string[] };
  content?: string;
}

function makeInteraction(opts: { intOpt?: number; strOpt?: string } = {}) {
  const reply = jest.fn().mockResolvedValue(undefined);
  const i = {
    user: {
      id: '987654321098765432',
      username: 'TestUser',
      displayAvatarURL: () => 'https://cdn/avatar.png',
    },
    options: {
      getInteger: (_n: string, _req?: boolean) => opts.intOpt ?? 100,
      getString: (_n: string, _req?: boolean) => opts.strOpt ?? 'KOPF',
      getUser: () => null,
    },
    reply,
  };
  return { i, reply };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: aktivierte Casino-Spiele (alle Typen)
  (prisma.casinoGame.findUnique as jest.Mock).mockResolvedValue({
    id: 'game-1',
    enabled: true,
    minBet: 1n,
    maxBet: 1_000_000n,
    winChancePct: 50,
    payoutMult: 2,
  });
});

describe('Casino + Bank Embeds (Public, kein Self-Ping)', () => {
  it('/bank: public Embed mit Wallet/Bank/Gesamt/Zinsen + allowedMentions.parse=[]', async () => {
    const { i, reply } = makeInteraction();
    await bankCommand.execute(i as never);

    expect(reply).toHaveBeenCalledTimes(1);
    const arg = reply.mock.calls[0][0] as FakeReplyArg;

    // Public (KEIN Ephemeral-Flag)
    expect(arg.flags).toBeUndefined();
    expect(arg.flags).not.toBe(MessageFlags.Ephemeral);

    // Self-Ping-Schutz
    expect(arg.allowedMentions).toEqual({ parse: [] });

    // Embed vorhanden
    expect(arg.embeds).toHaveLength(1);
    const embed = arg.embeds![0];
    const json = embed.toJSON();
    expect(json.title).toContain('Bankuebersicht');
    expect(JSON.stringify(json.fields)).toContain('Wallet');
    expect(JSON.stringify(json.fields)).toContain('Bank');
    expect(JSON.stringify(json.fields)).toContain('Gesamt');
    expect(JSON.stringify(json.fields)).toContain('Zinsen');

    // Description darf KEINE pingende Mention enthalten
    expect(json.description ?? '').not.toMatch(/<@!?\d+>/);
  });

  it.each([
    ['slot', () => slotCommand.execute, { intOpt: 10 }],
    ['coinflip', () => coinflipCommand.execute, { strOpt: 'KOPF', intOpt: 10 }],
    ['dice', () => diceCommand.execute, { intOpt: 3 }],
    ['blackjack', () => blackjackCommand.execute, { intOpt: 10 }],
  ])('/%s: public Embed + allowedMentions.parse=[] + ProvablyFair-Footer', async (_name, exec, optArgs) => {
    const { i, reply } = makeInteraction(optArgs as { intOpt?: number; strOpt?: string });
    await exec()(i as never);

    expect(reply).toHaveBeenCalledTimes(1);
    const arg = reply.mock.calls[0][0] as FakeReplyArg;

    expect(arg.flags).toBeUndefined();
    expect(arg.allowedMentions).toEqual({ parse: [] });
    expect(arg.embeds).toHaveLength(1);

    const json = arg.embeds![0].toJSON();
    expect(json.title).toMatch(/Gewonnen|Verloren/);
    expect(json.footer?.text ?? '').toContain('Provably-Fair');
    expect(json.footer?.text ?? '').toMatch(/Hash:\s+[a-f0-9]{16}/);
    expect(json.footer?.text ?? '').toMatch(/Nonce:\s+\d+/);

    // Einsatz/Auszahlung/Netto IMMER vorhanden
    const fieldsStr = JSON.stringify(json.fields);
    expect(fieldsStr).toContain('Einsatz');
    expect(fieldsStr).toContain('Auszahlung');
    expect(fieldsStr).toContain('Netto');
  });
});
