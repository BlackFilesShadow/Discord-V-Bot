/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { safeEmbedDescription, safeEmbedField } from '../../utils/embedSanitize';
import crypto from 'crypto';

let giveawaySchedulerTimer: NodeJS.Timeout | null = null;

export interface GiveawayRoleRules {
  minRole?: string | null;
  blacklistRoles?: unknown;
}

/** Kanonische Rollenpruefung fuer Slash- UND Button-Teilnahme. */
export function checkGiveawayEligibility(
  giveaway: GiveawayRoleRules,
  memberRoleIds: Iterable<string> | null | undefined,
): { allowed: boolean; message?: string } {
  const blacklist = Array.isArray(giveaway.blacklistRoles)
    ? giveaway.blacklistRoles.filter((value): value is string => typeof value === 'string')
    : [];
  const requiresRoleContext = !!giveaway.minRole || blacklist.length > 0;
  if (!requiresRoleContext) return { allowed: true };
  if (!memberRoleIds) {
    return { allowed: false, message: 'Deine Rollen konnten fuer dieses Giveaway nicht sicher geprueft werden.' };
  }

  const roles = new Set(memberRoleIds);
  const blockedRole = blacklist.find(roleId => roles.has(roleId));
  if (blockedRole) {
    return { allowed: false, message: `Du kannst wegen einer ausgeschlossenen Rolle (<@&${blockedRole}>) nicht teilnehmen.` };
  }
  if (giveaway.minRole && !roles.has(giveaway.minRole)) {
    return { allowed: false, message: `Fuer dieses Giveaway benoetigst du die Rolle <@&${giveaway.minRole}>.` };
  }
  return { allowed: true };
}

export async function createGiveaway(params: {
  creatorDiscordId: string;
  channelId: string;
  guildId: string;
  prize: string;
  description?: string;
  durationSeconds: number;
  winnerCount?: number;
  minRole?: string;
  blacklistRoles?: string[];
  customEmoji?: string;
  notifyRoleId?: string;
}): Promise<{ success: boolean; giveawayId?: string; message: string }> {
  const creator = await prisma.user.findUnique({ where: { discordId: params.creatorDiscordId } });
  if (!creator) return { success: false, message: 'User nicht registriert.' };

  const endsAt = new Date(Date.now() + params.durationSeconds * 1000);
  const giveaway = await prisma.giveaway.create({
    data: {
      creatorId: creator.id,
      channelId: params.channelId,
      guildId: params.guildId,
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
    guildId: params.guildId,
    prize: params.prize,
    duration: params.durationSeconds,
    endsAt: endsAt.toISOString(),
  });
  return { success: true, giveawayId: giveaway.id, message: 'Giveaway erstellt.' };
}

export function createGiveawayEmbed(giveaway: {
  prize: string;
  description?: string | null;
  endsAt: Date;
  creatorId?: string;
  customEmoji?: string | null;
  status: string;
  winnerId?: string | null;
  winnerCount?: number;
  minRole?: string | null;
  blacklistRoles?: unknown;
}, participantCount: number, creatorUsername?: string): EmbedBuilder {
  const timeLeft = giveaway.endsAt.getTime() - Date.now();
  const isActive = giveaway.status === 'ACTIVE' && timeLeft > 0;
  const embed = vEmbed(isActive ? Colors.Giveaway : Colors.Neutral).setTitle('🎉  GIVEAWAY');

  const descParts: string[] = [];
  if (giveaway.description) descParts.push(`> ${safeEmbedField(giveaway.description, 1024)}`);
  descParts.push(Brand.divider);
  descParts.push(`\n🏆 **Preis:** ${safeEmbedField(giveaway.prize, 256)}`);

  if (isActive) {
    descParts.push(`⏰ **Endet:** <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>`);
    descParts.push(`👥 **Teilnehmer:** ${participantCount}`);
    if (creatorUsername) descParts.push(`🎁 **Von:** ${creatorUsername}`);
    if (giveaway.minRole) descParts.push(`✅ **Mindestrolle:** <@&${giveaway.minRole}>`);
    const blacklist = Array.isArray(giveaway.blacklistRoles)
      ? giveaway.blacklistRoles.filter((value): value is string => typeof value === 'string')
      : [];
    if (blacklist.length > 0) descParts.push(`⛔ **Ausgeschlossen:** ${blacklist.map(id => `<@&${id}>`).join(', ')}`);
    descParts.push(`\n${Brand.divider}`);
    descParts.push('\n*Klicke auf den Button um teilzunehmen!*');
  } else {
    descParts.push(`👥 **Teilnehmer:** ${participantCount}`);
    if (creatorUsername) descParts.push(`🎁 **Von:** ${creatorUsername}`);
    descParts.push(`\n${Brand.divider}`);
    descParts.push('\n*Giveaway beendet*');
  }

  embed.setDescription(safeEmbedDescription(descParts.join('\n')));
  embed.setFooter({ text: `${Brand.footerText} ${Brand.dot} Giveaway` });
  return embed;
}

export async function enterGiveaway(
  giveawayId: string,
  userDiscordId: string,
  guildId: string,
  memberRoleIds?: Iterable<string> | null,
): Promise<{ success: boolean; message: string }> {
  const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId } });
  if (!giveaway) return { success: false, message: 'Giveaway nicht gefunden.' };
  if (giveaway.status !== 'ACTIVE' || giveaway.endsAt <= new Date()) {
    return { success: false, message: 'Giveaway ist nicht mehr aktiv.' };
  }

  const eligibility = checkGiveawayEligibility(giveaway, memberRoleIds);
  if (!eligibility.allowed) return { success: false, message: eligibility.message ?? 'Teilnahme nicht erlaubt.' };

  const user = await prisma.user.findUnique({ where: { discordId: userDiscordId } });
  if (!user) return { success: false, message: 'User nicht registriert.' };

  try {
    await prisma.giveawayEntry.create({ data: { giveawayId, userId: user.id } });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      return { success: false, message: 'Du nimmst bereits teil!' };
    }
    throw error;
  }

  logAudit('GIVEAWAY_ENTER', 'GIVEAWAY', { giveawayId, userId: user.id, guildId });
  return { success: true, message: 'Du nimmst jetzt teil! 🎉' };
}

