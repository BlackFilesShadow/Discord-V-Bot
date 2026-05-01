/**
 * Guild-Level-Support-Ticket-System (Phase 6).
 *
 * Trennt sich strikt vom Bot-Owner-DM-Bridge unter src/modules/ticket/
 * (das ist Bot-Owner-Anfrage-System). Hier: Server-Owner konfiguriert
 * pro Guild bis zu 5 Ticket-Templates. Im konfigurierten Channel wird
 * ein Embed mit Open-Button gepostet. User-Klick erstellt einen
 * privaten Channel; Close-Button erzeugt Markdown-Transcript und
 * loescht den Channel.
 *
 * customId-Konvention (Kollisions-frei zum DM-System mit `ticket_*`):
 *   ttkt:open:<templateId>
 *   ttkt:close:<instanceId>
 */

import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
  type ButtonInteraction,
  type Client,
  type GuildTextBasedChannel,
  type TextChannel,
} from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

const MAX_OPEN_PER_USER = 1;
const TRANSCRIPT_MAX_MSGS = 1000;

function parseColor(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return 0xdc2626;
  return parseInt(m[1], 16);
}

function buildOpenEmbed(template: { embedTitle: string; embedColor: string; label: string; welcomeText: string }): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(template.embedTitle)
    .setDescription(`Klicke unten auf **${template.label}**, um ein neues Ticket zu erstellen.`)
    .setColor(parseColor(template.embedColor))
    .setFooter({ text: 'V-Bot Ticket-System' });
}

function buildOpenButton(templateId: string, label: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ttkt:open:${templateId}`)
      .setLabel(label.slice(0, 80) || 'Ticket öffnen')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildCloseButton(instanceId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ttkt:close:${instanceId}`)
      .setLabel('Ticket schließen')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Postet (oder aktualisiert) den Open-Embed im konfigurierten Channel.
 * Wird vom Backend nach Save aufgerufen.
 */
export async function postTemplateEmbed(client: Client, templateId: string): Promise<{ messageId: string }> {
  const t = await prisma.ticketTemplate.findUnique({ where: { id: templateId } });
  if (!t) throw new Error('Template nicht gefunden.');
  if (!t.isActive) throw new Error('Template ist inaktiv.');

  const channel = await client.channels.fetch(t.postChannelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new Error('Post-Channel nicht verfuegbar oder kein Text-Channel.');
  }

  const embed = buildOpenEmbed(t);
  const row = buildOpenButton(t.id, t.label);

  let messageId = t.postedMessageId;
  let updated = false;
  if (messageId) {
    try {
      const existing = await (channel as GuildTextBasedChannel).messages.fetch(messageId);
      await existing.edit({ embeds: [embed], components: [row] });
      updated = true;
    } catch {
      messageId = null;
    }
  }
  if (!messageId) {
    const sent = await (channel as GuildTextBasedChannel).send({ embeds: [embed], components: [row] });
    messageId = sent.id;
  }

  await prisma.ticketTemplate.update({
    where: { id: t.id },
    data: { postedMessageId: messageId },
  });

  logAudit(updated ? 'TICKET_TEMPLATE_EMBED_UPDATED' : 'TICKET_TEMPLATE_EMBED_POSTED', 'TICKET', {
    guildId: t.guildId, templateId: t.id, channelId: t.postChannelId, messageId,
  });

  return { messageId };
}

/**
 * Open-Button-Handler: erstellt privaten Channel + Welcome-Embed.
 */
