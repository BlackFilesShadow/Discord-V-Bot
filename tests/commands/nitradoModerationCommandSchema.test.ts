import {
  serverBanCommand,
  serverUnbanCommand,
} from '../../src/commands/dashboard/serverBan';
import {
  whitelistCommand,
  wlAddCommand,
  wlRemoveCommand,
} from '../../src/commands/dashboard/whitelist';

function option(command: { data: { toJSON: () => any } }, name: string): any {
  return command.data.toJSON().options?.find((o: any) => o.name === name);
}

describe('Nitrado moderation command schema', () => {
  it('/server-ban braucht nur den Gameserver-Identifier, keinen Discord-Link', () => {
    const json = serverBanCommand.data.toJSON();
    expect(json.options?.some((o: any) => o.name === 'user')).toBe(false);
    expect(option(serverBanCommand, 'identifier')).toEqual(expect.objectContaining({ required: true }));
  });

  it('Ban und Unban waehlen Server per Alias-Autocomplete und lassen Auswahl optional', () => {
    for (const command of [serverBanCommand, serverUnbanCommand]) {
      expect(option(command, 'slot')).toEqual(expect.objectContaining({
        required: false,
        autocomplete: true,
        type: 3,
      }));
      expect(command.autocomplete).toBeDefined();
    }
    expect(option(serverUnbanCommand, 'identifier')).toEqual(expect.objectContaining({ required: true }));
  });

  it('Whitelist-Verwaltung verwendet dieselbe Alias-Auswahl', () => {
    for (const command of [whitelistCommand, wlAddCommand, wlRemoveCommand]) {
      expect(option(command, 'slot')).toEqual(expect.objectContaining({
        required: false,
        autocomplete: true,
        type: 3,
      }));
      expect(command.autocomplete).toBeDefined();
    }
  });

  it('lässt Listenanzeige bewusst den festen Kanal-Katalogen', () => {
    const serverBanSource = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../src/commands/dashboard/serverBan.ts'), 'utf8');
    const whitelistSource = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../src/commands/dashboard/whitelist.ts'), 'utf8');
    expect(serverBanSource).not.toContain('serverBanListCommand');
    expect(whitelistSource).not.toContain('wlListCommand');
  });
});
