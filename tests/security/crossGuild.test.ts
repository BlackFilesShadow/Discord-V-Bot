/**
 * Cross-Guild-Isolation-Pen-Tests (Spec §5).
 *
 * Verifiziert direkt den Verhaltens-Fix vom Audit-Lauf:
 *   - whitelistApprovalButton: Klick aus Guild-B auf Whitelist-Request aus
 *     Guild-A muss als "nicht gefunden" abgewiesen werden, NICHT erst spaeter
 *     "gehoert nicht zu dieser Guild".
 *   - isValidBattleyeGuid filtert Muell-IDs aus dem GUID-strict Pfad.
 *
 * Diese Tests sind absichtlich auf die Spec-relevanten Verhaltens-Garantien
 * fokussiert (kein "alle 60 Stellen testen", sondern die echten Risikoquellen).
 */

const findUnique = jest.fn();
const updateMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    whitelistRequest: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
    guildPermissionGrant: {
      findUnique: jest.fn().mockResolvedValue({ permissions: ['whitelist.manage'] }),
    },
  },
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  client: jest.fn().mockReturnValue(null),
}));

import { isValidBattleyeGuid } from '../../src/utils/guid';
import { parseAdm } from '../../src/dashboard/services/admParser';
import { handleWhitelistApprovalButton } from '../../src/modules/whitelist/whitelistApprovalButton';

beforeEach(() => {
  findUnique.mockReset();
  updateMany.mockReset();
});

describe('Cross-Guild-Isolation Pen-Tests', () => {
  // Verhaltens-Aequivalent: vorher reichte "id" allein und der nachgelagerte
  // ownership-Check entschied — heute MUSS der DB-Query selbst guildId
  // erzwingen. Das beweisen wir via Inspection des Query-Args.
  it('whitelistApprovalButton.findUnique enthaelt guildId im where', async () => {
    findUnique.mockResolvedValue(null);
    const fakeBtn = {
      customId: 'wlreq:a:abc-123',
      guildId: 'GUILD_B',
      guild: { ownerId: 'mod-1' },
      user: { id: 'mod-1' },
      memberPermissions: { has: () => true },
      reply: jest.fn().mockResolvedValue(undefined),
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      message: { edit: jest.fn().mockResolvedValue(undefined) },
      followUp: jest.fn().mockResolvedValue(undefined),
    };
    await handleWhitelistApprovalButton(fakeBtn as never);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'abc-123', guildId: 'GUILD_B' },
    });
  });

  it('whitelistApprovalButton.updateMany (CAS) enthaelt guildId im where', async () => {
    findUnique.mockResolvedValue({
      id: 'abc-123', guildId: 'GUILD_B', nitradoConnId: 'slot1',
      gameId: 'PlayerX', requesterDiscordId: 'req1', status: 'PENDING',
    });
    updateMany.mockResolvedValue({ count: 0 }); // CAS verfehlt -> sauberer Abbruch
    const fakeBtn = {
      customId: 'wlreq:a:abc-123',
      guildId: 'GUILD_B',
      guild: { ownerId: 'mod-1' },
      user: { id: 'mod-1' },
      memberPermissions: { has: () => true },
      reply: jest.fn().mockResolvedValue(undefined),
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      message: { edit: jest.fn().mockResolvedValue(undefined) },
      followUp: jest.fn().mockResolvedValue(undefined),
    };
    await handleWhitelistApprovalButton(fakeBtn as never);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'abc-123', guildId: 'GUILD_B', status: 'PENDING' }),
    }));
  });
});

describe('GUID-strict Pen-Tests (Spec §13)', () => {
  it('isValidBattleyeGuid lehnt klassische Injection-Payloads ab', () => {
    expect(isValidBattleyeGuid("' OR 1=1 --")).toBe(false);
    expect(isValidBattleyeGuid('<script>alert(1)</script>')).toBe(false);
    expect(isValidBattleyeGuid('../../etc/passwd')).toBe(false);
    expect(isValidBattleyeGuid('${jndi:ldap://x}')).toBe(false);
    expect(isValidBattleyeGuid('\u0000nullbyte')).toBe(false);
  });

  it('parseAdm: Eintraege mit Muell-GUID landen in unknownPlayerEvents, NICHT in guidEvents', () => {
    const adm = [
      'AdminLog started on 2026-04-21 at 18:30:14',
      '18:31:02 | Player "Max" (id=ab12cd34ef56gh78ij90 pos=<7456.1, 8123.2, 0.0>) connected',
      '18:31:05 | Player "Hacker" (id=Unknown pos=<0.0, 0.0, 0.0>) connected',
      '18:31:06 | Player "NoId" (id= pos=<0.0, 0.0, 0.0>) connected',
    ].join('\n');
    const r = parseAdm(adm);
    expect(r.guidEvents.length).toBe(1); // nur Max
    expect(r.guidEvents[0].actor.name).toBe('Max');
    expect(r.unknownPlayerEvents).toBeGreaterThanOrEqual(2);
  });
});
