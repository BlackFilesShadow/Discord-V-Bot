/**
 * Tiefen-Tests fuer Casino + Bank Embeds und Server-Scope.
 *
 * Garantien:
 *  - /bank antwortet mit einem EmbedBuilder, NICHT ephemeral, ohne pingbare Mentions.
 *  - /slot, /coinflip, /dice, /blackjack antworten public mit Embed.
 *  - allowedMentions.parse: [] verhindert Self-Ping / @everyone-Eskalation.
 *  - Casino-Footer weist ehrlich auf Runden-Audit (Hash + Nonce) hin.
 *  - CasinoRound.result bleibt JSONB-kompatibel, auch wenn PlayResult BigInt-Werte enthaelt.
 *  - alle Casino-Commands bieten eine optionale Gameserver-Slot-Auswahl.
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';

const NITRADO_CONN_ID = 'c123456789012345678901234';
const rawQuery = jest.fn();
const rawExecute = jest.fn();

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: 'test-key' } },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findFirst: jest.fn().mockResolvedValue({ alias: 'Test Server' }) },
    $queryRawUnsafe: rawQuery,
    $executeRawUnsafe: rawExecute,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $queryRawUnsafe: rawQuery,
      $executeRawUnsafe: rawExecute,
    }),
  },
}));

jest.mock('../../src/commands/middleware/withGuildScope', () => ({
  withGuildScope: (_opts: unknown, fn: (i: unknown, scope: unknown) => Promise<unknown>) =>
    (i: unknown) => fn(i, {
      guildId: 'GUILD_X',
      nitradoConnId: NITRADO_CONN_ID,
      actorDiscordId: '123456789012345678',
      isOwner: true,
      permissions: new Set(),
    }),
}));

jest.mock('../../src/modules/economy/scopeMigration', () => ({
  assertEconomyScopeReady: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/modules/economy/repository', () => ({
  __esModule: true,
  getOrCreateAccount: jest.fn().mockResolvedValue({ walletBalance: 1234n, bankBalance: 5678n }),
  getAccountOrZero: jest.fn().mockResolvedValue({
    walletBalance: 1234n,
    bankBalance: 5678n,
    lifetimeEarned: 0n,
    lifetimeSpent: 0n,
  }),
  getConfig: jest.fn().mockResolvedValue({ emoji: ':coin:', bankInterestPercent: 1.5 }),
  recentTransactions: jest.fn(),
  pay: jest.fn(),
  adminPay: jest.fn(),
  deposit: jest.fn(),
  withdraw: jest.fn(),
  transferBank: jest.fn(),
}));

jest.mock('../../src/dashboard/socket/emitter', () => ({ emitGuildEvent: jest.fn() }));

jest.mock('../../src/utils/logger', () => ({
  logAudit: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { bankCommand } from '../../src/commands/dashboard/economy';
import {
  slotCommand, coinflipCommand, diceCommand, blackjackCommand, casinoStatsCommand,
} from '../../src/commands/dashboard/casino';

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
  rawExecute.mockResolvedValue(1);
  rawQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM "CasinoGame"')) {
      return [{
        id: 'game-1', enabled: true, minBet: 1n, maxBet: 1_000_000n,
        winChancePct: 50, payoutMult: 2,
      }];
    }
    if (sql.includes('COUNT(*)')) return [{ count: 0n }];
    return [];
  });
});

describe('Casino + Bank Embeds (Public, kein Self-Ping)', () => {
  it('/bank: public Embed mit Wallet/Bank/Gesamt + allowedMentions.parse=[]', async () => {
    const { i, reply } = makeInteraction();
    await bankCommand.execute(i as never);

    expect(reply).toHaveBeenCalledTimes(1);
    const arg = reply.mock.calls[0][0] as FakeReplyArg;
    expect(arg.flags).toBeUndefined();
    expect(arg.flags).not.toBe(MessageFlags.Ephemeral);
    expect(arg.allowedMentions).toEqual({ parse: [] });
    expect(arg.embeds).toHaveLength(1);
    const json = arg.embeds![0].toJSON();
    expect(json.title).toContain('Bankübersicht');
    expect(JSON.stringify(json.fields)).toContain('Wallet');
    expect(JSON.stringify(json.fields)).toContain('Bank');
    expect(JSON.stringify(json.fields)).toContain('Gesamt');
    expect(json.footer?.text ?? '').not.toMatch(/Guild\s+GUILD_X/);
    expect(json.description ?? '').not.toMatch(/<@!?\d+>/);
  });

  it.each([
    ['slot', () => slotCommand.execute, { intOpt: 10 }],
    ['coinflip', () => coinflipCommand.execute, { strOpt: 'KOPF', intOpt: 10 }],
    ['dice', () => diceCommand.execute, { intOpt: 3 }],
    ['blackjack', () => blackjackCommand.execute, { intOpt: 10 }],
  ])('/%s: public Embed + allowedMentions.parse=[] + Runden-Audit-Footer', async (_name, exec, optArgs) => {
    const { i, reply } = makeInteraction(optArgs as { intOpt?: number; strOpt?: string });
    await exec()(i as never);

    expect(reply).toHaveBeenCalledTimes(1);
    const arg = reply.mock.calls[0][0] as FakeReplyArg;
    expect(arg.flags).toBeUndefined();
    expect(arg.allowedMentions).toEqual({ parse: [] });
    expect(arg.embeds).toHaveLength(1);

    const json = arg.embeds![0].toJSON();
    expect(json.description ?? '').toMatch(/Gewonnen|Verloren|Unentschieden/);
    expect(json.footer?.text ?? '').toContain('Runden-Audit');
    expect(json.footer?.text ?? '').not.toContain('Provably Fair');
    expect(json.footer?.text ?? '').toMatch(/Hash:\s+[a-f0-9]{16}/);
    expect(json.footer?.text ?? '').toMatch(/Nonce:\s+\d+/);

    const fieldsStr = JSON.stringify(json.fields);
    expect(fieldsStr).toContain('Einsatz');
    expect(fieldsStr).toContain('Auszahlung');
    expect(fieldsStr).toMatch(/Netto|Gewinn|Verlust/);
  });

  it('/slot: CasinoRound.result serialisiert BigInt payout als JSON-String', async () => {
    const { i } = makeInteraction({ intOpt: 10 });
    await slotCommand.execute(i as never);

    const roundInsert = rawExecute.mock.calls.find(
      call => typeof call[0] === 'string' && call[0].includes('INSERT INTO "CasinoRound"'),
    );
    expect(roundInsert).toBeDefined();

    const serializedResult = roundInsert![8];
    expect(typeof serializedResult).toBe('string');
    const parsed = JSON.parse(serializedResult as string) as { payout: unknown; draw: unknown };
    expect(typeof parsed.payout).toBe('string');
    expect(parsed.payout).toMatch(/^\d+$/);
    expect(typeof parsed.draw).toBe('boolean');
  });

  it('alle Casino-Commands bieten optionale Slot-Auswahl fuer Multi-Server-Guilds', () => {
    for (const command of [slotCommand, coinflipCommand, diceCommand, blackjackCommand, casinoStatsCommand]) {
      const json = command.data.toJSON();
      const slot = json.options?.find(option => option.name === 'slot');
      expect(slot).toBeDefined();
      expect(slot?.required).toBe(false);
      expect(slot?.min_value).toBe(1);
      expect(slot?.max_value).toBeGreaterThanOrEqual(1);
    }
  });
});
