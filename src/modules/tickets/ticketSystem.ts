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

const TRANSCRIPT_MAX_MSGS = 1000;
const MAX_WELCOME_MESSAGES = 5;

// Mutex pro Template-ID gegen parallele postTemplateEmbed-Aufrufe (F9).
const postLocks = new Map<string, Promise<unknown>>();

function normalizeWelcomeMessages(raw: unknown, fallback: string): string[] {
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const m of raw) {
      if (typeof m === 'string') {
        const t = m.trim();
        if (t.length > 0) out.push(t.slice(0, 2000));
      }
      if (out.length >= MAX_WELCOME_MESSAGES) break;
    }
    if (out.length > 0) return out;
  }
  return [fallback.slice(0, 2000) || 'Hallo! Ein Team-Mitglied meldet sich gleich.'];
}

function parseColor(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return 0xdc2626;
  return parseInt(m[1], 16);
}

function buildOpenEmbed(template: { embedTitle: string; embedColor: string; label: string; welcomeText: string }): EmbedBuilder {
  const accent = parseColor(template.embedColor);
  return new EmbedBuilder()
    .setAuthor({ name: 'V-BOT  •  TICKET-SYSTEM' })
    .setTitle(`🎫  ${template.embedTitle}`)
    .setDescription(
      [
        `Du brauchst Hilfe oder hast eine Frage?`,
        `Klicke unten auf **${template.label}**, um ein privates Ticket zu eröffnen.`,
        ``,
        `Ein Team-Mitglied meldet sich darin sobald wie möglich.`,
      ].join('\n'),
    )
    .setColor(accent)
    .setFooter({ text: 'High-End Support  •  schnell · diskret · persönlich' });
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
  // F9: parallele Aufrufe serialisieren — verhindert doppelten Embed-Post.
  const prev = postLocks.get(templateId);
  if (prev) {
    try { await prev; } catch { /* ignore */ }
  }
  const run = (async (): Promise<{ messageId: string }> => {
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
  })();
  postLocks.set(templateId, run);
  try {
    return await run;
  } finally {
    if (postLocks.get(templateId) === run) postLocks.delete(templateId);
  }
}

/**
 * Loescht den geposteten Open-Embed (F2/F3): bei Channel-Wechsel oder Deaktivierung.
 * Setzt postedMessageId in der DB zurueck. Idempotent.
 */
