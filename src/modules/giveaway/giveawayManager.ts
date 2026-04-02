import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import crypto from 'crypto';

/**
 * Giveaway-Manager (Sektion 6):
 * - Giveaway-Command mit frei wählbarem Item-/Gegenstandsnamen
 * - Teilnehmerverwaltung (Reaktion oder Command, DSGVO-konform)
 * - Echtzeit-Timer, Embed mit verbleibender Zeit
 * - Automatische Gewinnerermittlung
 * - Mehrfachteilnahme verhindert (unique constraint)
 * - Logging aller Aktionen
 * - Erweiterbar: Mehrfachgewinne, Blacklist, Mindestrollen, Custom-Emojis
 */

/**
 * Neues Giveaway erstellen.
 */
export async function createGiveaway(params: {
  creatorDiscordId: string;
  channelId: string;
  prize: string;
  description?: string;
  durationSeconds: number;
  winnerCount?: number;
  minRole?: string;
  blacklistRoles?: string[];
  customEmoji?: string;
  notifyRoleId?: string;
}): Promise<{ success: boolean; giveawayId?: string; message: string }> {
  const creator = await prisma.user.findUnique({
    where: { discordId: params.creatorDiscordId },
  });

  if (!creator) {
    return { success: false, message: 'User nicht registriert.' };
  }

  const endsAt = new Date(Date.now() + params.durationSeconds * 1000);

  const giveaway = await prisma.giveaway.create({
    data: {
      creatorId: creator.id,
      channelId: params.channelId,
      prize: params.prize,
      description: params.description,
      duration: params.durationSeconds,
      endsAt,
      winnerCount: params.winnerCount || 1,
      minRole: params.minRole,
      blacklistRoles: params.blacklistRoles || undefined,
      customEmoji: params.customEmoji || '🎉',
      notifyRoleId: params.notifyRoleId,
    },
  });

  logAudit('GIVEAWAY_CREATED', 'GIVEAWAY', {
    giveawayId: giveaway.id,
    creatorId: creator.id,
    prize: params.prize,
    duration: params.durationSeconds,
    endsAt: endsAt.toISOString(),
  });

  return {
    success: true,
    giveawayId: giveaway.id,
    message: 'Giveaway erstellt.',
  };
}

/**
 * Giveaway-Embed erstellen mit Echtzeit-Timer.
 */
export function createGiveawayEmbed(giveaway: {
  prize: string;
  description?: string | null;
  endsAt: Date;
  creatorId?: string;
  customEmoji?: string | null;
  status: string;
  winnerId?: string | null;
  winnerCount?: number;
}, participantCount: number, creatorUsername?: string): EmbedBuilder {
  const emoji = giveaway.customEmoji || '🎉';
  const timeLeft = giveaway.endsAt.getTime() - Date.now();
  const isActive = giveaway.status === 'ACTIVE' && timeLeft > 0;

  const embed = vEmbed(isActive ? Colors.Giveaway : Colors.Neutral)
    .setTitle(`🎉  GIVEAWAY`);

  const descParts: string[] = [];
  if (giveaway.description) descParts.push(`> ${giveaway.description}`);
  descParts.push(Brand.divider);
  descParts.push(`\n🏆 **Preis:** ${giveaway.prize}`);

  if (isActive) {
    descParts.push(`⏰ **Endet:** <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>`);
    descParts.push(`👥 **Teilnehmer:** ${participantCount}`);
    if (creatorUsername) descParts.push(`🎁 **Von:** ${creatorUsername}`);
    descParts.push(`\n${Brand.divider}`);
    descParts.push(`\n*Reagiere mit ${emoji} um teilzunehmen!*`);
  } else {
    descParts.push(`👥 **Teilnehmer:** ${participantCount}`);
    if (creatorUsername) descParts.push(`🎁 **Von:** ${creatorUsername}`);
    descParts.push(`\n${Brand.divider}`);
    descParts.push(`\n*Giveaway beendet*`);
  }

  embed.setDescription(descParts.join('\n'));
  embed.setFooter({ text: `${Brand.footerText} ${Brand.dot} Giveaway` });

  return embed;
}

/**
 * Teilnehmer per Command hinzufügen.
 */
export async function enterGiveaway(
  giveawayId: string,
  userDiscordId: string
): Promise<{ success: boolean; message: string }> {
  const giveaway = await prisma.giveaway.findUnique({
    where: { id: giveawayId },
  });

  if (!giveaway) {
    return { success: false, message: 'Giveaway nicht gefunden.' };
  }

  if (giveaway.status !== 'ACTIVE' || giveaway.endsAt <= new Date()) {
    return { success: false, message: 'Giveaway ist nicht mehr aktiv.' };
  }

  const user = await prisma.user.findUnique({
    where: { discordId: userDiscordId },
  });

  if (!user) {
    return { success: false, message: 'User nicht registriert.' };
  }

  // Mehrfachteilnahme verhindern (unique constraint)
  try {
    await prisma.giveawayEntry.create({
      data: {
        giveawayId,
        userId: user.id,
      },
    });
  } catch {
    return { success: false, message: 'Du nimmst bereits teil!' };
  }

  logAudit('GIVEAWAY_ENTER', 'GIVEAWAY', {
    giveawayId,
    userId: user.id,
  });

  return { success: true, message: 'Du nimmst jetzt teil! 🎉' };
}

