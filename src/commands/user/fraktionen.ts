import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';

/**
 * /fraktionen — listet alle Fraktionen der aktuellen Guild (Slot-uebergreifend),
 * gruppiert nach Slot. Per-Guild-Scope: zeigt NUR Fraktionen dieser Guild.
 */
const STATUS_EMOJI: Record<string, string> = {
  ACTIVE: '🟢',
  RECRUITING: '🟡',
  INACTIVE: '⚪',
  ARCHIVED: '⚫',
};

const POLICY_EMOJI: Record<string, string> = {
  OPEN: '🔓',
  REQUEST: '✋',
  CLOSED: '🔒',
};

const fraktionenCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('fraktionen')
    .setDescription('Zeigt alle Fraktionen dieses Servers (gruppiert pro Slot).')
    .setDMPermission(false),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: '❌ Nur in Servern verfügbar.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Per-Guild Scope: nur Fraktionen DIESER Guild laden, gruppiert pro Slot.
    const factions = await prisma.faction.findMany({
      where: { guildId },
      include: {
        _count: { select: { members: true } },
        nitradoConn: { select: { slot: true, alias: true } },
      },
      orderBy: [{ nitradoConnId: 'asc' }, { status: 'asc' }, { name: 'asc' }],
    });

    if (factions.length === 0) {
      await interaction.editReply({ content: '_Auf diesem Server sind keine Fraktionen angelegt._' });
      return;
    }

    // Gruppieren nach Slot.
    const bySlot = new Map<string, { slot: number; label: string | null; items: typeof factions }>();
    for (const f of factions) {
      const slot = f.nitradoConn?.slot ?? 0;
      const key = `s${slot}`;
      const bucket = bySlot.get(key) ?? { slot, label: f.nitradoConn?.alias ?? null, items: [] };
      bucket.items.push(f);
      bySlot.set(key, bucket);
    }

    const embed = new EmbedBuilder()
      .setAuthor({ name: 'V-BOT  •  FRAKTIONEN' })
      .setTitle(`🏛️  Fraktionen auf ${interaction.guild?.name ?? 'diesem Server'}`)
      .setColor(0xdc2626)
      .setFooter({ text: `${factions.length} Fraktion(en) insgesamt  •  pro Slot getrennt` })
      .setTimestamp(new Date());

    // Pro Slot ein Field.
    for (const bucket of [...bySlot.values()].sort((a, b) => a.slot - b.slot)) {
      const lines: string[] = [];
      for (const f of bucket.items) {
        const st = STATUS_EMOJI[f.status] ?? '⚪';
        const pol = POLICY_EMOJI[f.joinPolicy] ?? '';
        const leader = f.leaderDiscordId ? ` — Leitung <@${f.leaderDiscordId}>` : '';
        const role = f.roleId ? ` · <@&${f.roleId}>` : '';
        lines.push(`${st} **${f.name}** ${pol} · ${f._count.members} Mitglieder${leader}${role}`);
      }
      const slotName = bucket.label ? `Slot ${bucket.slot} — ${bucket.label}` : `Slot ${bucket.slot}`;
      embed.addFields({
        name: `📦  ${slotName}  (${bucket.items.length})`,
        value: lines.join('\n').slice(0, 1024),
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

export default fraktionenCommand;