export async function handleOpenButton(btn: ButtonInteraction): Promise<void> {
  const templateId = btn.customId.split(':')[2];
  if (!templateId) {
    await btn.reply({ content: 'Ungueltige Button-ID.', ephemeral: true });
    return;
  }
  if (!btn.guild) {
    await btn.reply({ content: 'Tickets nur in Servern.', ephemeral: true });
    return;
  }

  const t = await prisma.ticketTemplate.findUnique({ where: { id: templateId } });
  if (!t || !t.isActive || t.guildId !== btn.guild.id) {
    await btn.reply({ content: 'Template nicht verfuegbar.', ephemeral: true });
    return;
  }

  // Limit: 1 offenes Ticket pro User pro Template
  const openCount = await prisma.ticketInstance.count({
    where: { templateId: t.id, openerDiscordId: btn.user.id, status: 'OPEN' },
  });
  if (openCount >= MAX_OPEN_PER_USER) {
    await btn.reply({ content: `Du hast bereits ein offenes Ticket dieser Art (max. ${MAX_OPEN_PER_USER}).`, ephemeral: true });
    return;
  }

  await btn.deferReply({ ephemeral: true });

  try {
    const guild = btn.guild;
    const me = guild.members.me;
    if (!me) throw new Error('Bot-Member nicht verfuegbar.');

    const overwrites: { id: string; allow?: bigint[]; deny?: bigint[] }[] = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: btn.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      {
        id: me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
    ];
    if (t.staffRoleId) {
      overwrites.push({
        id: t.staffRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      });
    }

    const safeName = `ticket-${btn.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'user'}`;
    const channel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: t.categoryId ?? undefined,
      // discord.js erwartet das overwrites-Format; wir mappen IDs+allow/deny
      permissionOverwrites: overwrites.map(o => ({
        id: o.id,
        ...(o.allow ? { allow: o.allow } : {}),
        ...(o.deny ? { deny: o.deny } : {}),
      })),
      reason: `Ticket geoeffnet von ${btn.user.tag}`,
    });

    const instance = await prisma.ticketInstance.create({
      data: {
        templateId: t.id,
        guildId: guild.id,
        channelId: channel.id,
        openerDiscordId: btn.user.id,
        openerName: btn.user.username,
      },
    });

    const welcome = new EmbedBuilder()
      .setTitle(`🎫  ${t.label}`)
      .setDescription(t.welcomeText.slice(0, 4000))
      .setColor(parseColor(t.embedColor))
      .addFields(
        { name: 'Eroeffnet von', value: `<@${btn.user.id}>`, inline: true },
        { name: 'Eroeffnet am', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true },
      );

    const mentionLine = t.staffRoleId ? `<@&${t.staffRoleId}> <@${btn.user.id}>` : `<@${btn.user.id}>`;
    await (channel as TextChannel).send({
      content: mentionLine,
      embeds: [welcome],
      components: [buildCloseButton(instance.id)],
      allowedMentions: { users: [btn.user.id], roles: t.staffRoleId ? [t.staffRoleId] : [] },
    });

    logAudit('TICKET_OPENED', 'TICKET', {
      guildId: guild.id, templateId: t.id, instanceId: instance.id,
      channelId: channel.id, userId: btn.user.id,
    });

    await btn.editReply({ content: `Ticket erstellt: <#${channel.id}>` });
  } catch (e) {
    logger.error('Ticket-Open-Fehler', e as Error);
    await btn.editReply({ content: 'Konnte Ticket nicht erstellen. Bitte Admin informieren.' }).catch(() => {});
  }
}

/**
 * Close-Button-Handler: Transcript bauen, posten, Channel loeschen.
 */