export async function unpostTemplateEmbed(client: Client, templateId: string): Promise<void> {
  const t = await prisma.ticketTemplate.findUnique({ where: { id: templateId } });
  if (!t || !t.postedMessageId) return;
  try {
    const channel = await client.channels.fetch(t.postChannelId).catch(() => null);
    if (channel && channel.isTextBased() && !channel.isDMBased()) {
      const msg = await (channel as GuildTextBasedChannel).messages.fetch(t.postedMessageId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    }
  } finally {
    await prisma.ticketTemplate.update({
      where: { id: t.id },
      data: { postedMessageId: null },
    }).catch(() => {});
    logAudit('TICKET_TEMPLATE_EMBED_UNPOSTED', 'TICKET', {
      guildId: t.guildId, templateId: t.id, channelId: t.postChannelId,
    });
  }
}

/**
 * Schliesst alle offenen Discord-Channels eines Templates (F4) — wird vor
 * dem Loeschen des Templates aufgerufen, damit keine verwaisten Channels uebrig bleiben.
 * Best-effort, fehlertolerant.
 */
export async function purgeTemplateInstances(client: Client, templateId: string): Promise<{ closed: number; failed: number }> {
  const instances = await prisma.ticketInstance.findMany({
    where: { templateId, status: 'OPEN' },
  });
  let closed = 0; let failed = 0;
  for (const inst of instances) {
    try {
      const ch = await client.channels.fetch(inst.channelId).catch(() => null);
      if (ch && !ch.isDMBased()) {
        await (ch as TextChannel).delete('Ticket-Template geloescht').catch(() => {});
      }
      await prisma.ticketInstance.update({
        where: { id: inst.id },
        data: { status: 'CLOSED', closedAt: new Date(), closedBy: 'SYSTEM' },
      });
      closed++;
    } catch {
      failed++;
    }
  }
  return { closed, failed };
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

  // Per-User-Limit aufgehoben — ein User darf beliebig viele Tickets oeffnen.

  await btn.deferReply({ ephemeral: true });

  // F7: Vorab-Permission-Check fuer aussagekraeftige Fehlermeldung.
  const guild = btn.guild;
  const me = guild.members.me;
  if (!me) {
    await btn.editReply({ content: 'Bot-Member nicht verfuegbar.' }).catch(() => {});
    return;
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await btn.editReply({ content: 'Bot fehlt die Berechtigung **Kanaele verwalten**. Bitte Admin informieren.' }).catch(() => {});
    return;
  }

  // F5: Eindeutiger Channel-Name. Counter aus Anzahl bisheriger Tickets dieses Users.
  const userTicketCount = await prisma.ticketInstance.count({
    where: { templateId: t.id, openerDiscordId: btn.user.id },
  });
  const baseName = btn.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 18) || 'user';
  const safeName = `ticket-${baseName}-${(userTicketCount + 1).toString().padStart(3, '0')}`;

  let channel: TextChannel | null = null;
  let instance: { id: string } | null = null;
  try {
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

    channel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: t.categoryId ?? undefined,
      permissionOverwrites: overwrites.map(o => ({
        id: o.id,
        ...(o.allow ? { allow: o.allow } : {}),
        ...(o.deny ? { deny: o.deny } : {}),
      })),
      reason: `Ticket geoeffnet von ${btn.user.tag}`,
    }) as TextChannel;

    instance = await prisma.ticketInstance.create({
      data: {
        templateId: t.id,
        guildId: guild.id,
        channelId: channel.id,
        openerDiscordId: btn.user.id,
        openerName: btn.user.username,
      },
    });

    const messages = normalizeWelcomeMessages((t as unknown as { welcomeMessages?: unknown }).welcomeMessages, t.welcomeText);
    const color = parseColor(t.embedColor);

    const welcome = new EmbedBuilder()
      .setTitle(`🎫  ${t.label}`)
      .setDescription(messages[0])
      .setColor(color)
      .addFields(
        { name: 'Eroeffnet von', value: `<@${btn.user.id}>`, inline: true },
        { name: 'Eroeffnet am', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true },
      )
      .setFooter({ text: `V-Bot Ticket-System  •  Slot ${t.slot}` });

    const mentionLine = t.staffRoleId ? `<@&${t.staffRoleId}> <@${btn.user.id}>` : `<@${btn.user.id}>`;
    await channel.send({
      content: mentionLine,
      embeds: [welcome],
      components: [buildCloseButton(instance.id)],
      allowedMentions: { users: [btn.user.id], roles: t.staffRoleId ? [t.staffRoleId] : [] },
    });

    for (let i = 1; i < messages.length; i++) {
      const followUp = new EmbedBuilder()
        .setDescription(messages[i])
        .setColor(color);
      await channel.send({
        embeds: [followUp],
        allowedMentions: { parse: [] },
      });
    }

    logAudit('TICKET_OPENED', 'TICKET', {
      guildId: guild.id, templateId: t.id, instanceId: instance.id,
      channelId: channel.id, userId: btn.user.id,
    });

    await btn.editReply({ content: `Ticket erstellt: <#${channel.id}>` });
  } catch (e) {
    logger.error('Ticket-Open-Fehler', e as Error);
    // F1: Cleanup bei Teilfehler. Channel und Instance konsistent zuruecksetzen.
    if (instance) {
      await prisma.ticketInstance.delete({ where: { id: instance.id } }).catch(() => {});
    }
    if (channel) {
      await channel.delete('Ticket-Open-Fehler, Cleanup').catch(() => {});
    }
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

  // F6: Permission-Check via frischen Member-Fetch (kein Cache-Reliance).
  let canClose = btn.user.id === instance.openerDiscordId || btn.user.id === btn.guild?.ownerId;
  if (!canClose && instance.template.staffRoleId && btn.guild) {
    try {
      const member = await btn.guild.members.fetch(btn.user.id);
      canClose = member.roles.cache.has(instance.template.staffRoleId);
    } catch {
      // member fetch failed — leave canClose false
    }
  }
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

    // Optional: separater Archiv-Channel (zusaetzlich zum Transcript-Channel).
    const archiveChannelId = (instance.template as unknown as { archiveChannelId?: string | null }).archiveChannelId ?? null;
    if (archiveChannelId && archiveChannelId !== instance.template.transcriptChannelId) {
      const archiveChannel = await btn.client.channels.fetch(archiveChannelId).catch(() => null);
      if (archiveChannel && archiveChannel.isTextBased() && !archiveChannel.isDMBased()) {
        const archiveFile = new AttachmentBuilder(Buffer.from(transcript, 'utf8'), {
          name: `archive-${instance.template.label}-${instance.id.slice(0, 8)}.md`,
        });
        await (archiveChannel as TextChannel).send({
          content: `🗄️ Archiv: Ticket **${instance.template.label}** (Opener <@${instance.openerDiscordId}>, geschlossen von <@${btn.user.id}>, ${collected.length} Nachrichten)`,
          files: [archiveFile],
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
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