/**
 * Gewinnerziehung ist vollstaendig atomar:
 * ACTIVE -> ENDED, Winner-Marker und winnerId committen gemeinsam.
 * Manuelles Ende und Scheduler koennen deshalb niemals zwei Gewinnerziehungen
 * fuer dieselbe Runde committen.
 */
export async function drawWinners(giveawayId: string, guildId: string): Promise<{
  success: boolean;
  winners: { id: string; discordId: string; username: string }[];
  message: string;
}> {
  const result = await prisma.$transaction(async tx => {
    const giveaway = await tx.giveaway.findFirst({
      where: { id: giveawayId, guildId },
      include: {
        entries: { include: { user: { select: { id: true, discordId: true, username: true } } } },
      },
    });
    if (!giveaway) return { kind: 'NOT_FOUND' as const };
    if (giveaway.status !== 'ACTIVE') return { kind: 'ALREADY_ENDED' as const };

    // CAS nimmt genau einer konkurrierenden Instanz die Runde ab. Weil der
    // Statuswechsel in derselben DB-Transaktion wie die Gewinner-Marker liegt,
    // rollt bei jedem Fehler die gesamte Ziehung auf ACTIVE zurueck.
    const claim = await tx.giveaway.updateMany({
      where: { id: giveawayId, guildId, status: 'ACTIVE' },
      data: { status: 'ENDED' },
    });
    if (claim.count !== 1) return { kind: 'ALREADY_ENDED' as const };

    if (giveaway.entries.length === 0) {
      return { kind: 'DRAWN' as const, giveaway, winners: [] as { id: string; discordId: string; username: string }[] };
    }

    const pool = [...giveaway.entries];
    const winners: { id: string; discordId: string; username: string }[] = [];
    const winnerCount = Math.min(giveaway.winnerCount, pool.length);
    for (let index = 0; index < winnerCount; index++) {
      const randomIndex = crypto.randomInt(pool.length);
      const winnerEntry = pool.splice(randomIndex, 1)[0];
      winners.push(winnerEntry.user);
      await tx.giveawayEntry.update({ where: { id: winnerEntry.id }, data: { isWinner: true } });
    }
    await tx.giveaway.update({
      where: { id: giveawayId },
      data: { winnerId: winners[0]?.id ?? null },
    });
    return { kind: 'DRAWN' as const, giveaway, winners };
  });

  if (result.kind === 'NOT_FOUND') return { success: false, winners: [], message: 'Giveaway nicht gefunden.' };
  if (result.kind === 'ALREADY_ENDED') return { success: false, winners: [], message: 'Giveaway wurde bereits beendet.' };

  logAudit('GIVEAWAY_DRAWN', 'GIVEAWAY', {
    giveawayId,
    guildId,
    prize: result.giveaway.prize,
    winners: result.winners.map(w => w.discordId),
    participantCount: result.giveaway.entries.length,
  });
  if (result.winners.length === 0) return { success: false, winners: [], message: 'Keine Teilnehmer.' };
  return {
    success: true,
    winners: result.winners,
    message: `Gewinner gezogen! ${result.winners.map(w => w.username).join(', ')}`,
  };
}