export async function handleCloseButton(btn: ButtonInteraction): Promise<void> {
  const instanceId = btn.customId.split(':')[2];
  if (!instanceId) {
    await btn.reply({ content: 'Ungueltige Button-ID.', ephemeral: true });
    return;
  }

  const instance = await prisma.ticketInstance.findUnique({
    where: { id: instanceId },
    include: { template: true },
  });
  if (!instance || instance.status !== 'OPEN') {
    await btn.reply({ content: 'Ticket bereits geschlossen.', ephemeral: true });
    return;
  }

  // Permission: Opener oder Staff-Role oder Owner
  const canClose =
    btn.user.id === instance.openerDiscordId ||
    btn.user.id === btn.guild?.ownerId ||
    (instance.template.staffRoleId
      ? btn.guild?.members.cache.get(btn.user.id)?.roles.cache.has(instance.template.staffRoleId) ?? false
      : false);
  if (!canClose) {
    await btn.reply({ content: 'Du darfst dieses Ticket nicht schliessen.', ephemeral: true });
    return;
  }

  await btn.deferReply({ ephemeral: true });

  try {
    const channel = await btn.client.channels.fetch(instance.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      throw new Error('Channel nicht mehr vorhanden.');
    }

    // Transcript bauen
    const fetched = await (channel as TextChannel).messages.fetch({ limit: 100 });
    const collected = Array.from(fetched.values()).reverse();
    let lastId = collected[0]?.id;
    while (collected.length < TRANSCRIPT_MAX_MSGS && lastId) {
      const more = await (channel as TextChannel).messages.fetch({ before: lastId, limit: 100 });
      if (more.size === 0) break;
      const arr = Array.from(more.values()).reverse();
      collected.unshift(...arr);
      lastId = arr[0]?.id;
    }

    const lines: string[] = [
      `# Ticket-Transcript ${instance.template.label}`,
      ``,
      `- **Channel:** #${(channel as TextChannel).name} (\`${channel.id}\`)`,
      `- **Eroeffnet:** ${instance.openedAt.toISOString()} von ${instance.openerName} (\`${instance.openerDiscordId}\`)`,
      `- **Geschlossen:** ${new Date().toISOString()} von ${btn.user.username} (\`${btn.user.id}\`)`,
      `- **Nachrichten:** ${collected.length}`,
      ``,
      `---`,
      ``,
    ];
    for (const m of collected) {
      const ts = m.createdAt.toISOString();
      const author = m.author?.bot ? `[BOT] ${m.author.username}` : (m.author?.username ?? 'unknown');
      const content = m.content?.length > 0 ? m.content : (m.embeds.length > 0 ? '*[Embed]*' : '*[no text]*');
      lines.push(`**${author}** · \`${ts}\``);
      lines.push('');
      lines.push(content);
      if (m.attachments.size > 0) {
        for (const a of m.attachments.values()) {
          lines.push(`> Attachment: ${a.url}`);
        }
      }
      lines.push('');
    }

    const transcript = lines.join('\n');
    const file = new AttachmentBuilder(Buffer.from(transcript, 'utf8'), {
      name: `ticket-${instance.template.label}-${instance.id.slice(0, 8)}.md`,
    });

    let transcriptMessageId: string | null = null;
    const transcriptChannel = await btn.client.channels.fetch(instance.template.transcriptChannelId).catch(() => null);
    if (transcriptChannel && transcriptChannel.isTextBased() && !transcriptChannel.isDMBased()) {
      const sent = await (transcriptChannel as TextChannel).send({
        content: `📁 Transcript für Ticket **${instance.template.label}** von <@${instance.openerDiscordId}> (geschlossen von <@${btn.user.id}>)`,
        files: [file],
        allowedMentions: { parse: [] },
      });
      transcriptMessageId = sent.id;
    }

    // DM an Opener
    try {
      const opener = await btn.client.users.fetch(instance.openerDiscordId);
      const dmFile = new AttachmentBuilder(Buffer.from(transcript, 'utf8'), {
        name: `ticket-${instance.template.label}-${instance.id.slice(0, 8)}.md`,
      });
      await opener.send({
        content: `Dein Ticket **${instance.template.label}** wurde geschlossen. Transcript anbei.`,
        files: [dmFile],
      });
    } catch {
      // DM kann blockiert sein — kein harter Fehler
    }

    await prisma.ticketInstance.update({
      where: { id: instance.id },
      data: { status: 'CLOSED', closedAt: new Date(), closedBy: btn.user.id, transcriptMessageId },
    });

    logAudit('TICKET_CLOSED', 'TICKET', {
      guildId: instance.guildId, instanceId: instance.id,
      closedBy: btn.user.id, messages: collected.length,
    });

    await btn.editReply({ content: 'Ticket geschlossen. Channel wird in 5 Sekunden gelöscht.' });
    setTimeout(() => {
      (channel as TextChannel).delete('Ticket geschlossen').catch(() => {});
    }, 5000);
  } catch (e) {
    logger.error('Ticket-Close-Fehler', e as Error);
    await btn.editReply({ content: 'Konnte Ticket nicht schliessen. Bitte Admin informieren.' }).catch(() => {});
  }
}
