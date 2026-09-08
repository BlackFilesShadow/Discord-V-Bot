/**
 * Casino V3 Discord surface tests.
 *
 * Guarantees:
 * - all eight money commands acknowledge first and finish with a public embed;
 * - allowedMentions.parse=[] is kept on the visible result;
 * - each result exposes the round audit footer/id;
 * - all commands retain optional gameserver selection;
 * - persisted result JSON keeps bigint payout JSON-safe and includes V3 audit.
 */
import { EmbedBuilder } from 'discord.js';

const NITRADO_CONN_ID = 'c123456789012345678901234';
const rawQuery = jest.fn();
const rawExecute = jest.fn();
const bookLedgerEntryInTx = jest.fn().mockResolvedValue({ id: 'ledger-1', applied: true });

jest.mock('../../src/config', () => ({ config: { security: { encryptionKey: 'test-key' } } }));

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

jest.mock('../../src/modules/economy/scopeMigration', () => ({ assertEconomyScopeReady: jest.fn().mockResolvedValue(undefined) }));

jest.mock('../../src/modules/economy/repository', () => ({
  __esModule: true,
  getConfig: jest.fn().mockResolvedValue({ emoji: ':coin:' }),
}));

jest.mock('../../src/modules/economy/ledger', () => ({
  __esModule: true,
  bookLedgerEntryInTx: (...args: unknown[]) => bookLedgerEntryInTx(...args),
}));

jest.mock('../../src/modules/economy/casinoRegistry', () => {
  const actual = jest.requireActual('../../src/modules/economy/casinoRegistry');
  return {
    ...actual,
    getCasinoGameConfig: jest.fn().mockResolvedValue({
      enabled: true,
      winChancePct: 40,
      payoutMult: 2,
      minBet: 1n,
      maxBet: 1_000_000n,
      cooldownSeconds: 0,
    }),
    ensureCasinoRoundAnchor: jest.fn().mockResolvedValue('game-1'),
  };
});

jest.mock('../../src/dashboard/socket/emitter', () => ({ emitGuildEvent: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  logAudit: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  slotCommand,
  coinflipCommand,
  diceCommand,
  blackjackCommand,
  rouletteCommand,
  highLowCommand,
  baccaratCommand,
  wheelCommand,
  casinoStatsCommand,
} from '../../src/commands/dashboard/casino';

interface FakeEditArg {
  embeds?: EmbedBuilder[];
  allowedMentions?: { parse: string[] };
}

interface NumericSlotOption {
  name: string;
  required?: boolean;
  min_value?: number;
  max_value?: number;
}

function makeInteraction(options: { strings?: Record<string, string>; integers?: Record<string, number> } = {}) {
  const editReply = jest.fn().mockResolvedValue(undefined);
  const deferReply = jest.fn().mockImplementation(async function (this: { deferred: boolean }) { this.deferred = true; });
  const followUp = jest.fn().mockResolvedValue(undefined);
  const deleteReply = jest.fn().mockResolvedValue(undefined);
  const i = {
    deferred: false,
    replied: false,
    commandName: 'casino-test',
    guildId: 'GUILD_X',
    user: {
      id: '987654321098765432',
      username: 'TestUser',
      displayAvatarURL: () => 'https://cdn/avatar.png',
    },
    options: {
      getInteger: (name: string) => options.integers?.[name] ?? (name === 'zahl' ? 3 : 10),
      getString: (name: string) => options.strings?.[name] ?? 'KOPF',
      getUser: () => null,
    },
    deferReply,
    editReply,
    followUp,
    deleteReply,
    reply: jest.fn().mockResolvedValue(undefined),
  };
  return { i, editReply, deferReply };
}

beforeEach(() => {
  jest.clearAllMocks();
  rawExecute.mockResolvedValue(1);
  rawQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: null }];
    if (sql.includes('FROM "EconomyAccount"')) return [{ walletBalance: 1_000_000n }];
    if (sql.includes('FROM "CasinoRound"')) return [];
    return [];
  });
});

const GAME_CASES = [
  ['slot', slotCommand, {}],
  ['coinflip', coinflipCommand, { strings: { seite: 'KOPF' } }],
  ['dice', diceCommand, { integers: { einsatz: 10, zahl: 3 } }],
  ['blackjack', blackjackCommand, {}],
  ['roulette', rouletteCommand, { strings: { farbe: 'ROT' } }],
  ['highlow', highLowCommand, { strings: { wahl: 'HOEHER' } }],
  ['baccarat', baccaratCommand, { strings: { seite: 'SPIELER' } }],
  ['wheel', wheelCommand, {}],
] as const;

describe('Casino V3 command embeds', () => {
  it.each(GAME_CASES)('/%s deferiert vor der Runde und liefert ein public Audit-Embed', async (_name, command, opts) => {
    const { i, editReply, deferReply } = makeInteraction(opts as never);
    await command.execute(i as never);

    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    const arg = editReply.mock.calls[0][0] as FakeEditArg;
    expect(arg.allowedMentions).toEqual({ parse: [] });
    expect(arg.embeds).toHaveLength(1);
    const json = arg.embeds![0].toJSON();
    expect(json.description ?? '').toMatch(/Gewonnen|Verloren|Unentschieden/);
    expect(json.footer?.text ?? '').toContain('Runden-Audit');
    expect(json.footer?.text ?? '').toMatch(/Hash:\s+[a-f0-9]{16}/);
    expect(json.footer?.text ?? '').toMatch(/Nonce:\s+\d+/);
    const fields = JSON.stringify(json.fields);
    expect(fields).toContain('Einsatz');
    expect(fields).toContain('Auszahlung');
    expect(fields).toContain('Audit');
  });

  it('/slot persistiert payout als JSON-string und einen V3 Regel-Snapshot', async () => {
    const { i } = makeInteraction({ integers: { einsatz: 10 } });
    await slotCommand.execute(i as never);
    const roundInsert = rawExecute.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('INSERT INTO "CasinoRound"'));
    expect(roundInsert).toBeDefined();
    const serializedResult = roundInsert![8];
    expect(typeof serializedResult).toBe('string');
    const parsed = JSON.parse(serializedResult as string) as { payout: unknown; draw: unknown; audit?: Record<string, unknown> };
    expect(typeof parsed.payout).toBe('string');
    expect(parsed.payout).toMatch(/^\d+$/);
    expect(typeof parsed.draw).toBe('boolean');
    expect(parsed.audit).toMatchObject({ type: 'SLOT', winChancePct: 40, cooldownSeconds: 0 });
    expect(parsed.audit?.serverSeedHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('alle acht Money-Commands und casino-stats bieten die optionale Slot-Auswahl', () => {
    for (const command of [...GAME_CASES.map(([, c]) => c), casinoStatsCommand]) {
      const json = command.data.toJSON();
      const slot = json.options?.find(option => option.name === 'slot') as NumericSlotOption | undefined;
      expect(slot).toBeDefined();
      expect(slot?.required).toBe(false);
      expect(slot?.min_value).toBe(1);
      expect(slot?.max_value).toBeGreaterThanOrEqual(1);
    }
  });
});