/**
 * Gewinner ziehen (kryptografisch sicher).
 */
export async function drawWinners(giveawayId: string): Promise<{
  success: boolean;
  winners: { id: string; discordId: string; username: string }[];
  message: string;
}> {
  const giveaway = await prisma.giveaway.findUnique({
    where: { id: giveawayId },
    include: {
      entries: {
        include: { user: { select: { id: true, discordId: true, username: true } } },
      },
    },
  });

  if (!giveaway) {
    return { success: false, winners: [], message: 'Giveaway nicht gefunden.' };
  }

  if (giveaway.entries.length === 0) {
    await prisma.giveaway.update({
      where: { id: giveawayId },
      data: { status: 'ENDED' },
    });
    return { success: false, winners: [], message: 'Keine Teilnehmer.' };
  }

  // Gewinner kryptografisch sicher ziehen
  const entryPool = [...giveaway.entries];
  const winners: { id: string; discordId: string; username: string }[] = [];
  const winnerCount = Math.min(giveaway.winnerCount, entryPool.length);

  for (let i = 0; i < winnerCount; i++) {
    const randomIndex = crypto.randomInt(entryPool.length);
    const winner = entryPool.splice(randomIndex, 1)[0];
    winners.push(winner.user);

    // Winner markieren
    await prisma.giveawayEntry.update({
      where: { id: winner.id },
      data: { isWinner: true },
    });
  }

  // Giveaway als beendet markieren
  await prisma.giveaway.update({
    where: { id: giveawayId },
    data: {
      status: 'ENDED',
      winnerId: winners[0]?.id,
    },
  });

  logAudit('GIVEAWAY_DRAWN', 'GIVEAWAY', {
    giveawayId,
    prize: giveaway.prize,
    winners: winners.map(w => w.discordId),
    participantCount: giveaway.entries.length,
  });

  return {
    success: true,
    winners,
    message: `Gewinner gezogen! ${winners.map(w => w.username).join(', ')}`,
  };
}

/**
 * Giveaway-Scheduler: Prüft und beendet abgelaufene Giveaways.
 * Sektion 6: Automatische Gewinnerermittlung nach Ablauf.
 */
export function startGiveawayScheduler(client: Client): void {
  const CHECK_INTERVAL = 10000; // Alle 10 Sekunden

  setInterval(async () => {
    try {
      const expiredGiveaways = await prisma.giveaway.findMany({
        where: {
          status: 'ACTIVE',
          endsAt: { lte: new Date() },
        },
      });

      for (const giveaway of expiredGiveaways) {
        const result = await drawWinners(giveaway.id);
        const participantCount = await prisma.giveawayEntry.count({
          where: { giveawayId: giveaway.id },
        });

        // Embed im Channel aktualisieren
        try {
          const channel = await client.channels.fetch(giveaway.channelId) as TextChannel;
          if (!channel) continue;

          const winnerEmbed = vEmbed(Colors.Success)
            .setTitle(`🎉  GIVEAWAY BEENDET`)
            .setFooter({ text: `${Brand.footerText} ${Brand.dot} Giveaway` });

          if (giveaway.description) {
            winnerEmbed.setDescription(giveaway.description);
          }

          if (result.success && result.winners.length > 0) {
            const winnerMentions = result.winners.map(w => `<@${w.discordId}>`).join(', ');
            winnerEmbed.setDescription(
              `${Brand.divider}\n\n` +
              `🏆 **Preis:** ${giveaway.prize}\n` +
              `🎊 **Gewinner:** ${winnerMentions}\n` +
              `👥 **Teilnehmer:** ${participantCount}\n\n` +
              (giveaway.description ? `> ${giveaway.description}\n\n` : '') +
              Brand.divider
            );

            // Rollen-Ping + Gewinner-Erwähnung
            const rolePing = giveaway.notifyRoleId ? `<@&${giveaway.notifyRoleId}> ` : '';
            await channel.send({
              content: `${rolePing}🎉 Glückwunsch ${winnerMentions}! Du hast **${giveaway.prize}** gewonnen!`,
              embeds: [winnerEmbed],
            });
          } else {
            winnerEmbed.setDescription(
              `${Brand.divider}\n\n` +
              `🏆 **Preis:** ${giveaway.prize}\n` +
              `😢 **Ergebnis:** Keine Teilnehmer\n\n` +
              (giveaway.description ? `> ${giveaway.description}\n\n` : '') +
              Brand.divider
            );

            const rolePing = giveaway.notifyRoleId ? `<@&${giveaway.notifyRoleId}> ` : '';
            await channel.send({ content: rolePing || undefined, embeds: [winnerEmbed] });
          }

          // Original-Embed aktualisieren
          if (giveaway.messageId) {
            try {
              const msg = await channel.messages.fetch(giveaway.messageId);
              await msg.edit({ embeds: [winnerEmbed] });
            } catch { /* Nachricht nicht mehr vorhanden */ }
          }
        } catch (error) {
          logger.error(`Giveaway Embed-Update fehlgeschlagen für ${giveaway.id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Giveaway-Scheduler Fehler:', error);
    }
  }, CHECK_INTERVAL);

  logger.info('Giveaway-Scheduler gestartet.');
}
