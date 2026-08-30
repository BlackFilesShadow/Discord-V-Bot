import fs from 'node:fs';
import path from 'node:path';
import { newDateContext, parseAdmLine } from '../../src/modules/nitrado/adm/admLineParser';
import { ingestFullFile, persistAdmEvents } from '../../src/modules/nitrado/adm/serverLogIngestor';
import { buildGameplayFeedEmbed, flagObjectLabel } from '../../src/modules/gameplayFeeds/embedBuilder';
import { categoryForEvent, kindForEvent } from '../../src/modules/gameplayFeeds/types';
import {
  buildFlagActivityCustomId,
  horizontalDistanceMeters,
  parseHorizontalPosition,
  verifyFlagActivityCustomId,
} from '../../src/modules/gameplayFeeds/flagActivity';

describe('Flag activity feeds', () => {
  test('parses raised territory flag with actor and separate flag coordinates', () => {
    const ctx = newDateContext(new Date(Date.UTC(2026, 7, 29)));
    const event = parseAdmLine(
      '12:42:51 | Player "Survivor One" (id=abc123 pos=<9662.8, 294.2, 8788.5>) has raised Flag_Base on TerritoryFlag at <9663.22, 294.33, 8789.84>',
      ctx,
    );

    expect(event).toMatchObject({
      eventType: 'FLAG_RAISED',
      actorGameId: 'abc123',
      actorName: 'Survivor One',
      actorPosition: '9662.8, 294.2, 8788.5',
      objectType: 'Flag_Base',
      targetName: 'TerritoryFlag',
      targetPosition: '9663.22, 294.33, 8789.84',
      parseStatus: 'OK',
    });
  });

  test('parses lowered territory flag without confusing it with build events', () => {
    const ctx = newDateContext(new Date(Date.UTC(2026, 7, 29)));
    const event = parseAdmLine(
      '12:45:03 | Player "Survivor Two" (id=xyz789 pos=<100.1, 4.2, 200.3>) has lowered Flag_Base on TerritoryFlag at <101.5, 4.0, 201.8>',
      ctx,
    );

    expect(event?.eventType).toBe('FLAG_LOWERED');
    expect(event?.objectType).toBe('Flag_Base');
    expect(categoryForEvent(event!.eventType)).toBe('LOWERED');
    expect(kindForEvent(event!.eventType)).toBe('FLAG');
  });

  test('normalizes 3D positions to horizontal X/Z and calculates distance without using height', () => {
    expect(parseHorizontalPosition('9662.8, 294.2, 8788.5')).toEqual({ x: 9662.8, z: 8788.5 });
    expect(parseHorizontalPosition('10, 20')).toEqual({ x: 10, z: 20 });
    expect(parseHorizontalPosition('invalid')).toBeNull();
    expect(horizontalDistanceMeters('0, 999, 0', '3, 1, 4')).toBe(5);
  });

  test('signed analysis button accepts only the untampered event reference', () => {
    const eventId = 'cabcdefghijklmnopqrstuvwx';
    const customId = buildFlagActivityCustomId(eventId);
    expect(customId).toMatch(/^flagshort:v1:c[a-z0-9]{24}:[a-f0-9]{20}$/);
    expect(verifyFlagActivityCustomId(customId)).toBe(eventId);
    const tampered = customId.endsWith('0')
      ? `${customId.slice(0, -1)}1`
      : `${customId.slice(0, -1)}0`;
    expect(verifyFlagActivityCustomId(tampered)).toBeNull();
    expect(verifyFlagActivityCustomId('flagshort:v1:invalid:deadbeef')).toBeNull();
  });

  test('persists flag raw event compatibly and canonical flag domain idempotently', async () => {
    const input = [
      'AdminLog started on 2026-08-29',
      '12:42:51 | Player "Survivor" (id=game-a pos=<1, 2, 3>) has raised Flag_Base on TerritoryFlag at <4, 5, 6>',
      '',
    ].join('\n');
    const result = ingestFullFile(input, 0, { fileName: 'ADM_2026-08-29.log' });
    const admRows: any[] = [];
    const flagRows: any[] = [];
    const client: any = {
      admEvent: {
        createMany: async ({ data }: any) => {
          admRows.push(...data);
          return { count: data.length };
        },
      },
      flagActivityEvent: {
        createMany: async ({ data }: any) => {
          flagRows.push(...data);
          return { count: data.length };
        },
      },
      admSourceCursor: { upsert: async () => ({}) },
      $transaction: async (fn: any) => fn(client),
    };

    await persistAdmEvents(client, { guildId: 'guild-a', nitradoConnId: 'conn-a' }, {
      fileIdentity: 'file-a',
      fileName: 'ADM_2026-08-29.log',
      lastModifiedAt: 1,
      fileSize: Buffer.byteLength(input),
    }, result, null);

    expect(admRows).toHaveLength(1);
    expect(admRows[0].eventType).toBe('UNKNOWN');
    expect(flagRows).toHaveLength(1);
    expect(flagRows[0]).toMatchObject({
      action: 'RAISED',
      actorGameId: 'game-a',
      actorName: 'Survivor',
      actorPosition: '1, 2, 3',
      flagType: 'Flag_Base',
      flagPosition: '4, 5, 6',
    });
    expect(flagRows[0].eventKey).toBe(admRows[0].eventKey);
  });

  test('renders raised flag activity as a readable Discord embed while retaining the classname', () => {
    expect(flagObjectLabel('Flag_RSTA')).toBe('RSTA');
    const embed = buildGameplayFeedEmbed({
      eventId: 'flag-raised-1',
      kind: 'FLAG',
      category: 'RAISED',
      eventType: 'FLAG_RAISED',
      occurredAt: new Date('2026-08-30T12:36:44.000Z'),
      actorName: 'JtReaper',
      targetName: 'TerritoryFlag',
      objectType: 'Flag_RSTA',
      toolOrWeapon: null,
      distanceMeters: null,
      actorPosition: '9713.25, 167.81, 13149.40',
      targetPosition: '9714.855469, 168.180801, 13150.735352',
    }, '#22c55e', 'Die Chaoten').toJSON();

    expect(embed.title).toBe('🚩 Flagge hochgezogen');
    expect(embed.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Aktion', value: 'Hochgezogen' }),
      expect.objectContaining({ name: 'Spieler', value: 'JtReaper' }),
      expect.objectContaining({ name: 'Flagge', value: 'RSTA\nClassname: `Flag_RSTA`' }),
      expect.objectContaining({ name: 'Flaggen-Position', value: 'X: 9714.86 • Z: 13150.74\nHöhe: 168.18' }),
      expect.objectContaining({ name: 'Spieler-Position', value: 'X: 9713.25 • Z: 13149.4\nHöhe: 167.81' }),
      expect.objectContaining({ name: 'Server', value: 'Die Chaoten' }),
      expect.objectContaining({ name: 'Ereigniszeit', value: '<t:1788093404:F>' }),
    ]));
  });

  test('renders lowered flag activity with the matching action and title', () => {
    const embed = buildGameplayFeedEmbed({
      eventId: 'flag-lowered-1',
      kind: 'FLAG',
      category: 'LOWERED',
      eventType: 'FLAG_LOWERED',
      occurredAt: new Date('2026-08-30T12:43:08.000Z'),
      actorName: 'Survivor Two',
      targetName: 'TerritoryFlag',
      objectType: 'Flag_Base',
      toolOrWeapon: null,
      distanceMeters: null,
      actorPosition: null,
      targetPosition: '9663.215820, 294.325684, 8789.842773',
    }, '#eab308', 'Die Chaoten').toJSON();

    expect(embed.title).toBe('🏳️ Flagge heruntergelassen');
    expect(embed.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Aktion', value: 'Heruntergelassen' }),
      expect.objectContaining({ name: 'Flagge', value: 'Base\nClassname: `Flag_Base`' }),
      expect.objectContaining({ name: 'Flaggen-Position', value: 'X: 9663.22 • Z: 8789.84\nHöhe: 294.33' }),
    ]));
  });

  test('architecture keeps raised/lowered separate and wires signed analysis button', () => {
    const root = path.resolve(__dirname, '../..');
    const route = fs.readFileSync(path.join(root, 'src/dashboard/routes/v2/killfeed.ts'), 'utf8');
    const runtime = fs.readFileSync(path.join(root, 'src/modules/gameplayFeeds/runtime.ts'), 'utf8');
    const composite = fs.readFileSync(path.join(root, 'src/events/interactionCreateComposite.ts'), 'utf8');
    const ui = fs.readFileSync(path.join(root, 'dashboard-ui/src/components/KillfeedTab.tsx'), 'utf8');

    expect(route).toContain("kind === 'FLAG' && categories.length !== 1");
    expect(runtime).toContain('buildFlagActivityCustomId(event.id)');
    expect(runtime).toContain(".setLabel('Kurz-Online prüfen')");
    expect(composite).toContain('flagshort:v1:');
    expect(ui).toContain('🚩 Flaggen-Feed');
    expect(ui).toContain('Flagge hoch');
    expect(ui).toContain('Flagge runter');
  });
});
