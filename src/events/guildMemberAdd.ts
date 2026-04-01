import { Events, GuildMember } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import prisma from '../database/prisma';
import { generateGuid } from '../utils/guid';
import { detectRaid } from '../utils/rateLimiter';

// Anti-Raid: Speichert Join-Timestamps
const recentJoins: Map<string, number[]> = new Map();

/**
 * GuildMemberAdd-Event: Neuer Nutzer tritt bei.
 * Sektion 1: GUID-Vergabe, Sektion 9: Auto-Rollen.
 */
const guildMemberAddEvent: BotEvent = {
  name: Events.GuildMemberAdd,
  execute: async (member: unknown) => {
    const m = member as GuildMember;

    // Anti-Raid Detection (Sektion 4)
    const guildId = m.guild.id;
    const now = Date.now();
    const joins = recentJoins.get(guildId) || [];
    joins.push(now);
    // Nur Joins der letzten 10 Sekunden behalten
    const recentWindow = joins.filter(t => now - t < 10000);
    recentJoins.set(guildId, recentWindow);

    const isRaid = await detectRaid(guildId, recentWindow.length);
    if (isRaid) {
      logger.warn(`🚨 RAID ERKANNT auf Server ${guildId}! ${recentWindow.length} Joins in 10s.`);
      // Hier könnte automatisches Lockdown implementiert werden
    }

    try {
      // User in DB registrieren mit GUID (Sektion 1)
      const user = await prisma.user.upsert({
        where: { discordId: m.user.id },
        create: {
          discordId: m.user.id,
          username: m.user.username,
          discriminator: m.user.discriminator || '',
        },
        update: {
          username: m.user.username,
          discriminator: m.user.discriminator || '',
        },
      });

      // Level-Data initialisieren (Sektion 8)
      await prisma.levelData.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      });

      // GDPR Consent Entry (Sektion 4: DSGVO)
      await prisma.gdprConsent.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      });

      // Auto-Rollen vergeben (Sektion 9: Rollen nach Beitritt)
      const autoRoles = await prisma.autoRole.findMany({
        where: { triggerType: 'JOIN', isActive: true },
      });

      for (const autoRole of autoRoles) {
        // Prüfe Ablaufdatum
        if (autoRole.expiresAt && autoRole.expiresAt < new Date()) continue;

        try {
          await m.roles.add(autoRole.roleId, 'Auto-Rolle bei Beitritt');

          await prisma.userRoleAssignment.create({
            data: {
              userId: user.id,
              roleId: autoRole.roleId,
              assignedBy: 'auto',
              reason: 'Auto-Rolle bei Server-Beitritt',
              expiresAt: autoRole.expiresAt,
            },
          });
        } catch (roleError) {
          logger.error(`Auto-Rolle ${autoRole.roleId} konnte nicht vergeben werden:`, roleError);
        }
      }

      // Audit-Log
      logAudit('MEMBER_JOIN', 'SYSTEM', {
        userId: user.id,
        discordId: m.user.id,
        username: m.user.username,
        guildId: m.guild.id,
        autoRolesAssigned: autoRoles.length,
      });

      logger.info(`Neuer Nutzer: ${m.user.username} (GUID: ${user.id})`);
    } catch (error) {
      logger.error(`Fehler bei guildMemberAdd für ${m.user.username}:`, error);
    }
  },
};

export default guildMemberAddEvent;
