/**
 * Tests für den Anonymisierungs-Layer. Sichern die User-Vorgabe:
 * "Server-Bezogene Daten (Name, IP, Whitelist, Bannlist) müssen anonym bleiben."
 */

import {
  redactText,
  redactValue,
  redactObject,
  isSensitiveKey,
  PLACEHOLDER,
} from '../../src/modules/nitrado/mirror/redactor';

describe('redactor.redactText', () => {
  test('maskiert IPv4 + Port', () => {
    const out = redactText('Server läuft auf 178.104.206.148:2302');
    expect(out).not.toContain('178.104.206.148');
    expect(out).toContain(PLACEHOLDER.ip);
  });

  test('maskiert Steam64', () => {
    const out = redactText('Spieler 76561198012345678 hat sich verbunden.');
    expect(out).toContain(PLACEHOLDER.steam64);
    expect(out).not.toContain('76561198012345678');
  });

  test('maskiert BattlEye GUID (32 hex)', () => {
    const guid = 'a'.repeat(32);
    const out = redactText(`GUID: ${guid}`);
    expect(out).not.toContain(guid);
    expect(out).toContain(PLACEHOLDER.guid);
  });

  test('maskiert DayZ-Console-ID mit = Padding', () => {
    const id = 'K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=';
    const out = redactText(`Konsolen-ID: ${id}`);
    expect(out).not.toContain(id);
    expect(out).toContain(PLACEHOLDER.guid);
  });

  test('lässt einfache Klassen-Namen wie AKM in Ruhe', () => {
    const out = redactText('Items: AKM, Mosin, M4A1');
    expect(out).toContain('AKM');
    expect(out).toContain('Mosin');
  });

  test('maskiert konkreten Server-Namen wenn übergeben', () => {
    const out = redactText('Willkommen auf Phoenix-Server!', { serverName: 'Phoenix-Server' });
    expect(out).not.toContain('Phoenix-Server');
    expect(out).toContain(PLACEHOLDER.server);
  });
});

describe('redactor.isSensitiveKey', () => {
  test.each([
    ['hostname', true],
    ['rconPassword', true],
    ['whitelist', true],
    ['priority', true],
    ['admins', true],
    ['banlist', true],
    ['ipAddress', true],
    ['queryPort', true],
    ['serverTimeAcceleration', false],
    ['maxPlayers', false],
    ['mission', false],
  ])('Key %s -> sensitive %s', (k, expected) => {
    expect(isSensitiveKey(k)).toBe(expected);
  });
});

describe('redactor.redactValue / redactObject', () => {
  test('whitelist-String mit mehreren Zeilen wird zu Listen-Platzhalter', () => {
    const v = redactValue('whitelist', '76561198000000001\n76561198000000002\n76561198000000003');
    expect(String(v)).toContain(PLACEHOLDER.list);
    expect(String(v)).toContain('3');
  });

  test('Passwort-Wert wird komplett ersetzt', () => {
    const v = redactValue('rconPassword', 'super-secret-123');
    expect(v).toBe(PLACEHOLDER.password);
  });

  test('verschachteltes Settings-Objekt wird rekursiv geredacted', () => {
    const obj = {
      general: {
        hostname: 'Phoenix DayZ',
        maxPlayers: 60,
        rconPassword: 'changeme',
        whitelist: 'a\nb\nc',
        serverTimeAcceleration: 12,
      },
      query: {
        ip: '178.104.206.148',
        port: 27016,
      },
    };
    const r = redactObject(obj);
    expect((r.general as Record<string, unknown>).hostname).toBe(PLACEHOLDER.server);
    expect((r.general as Record<string, unknown>).maxPlayers).toBe(60);
    expect((r.general as Record<string, unknown>).serverTimeAcceleration).toBe(12);
    expect((r.general as Record<string, unknown>).rconPassword).toBe(PLACEHOLDER.password);
    expect(String((r.general as Record<string, unknown>).whitelist)).toContain(PLACEHOLDER.list);
    expect((r.query as Record<string, unknown>).ip).toBe(PLACEHOLDER.ip);
    expect((r.query as Record<string, unknown>).port).toBe(PLACEHOLDER.port);
  });

  test('funktionale Keys (timeAcceleration, maxPlayers) bleiben unverändert', () => {
    expect(redactValue('serverTimeAcceleration', 12)).toBe(12);
    expect(redactValue('maxPlayers', 60)).toBe(60);
    expect(redactValue('mission', 'dayzOffline.chernarusplus')).toBe('dayzOffline.chernarusplus');
  });
});
