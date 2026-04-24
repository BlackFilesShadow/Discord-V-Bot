import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import { Colors, vEmbed } from '../../utils/embedDesign';
import {
  addKnowledge,
  listKnowledge,
  removeKnowledge,
  setPersonaOverride,
} from '../../modules/ai/guildKnowledge';
import { config } from '../../config';
import prisma from '../../database/prisma';

async function isAdminOrOwner(discordId: string): Promise<boolean> {
  if (config.discord.ownerId && config.discord.ownerId === discordId) return true;
  const u = await prisma.user.findUnique({ where: { discordId }, select: { role: true } });
  if (!u) return false;
  return ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(u.role);
}

const adminKnowledgeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-knowledge')
    .setDescription('Server-Wissens-Snippets fuer die AI verwalten')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Neues Wissens-Snippet hinzufuegen')
        .addStringOption((o) =>
          o
            .setName('label')
            .setDescription('Schluesselwort/Titel (wird als Trigger genutzt)')
            .setRequired(true)
            .setMaxLength(60),
        )
        .addStringOption((o) =>
          o
            .setName('inhalt')
            .setDescription('Faktenblock, max 2000 Zeichen')
            .setRequired(true)
            .setMaxLength(2000),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Alle aktiven Snippets dieses Servers anzeigen'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Snippet anhand der Kurz-ID deaktivieren')
        .addStringOption((o) =>
          o.setName('id').setDescription('Erste 8 Zeichen der Snippet-ID').setRequired(true).setMinLength(4),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('persona')
        .setDescription('Optionalen Persona-Hinweis fuer diesen Server setzen oder loeschen')
        .addStringOption((o) =>
          o
            .setName('text')
            .setDescription('Text fuer Persona-Override (leer lassen = entfernen)')
            .setRequired(false)
            .setMaxLength(1500),
        ),
    ) as SlashCommandBuilder,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
      await interaction.editReply({ content: 'Nur in einem Server verwendbar.' });
      return;
    }
    if (!(await isAdminOrOwner(interaction.user.id))) {
      await interaction.editReply({
        embeds: [vEmbed(Colors.Error).setTitle('❌ Keine Berechtigung').setDescription('Nur Owner oder Admin.')],
      });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'add') {
      const label = interaction.options.getString('label', true);
      const content = interaction.options.getString('inhalt', true);
      const r = await addKnowledge(guildId, label, content, interaction.user.id);
      await interaction.editReply({
        embeds: [
          vEmbed(r.ok ? Colors.Success : Colors.Error)
            .setTitle(r.ok ? '📚 Snippet gespeichert' : '❌ Fehler')
            .setDescription(r.message),
        ],
      });
      return;
    }

    if (sub === 'list') {
      const items = await listKnowledge(guildId);
      if (items.length === 0) {
        await interaction.editReply({ content: 'Noch keine Snippets fuer diesen Server.' });
        return;
      }
      const lines = items.map((s) => `**\`${s.id.slice(0, 8)}\`** · ${s.label} — ${s.content.slice(0, 80)}${s.content.length > 80 ? '...' : ''}`);
      await interaction.editReply({
        embeds: [
          vEmbed(Colors.Info)
            .setTitle(`📚 Knowledge-Snippets (${items.length})`)
            .setDescription(lines.join('\n').slice(0, 4000)),
        ],
      });
      return;
    }

    if (sub === 'remove') {
      const shortId = interaction.options.getString('id', true).toLowerCase();
      const items = await listKnowledge(guildId);
      const match = items.find((s) => s.id.toLowerCase().startsWith(shortId));
      if (!match) {
        await interaction.editReply({ content: `Kein Snippet mit ID-Praefix \`${shortId}\` gefunden.` });
        return;
      }
      const r = await removeKnowledge(guildId, match.id);
      await interaction.editReply({
        embeds: [vEmbed(r.ok ? Colors.Success : Colors.Error).setTitle(r.ok ? '🗑️ Entfernt' : '❌ Fehler').setDescription(r.message)],
      });
      return;
    }

    if (sub === 'persona') {
      const text = interaction.options.getString('text');
      const r = await setPersonaOverride(guildId, text && text.trim() ? text : null);
      await interaction.editReply({
        embeds: [vEmbed(r.ok ? Colors.Success : Colors.Error).setTitle(r.ok ? '🧠 Persona' : '❌ Fehler').setDescription(r.message)],
      });
      return;
    }
  },
};

export default adminKnowledgeCommand;
