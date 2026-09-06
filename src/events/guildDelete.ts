import { Events, Guild } from 'discord.js';
import { BotEvent } from '../types';
import prisma from '../database/prisma';
import { logger, logAudit } from '../utils/logger';

/**
 * GuildDelete wird von Discord ausgeliefert, wenn der Bot eine Guild verliert.
 * Discord liefert dabei keinen belastbaren Grund (Kick/Ban/Server-Loeschung),
 * deshalb wird bewusst nur das beobachtete Ereignis protokolliert und kein
 * Verursacher geraten.
 *
 * Der bestehende GuildProfile-Datensatz bleibt absichtlich erhalten. Er ist
 * unsere letzte bekannte Stammdaten-Evidenz und macht spaetere 11 -> 10
 * Vergleiche nachvollziehbar.
 */
const guildDeleteEvent: BotEvent = {
  name: Events.GuildDelete,
  execute: async (guild: unknown) => {
    const g = guild as Guild;
    const observedAt = new Date();

    let lastKnownProfile: {
      name: string;
      ownerId: string | null;
      ownerName: string | null;
      memberCount: number;
      lastSyncedAt: Date;
    } | null = null;

    try {
      lastKnownProfile = await prisma.guildProfile.findUnique({
        where: { guildId: g.id },
        select: {
          name: true,
          ownerId: true,
          ownerName: true,
          memberCount: true,
          lastSyncedAt: true,
        },
      });
    } catch (error) {
      logger.warn(`Guild-Leave: letzter GuildProfile-Stand fuer ${g.id} konnte nicht gelesen werden.`, error as Error);
    }

    const details = {
      gatewayEvent: Events.GuildDelete,
      observedAt: observedAt.toISOString(),
      guildName: g.name,
      ownerId: g.ownerId ?? lastKnownProfile?.ownerId ?? null,
      memberCount: Number.isFinite(g.memberCount) ? g.memberCount : (lastKnownProfile?.memberCount ?? null),
      lastKnownProfile: lastKnownProfile
        ? {
            name: lastKnownProfile.name,
            ownerId: lastKnownProfile.ownerId,
            ownerName: lastKnownProfile.ownerName,
            memberCount: lastKnownProfile.memberCount,
            lastSyncedAt: lastKnownProfile.lastSyncedAt.toISOString(),
          }
        : null,
      reason: 'UNKNOWN_NOT_PROVIDED_BY_DISCORD',
    };

    // Append-only Datei-Audit zuerst, damit selbst ein DB-Ausfall Evidenz hinterlaesst.
    logAudit('DISCORD_GUILD_LEFT', 'SYSTEM', {
      guildId: g.id,
      ...details,
    });

    // DB-Persistenz wird hier bewusst awaited. Anders als fire-and-forget Audit-
    // Aufrufe ist damit der Gateway-Handler erst fertig, wenn die immutable
    // Audit-Zeile geschrieben oder der Fehler sichtbar geloggt wurde.
    try {
      await prisma.auditLog.create({
        data: {
          action: 'DISCORD_GUILD_LEFT',
          category: 'SYSTEM',
          guildId: g.id,
          details: details as never,
          isImmutable: true,
        },
      });
    } catch (error) {
      logger.error(`Guild-Leave-Audit konnte fuer ${g.name} (${g.id}) nicht in der DB persistiert werden:`, error as Error);
    }

    logger.warn(`Discord-Guild verlassen/entfernt: ${g.name} (${g.id}). Ursache durch Discord nicht mitgeliefert.`);
  },
};

export default guildDeleteEvent;
