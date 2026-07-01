// Setze minimal nötige ENV-Variablen für config.ts (defensiv; .env liefert
// diese im Container bereits).
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { config } from '../../src/config';
import { isBotOwner, ownerBypassApplies } from '../../src/events/interactionCreate';

// P0-Sicherheits-Regression: Ein Discord-Guild-Owner darf devOnly-Commands
// NICHT ohne Dev-Passwort/Session umgehen. Nur der Bot-Owner (BOT_OWNER_ID)
// darf devOnly umgehen. adminOnly darf weiterhin von Bot-Owner UND Guild-Owner
// umgangen werden; manufacturerOnly von niemandem.
describe('devOnly permission gate (P0 security regression)', () => {
  const BOT_OWNER = '111111111111111111';
  const GUILD_OWNER = '222222222222222222';
  const RANDOM_USER = '333333333333333333';

  let originalOwnerId: string;

  beforeAll(() => {
    originalOwnerId = config.discord.ownerId;
    (config.discord as { ownerId: string }).ownerId = BOT_OWNER;
  });

  afterAll(() => {
    (config.discord as { ownerId: string }).ownerId = originalOwnerId;
  });

  describe('isBotOwner', () => {
    it('erkennt nur den Bot-Owner (BOT_OWNER_ID)', () => {
      expect(isBotOwner(BOT_OWNER)).toBe(true);
      expect(isBotOwner(GUILD_OWNER)).toBe(false);
      expect(isBotOwner(RANDOM_USER)).toBe(false);
    });
  });

  describe('ownerBypassApplies – devOnly', () => {
    it('lässt NIEMANDEN devOnly per Owner/Guild-Owner-Bypass umgehen', () => {
      // Bot-Owner: der devOnly-Bypass läuft NICHT über diese Funktion,
      // sondern separat über isBotOwner. ownerBypassApplies muss false liefern.
      expect(ownerBypassApplies({ devOnly: true }, BOT_OWNER, BOT_OWNER)).toBe(false);
      // Guild-Owner darf devOnly definitiv NICHT umgehen.
      expect(ownerBypassApplies({ devOnly: true }, GUILD_OWNER, GUILD_OWNER)).toBe(false);
      // Zufälliger User ebenfalls nicht.
      expect(ownerBypassApplies({ devOnly: true }, RANDOM_USER, GUILD_OWNER)).toBe(false);
    });

    it('Guild-Owner erhält KEINEN devOnly-Bypass über isBotOwner', () => {
      expect(isBotOwner(GUILD_OWNER)).toBe(false);
    });
  });

  describe('ownerBypassApplies – adminOnly', () => {
    it('Bot-Owner umgeht adminOnly', () => {
      expect(ownerBypassApplies({}, BOT_OWNER, null)).toBe(true);
      expect(ownerBypassApplies({ devOnly: false, manufacturerOnly: false }, BOT_OWNER, GUILD_OWNER)).toBe(true);
    });

    it('Guild-Owner umgeht adminOnly', () => {
      expect(ownerBypassApplies({}, GUILD_OWNER, GUILD_OWNER)).toBe(true);
    });

    it('normaler User (nicht Guild-Owner) umgeht adminOnly NICHT', () => {
      expect(ownerBypassApplies({}, RANDOM_USER, GUILD_OWNER)).toBe(false);
      expect(ownerBypassApplies({}, RANDOM_USER, null)).toBe(false);
    });
  });

  describe('ownerBypassApplies – manufacturerOnly', () => {
    it('lässt NIEMANDEN manufacturerOnly umgehen', () => {
      expect(ownerBypassApplies({ manufacturerOnly: true }, BOT_OWNER, BOT_OWNER)).toBe(false);
      expect(ownerBypassApplies({ manufacturerOnly: true }, GUILD_OWNER, GUILD_OWNER)).toBe(false);
      expect(ownerBypassApplies({ manufacturerOnly: true }, RANDOM_USER, GUILD_OWNER)).toBe(false);
    });
  });
});