export function startGiveawayScheduler(client: Client): void {
  if (giveawaySchedulerTimer) return;
  const CHECK_INTERVAL = 3000;

  giveawaySchedulerTimer = setInterval(async () => {
    try {
      const shardGuildIds = [...client.guilds.cache.keys()];
      const expiredGiveaways = await prisma.giveaway.findMany({
        where: { status: 'ACTIVE', endsAt: { lte: new Date() }, guildId: { in: shardGuildIds } },
      });

      for (const giveaway of expiredGiveaways) {
        if (!giveaway.guildId) {
          logger.warn('Giveaway-Scheduler: Giveaway ohne guildId wird uebersprungen', { giveawayId: giveaway.id });
          continue;
        }

        const result = await drawWinners(giveaway.id, giveaway.guildId);
        if (!result.success && result.message === 'Giveaway wurde bereits beendet.') continue;
        const participantCount = await prisma.giveawayEntry.count({ where: { giveawayId: giveaway.id } });

        try {
          const channel = await client.channels.fetch(giveaway.channelId) as TextChannel;
          if (!channel) continue;
          const winnerEmbed = vEmbed(result.success ? Colors.Success : Colors.Neutral)
            .setTitle('🎉  GIVEAWAY BEENDET')
            .setFooter({ text: `${Brand.footerText} ${Brand.dot} Giveaway` });

          const safePrize = safeEmbedField(giveaway.prize, 256);
          const safeDesc = giveaway.description ? safeEmbedField(giveaway.description, 1024) : '';
          if (result.success && result.winners.length > 0) {
            const winnerMentions = result.winners.map(w => `<@${w.discordId}>`).join(', ');
            winnerEmbed.setDescription(safeEmbedDescription(
              `${Brand.divider}\n\n🏆 **Preis:** ${safePrize}\n🎊 **Gewinner:** ${winnerMentions}\n👥 **Teilnehmer:** ${participantCount}\n\n` +
              (safeDesc ? `> ${safeDesc}\n\n` : '') + Brand.divider,
            ));
            const rolePing = giveaway.notifyRoleId ? `<@&${giveaway.notifyRoleId}> ` : '';
            await channel.send({
              content: `${rolePing}🎉 Glueckwunsch ${winnerMentions}! Du hast **${safePrize}** gewonnen!`,
              embeds: [winnerEmbed],
              allowedMentions: {
                users: result.winners.map(w => w.discordId),
                roles: giveaway.notifyRoleId ? [giveaway.notifyRoleId] : [],
              },
            });
          } else {
            winnerEmbed.setDescription(safeEmbedDescription(
              `${Brand.divider}\n\n🏆 **Preis:** ${safePrize}\n😢 **Ergebnis:** Keine Teilnehmer\n\n` +
              (safeDesc ? `> ${safeDesc}\n\n` : '') + Brand.divider,
            ));
            const rolePing = giveaway.notifyRoleId ? `<@&${giveaway.notifyRoleId}> ` : '';
            await channel.send({
              content: rolePing || undefined,
              embeds: [winnerEmbed],
              allowedMentions: { roles: giveaway.notifyRoleId ? [giveaway.notifyRoleId] : [] },
            });
          }

          if (giveaway.messageId) {
            try {
              const msg = await channel.messages.fetch(giveaway.messageId);
              await msg.edit({ embeds: [winnerEmbed], components: [] });
            } catch { /* Nachricht nicht mehr vorhanden */ }
          }
        } catch (error) {
          logger.error(`Giveaway Embed-Update fehlgeschlagen fuer ${giveaway.id}:`, error);
        }
      }
    } catch (error) {
      logger.error('Giveaway-Scheduler Fehler:', error);
    }
  }, CHECK_INTERVAL);
  giveawaySchedulerTimer.unref?.();
  logger.info('Giveaway-Scheduler gestartet.');
}

export function stopGiveawayScheduler(): void {
  if (!giveawaySchedulerTimer) return;
  clearInterval(giveawaySchedulerTimer);
  giveawaySchedulerTimer = null;
}
