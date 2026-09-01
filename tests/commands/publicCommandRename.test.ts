import { canonicalDiscordCommandName, PUBLIC_COMMAND_RENAMES } from '../../src/commands/handler';
import { SPEC_KEEP_COMMANDS } from '../../src/commands/inventory';

const expected = {
  whitelist: 'whitelist-antrag',
  'wl-add': 'whitelist-add',
  'wl-remove': 'whitelist-remove',
} as const;

describe('public command name migration', () => {
  it('mappt die drei Whitelist-Legacy-Namen exakt auf die Produktnamen', () => {
    expect(PUBLIC_COMMAND_RENAMES).toEqual(expected);
    for (const [legacy, canonical] of Object.entries(expected)) {
      expect(canonicalDiscordCommandName(legacy)).toBe(canonical);
    }
  });

  it('veraendert alle anderen Command-Namen nicht', () => {
    expect(canonicalDiscordCommandName('server-ban')).toBe('server-ban');
    expect(canonicalDiscordCommandName('help')).toBe('help');
  });

  it('fuehrt im Zielinventar nur die kanonischen Whitelist-Namen', () => {
    for (const canonical of Object.values(expected)) expect(SPEC_KEEP_COMMANDS.has(canonical)).toBe(true);
    for (const legacy of Object.keys(expected)) {
      if (legacy === 'whitelist') continue;
      expect(SPEC_KEEP_COMMANDS.has(legacy)).toBe(false);
    }
    expect(SPEC_KEEP_COMMANDS.has('whitelist-antrag')).toBe(true);
    expect(SPEC_KEEP_COMMANDS.has('server-ban-list')).toBe(false);
  });
});
