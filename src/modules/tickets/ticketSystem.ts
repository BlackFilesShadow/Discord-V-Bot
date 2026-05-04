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
  type Message,
  type TextChannel,
} from 'discord.js';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

const TRANSCRIPT_MAX_MSGS = 1000;
const MAX_WELCOME_MESSAGES = 5;
const SYSTEM_CLOSER = 'SYSTEM';
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB pro Datei in ZIP
const MAX_ZIP_TOTAL_BYTES = 24 * 1024 * 1024; // 24 MB ZIP-Limit (Discord upload ≤8 MB free / 25 MB Boost)

/**
 * Formatiert ein Datum konsistent als `YYYY-MM-DD HH:mm:ss` in Europe/Berlin (CET/CEST)
 * mit zusätzlicher UTC-ISO-Angabe in Klammern. Verhindert Verwirrung bei TZ-Drift.
 */
function formatBerlin(d: Date): string {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} (CET/CEST) [UTC ${d.toISOString()}]`;
}

// Mutex pro Template-ID gegen parallele postTemplateEmbed-Aufrufe (F9).
const postLocks = new Map<string, Promise<unknown>>();
// Mutex pro <templateId>:<userId> gegen Mehrfach-Klick auf Open-Button (G3).
const openLocks = new Map<string, Promise<unknown>>();

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
    // Guild-Membership-Check: schuetzt vor stale Channel-IDs aus anderen Guilds.
    if ((channel as GuildTextBasedChannel).guildId !== t.guildId) {
      throw new Error('Post-Channel gehoert nicht zur richtigen Guild.');
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
 * G10: Erzeugt fuer jede Instance ein Transcript und postet es im transcriptChannelId
 * (und falls vorhanden archiveChannelId), bevor der Channel geloescht wird.
 * Best-effort, fehlertolerant.
 */
export async function purgeTemplateInstances(client: Client, templateId: string): Promise<{ closed: number; failed: number }> {
  const template = await prisma.ticketTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { closed: 0, failed: 0 };

  const instances = await prisma.ticketInstance.findMany({
    where: { templateId, status: 'OPEN' },
  });
  let closed = 0; let failed = 0;
  const safeLabel = template.label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'ticket';

  for (const inst of instances) {
    try {
      const ch = await client.channels.fetch(inst.channelId).catch(() => null);
      if (ch && !ch.isDMBased() && ch.isTextBased()) {
        const tch = ch as TextChannel;
        // G10: Transcript bauen.
        const fetched = await tch.messages.fetch({ limit: 100 }).catch(() => null);
        const collected = fetched ? Array.from(fetched.values()).reverse() : [];
        const lines: string[] = [
          `# Ticket-Transcript ${template.label} (System-Close: Template geloescht)`,
          ``,
          `- **Channel:** #${tch.name} (\`${tch.id}\`)`,
          `- **Eroeffnet:** ${formatBerlin(inst.openedAt)} von ${inst.openerName} (\`${inst.openerDiscordId}\`)`,
          `- **Geschlossen:** ${formatBerlin(new Date())} (System: Template geloescht)`,
          `- **Nachrichten:** ${collected.length}`,
          ``, `---`, ``,
        ];
        for (const m of collected) {
          const author = m.author?.bot ? `[BOT] ${m.author.username}` : (m.author?.username ?? 'unknown');
          const content = m.content?.length > 0 ? m.content : (m.embeds.length > 0 ? '*[Embed]*' : '*[no text]*');
          lines.push(`**${author}** · \`${formatBerlin(m.createdAt)}\``, '', content, '');
        }
        const transcript = lines.join('\n');
        const fileName = `ticket-${safeLabel}-${inst.id.slice(0, 8)}.md`;

        const targets = new Set<string>();
        targets.add(template.transcriptChannelId);
        if (template.archiveChannelId) targets.add(template.archiveChannelId);
        for (const targetId of targets) {
          const tgt = await client.channels.fetch(targetId).catch(() => null);
          if (tgt && tgt.isTextBased() && !tgt.isDMBased()) {
            await (tgt as TextChannel).send({
              content: `🗄️ System-Close (Template geloescht): Ticket **${template.label}** von <@${inst.openerDiscordId}>`,
              files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: fileName })],
              allowedMentions: { parse: [] },
            }).catch(() => {});
          }
        }

        await tch.delete('Ticket-Template geloescht').catch(() => {});
      }
      await prisma.ticketInstance.update({
        where: { id: inst.id },
        data: { status: 'CLOSED', closedAt: new Date(), closedBy: SYSTEM_CLOSER },
      });
      closed++;
    } catch (e) {
      logger.warn(`purgeTemplateInstances: Instance ${inst.id} fehlgeschlagen: ${(e as Error).message}`);
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

  // G3: Per-User-Mutex — verhindert race bei Mehrfach-Klick.
  const lockKey = `${t.id}:${btn.user.id}`;
  if (openLocks.has(lockKey)) {
    await btn.reply({ content: 'Ein Ticket-Open-Vorgang laeuft bereits. Bitte warten...', ephemeral: true }).catch(() => {});
    return;
  }
  let resolveLock: () => void = () => {};
  openLocks.set(lockKey, new Promise<void>(res => { resolveLock = res; }));
  try {
    await openTicketLocked(btn, t);
  } finally {
    openLocks.delete(lockKey);
    resolveLock();
  }
}

async function openTicketLocked(btn: ButtonInteraction, t: Awaited<ReturnType<typeof prisma.ticketTemplate.findUniqueOrThrow>>): Promise<void> {

  await btn.deferReply({ ephemeral: true });

  // F7: Vorab-Permission-Check fuer aussagekraeftige Fehlermeldung.
  const guild = btn.guild;
  if (!guild) return;
  const me = guild.members.me;
  if (!me) {
    await btn.editReply({ content: 'Bot-Member nicht verfuegbar.' }).catch(() => {});
    return;
  }
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await btn.editReply({ content: 'Bot fehlt die Berechtigung **Kanaele verwalten**. Bitte Admin informieren.' }).catch(() => {});
    return;
  }

  // G6: Staff-Rolle existiert noch?
  let effectiveStaffRoleId: string | null = t.staffRoleId;
  if (effectiveStaffRoleId) {
    const staffRole = await guild.roles.fetch(effectiveStaffRoleId).catch(() => null);
    if (!staffRole) {
      logger.warn(`Ticket-Template ${t.id}: staffRoleId ${effectiveStaffRoleId} existiert nicht mehr — ignoriere.`);
      effectiveStaffRoleId = null;
    }
  }

  // Manager-Rollen pruefen (Multi-Role): existiert noch + nicht managed.
  const rawManagerRoleIds = (t as unknown as { managerRoleIds?: unknown }).managerRoleIds;
  const managerRoleIds: string[] = [];
  if (Array.isArray(rawManagerRoleIds)) {
    for (const rid of rawManagerRoleIds) {
      if (typeof rid !== 'string') continue;
      const r = await guild.roles.fetch(rid).catch(() => null);
      if (r) managerRoleIds.push(rid);
      else logger.warn(`Ticket-Template ${t.id}: managerRoleId ${rid} existiert nicht mehr — ignoriere.`);
    }
  }

  // F5: Channel-Name `{number}-{user}-{name}` mit globaler fortlaufender Ticket-Nummer.
  // Discord-Channel-Limit: 100 Zeichen, lowercase, nur a-z0-9 und -.
  const userBase = btn.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'user';
  const labelBase = t.label.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'ticket';

  let channel: TextChannel | null = null;
  let instance: { id: string; openedAt: Date; ticketNumber: number } | null = null;
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
    if (effectiveStaffRoleId) {
      overwrites.push({
        id: effectiveStaffRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      });
    }
    for (const mid of managerRoleIds) {
      overwrites.push({
        id: mid,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }

    // Instance ZUERST anlegen (Placeholder-channelId), um ticketNumber zu bekommen → Channel-Name Format `{number}-{user}-{name}`.
    instance = await prisma.ticketInstance.create({
      data: {
        templateId: t.id,
        guildId: guild.id,
        channelId: `pending:${btn.id}`,
        openerDiscordId: btn.user.id,
        openerName: btn.user.username,
      },
    });
    const ticketNumber = (instance as unknown as { ticketNumber: number }).ticketNumber;
    const numStr = String(ticketNumber).padStart(4, '0');
    const safeName = `${numStr}-${userBase}-${labelBase}`.slice(0, 95);

    channel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: t.categoryId ?? undefined,
      permissionOverwrites: overwrites.map(o => ({
        id: o.id,
        ...(o.allow ? { allow: o.allow } : {}),
        ...(o.deny ? { deny: o.deny } : {}),
      })),
      reason: `Ticket #${numStr} geoeffnet von ${btn.user.tag}`,
    }) as TextChannel;

    await prisma.ticketInstance.update({
      where: { id: instance.id },
      data: { channelId: channel.id },
    });

    const messages = normalizeWelcomeMessages((t as unknown as { welcomeMessages?: unknown }).welcomeMessages, t.welcomeText);
    const color = parseColor(t.embedColor);

    const welcome = new EmbedBuilder()
      .setTitle(`🎫  ${t.label}`)
      .setDescription(messages[0])
      .setColor(color)
      .setTimestamp(instance.openedAt) // exakter DB-openedAt (statt Date.now() bei Embed-Send)
      .addFields(
        { name: 'Eroeffnet von', value: `<@${btn.user.id}>`, inline: true },
        // Discord rendert <t:N:F> in jeder Viewer-TZ korrekt; Quelle = DB-openedAt fuer Konsistenz mit Transcript.
        { name: 'Eroeffnet am', value: `<t:${Math.floor(instance.openedAt.getTime() / 1000)}:F> (<t:${Math.floor(instance.openedAt.getTime() / 1000)}:R>)`, inline: true },
        { name: 'Ticket-Nr.', value: `#${numStr}`, inline: true },
      )
      .setFooter({ text: `V-Bot Ticket-System  •  Slot ${t.slot}  •  #${numStr}` });

    const mentionRoleIds = Array.isArray((t as unknown as { mentionRoleIds?: unknown }).mentionRoleIds)
      ? ((t as unknown as { mentionRoleIds: unknown[] }).mentionRoleIds.filter((r): r is string => typeof r === 'string'))
      : [];
    // Keine User-Mention mehr (User wird im Embed-Field "Eroeffnet von" referenziert).
    // Nur explizit konfigurierte Rollen werden gepingt.
    const mentionLine = mentionRoleIds.length > 0
      ? mentionRoleIds.map(r => `<@&${r}>`).join(' ')
      : '';
    await channel.send({
      content: mentionLine || undefined,
      embeds: [welcome],
      components: [buildCloseButton(instance.id)],
      allowedMentions: { parse: [], roles: mentionRoleIds, users: [] },
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
      ticketNumber, channelId: channel.id, userId: btn.user.id,
      mentionedRoleIds: mentionRoleIds, mentionedRoleCount: mentionRoleIds.length,
      managerRoleIds,
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

  // Permission-Check: Opener darf NICHT mehr eigenes Ticket schliessen (User-Vorgabe).
  // Nur Server-Owner, Staff-Rolle (Legacy) und Manager-Rollen (Multi) duerfen schliessen.
  // Strikte Server-Side-Pruefung via frischen Member-Fetch (kein Cache-Reliance).
  let canClose = btn.user.id === btn.guild?.ownerId;
  if (!canClose && btn.guild) {
    try {
      const member = await btn.guild.members.fetch(btn.user.id);
      if (instance.template.staffRoleId && member.roles.cache.has(instance.template.staffRoleId)) {
        canClose = true;
      }
      if (!canClose) {
        const managerRoleIds = (instance.template as unknown as { managerRoleIds?: unknown }).managerRoleIds;
        if (Array.isArray(managerRoleIds)) {
          for (const rid of managerRoleIds) {
            if (typeof rid === 'string' && member.roles.cache.has(rid)) { canClose = true; break; }
          }
        }
      }
    } catch {
      // member fetch failed — leave canClose false
    }
  }
  if (!canClose) {
    await btn.reply({
      content: btn.user.id === instance.openerDiscordId
        ? 'Du darfst dein eigenes Ticket nicht schliessen. Bitte warte auf einen Manager oder Server-Owner.'
        : 'Du darfst dieses Ticket nicht schliessen.',
      ephemeral: true,
    });
    return;
  }

  await btn.deferReply({ ephemeral: true });

  try {
    const channel = await btn.client.channels.fetch(instance.channelId).catch(() => null);

    // G1: Wenn Channel bereits weg ist, Instance trotzdem als CLOSED markieren — kein DB-Leak.
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      await prisma.ticketInstance.update({
        where: { id: instance.id },
        data: { status: 'CLOSED', closedAt: new Date(), closedBy: btn.user.id },
      });
      logAudit('TICKET_CLOSED_NO_CHANNEL', 'TICKET', {
        guildId: instance.guildId, instanceId: instance.id, closedBy: btn.user.id,
      });
      await btn.editReply({ content: 'Channel war bereits geloescht. Ticket wurde in der DB als geschlossen markiert.' });
      return;
    }

    // G7: Channel sofort sperren, damit waehrend Transcript-Bau keine Messages mehr reinkommen.
    const ch = channel as TextChannel;
    await ch.permissionOverwrites.edit(btn.guild!.roles.everyone.id, { SendMessages: false }).catch(() => {});
    await ch.permissionOverwrites.edit(instance.openerDiscordId, { SendMessages: false }).catch(() => {});
    if (instance.template.staffRoleId) {
      await ch.permissionOverwrites.edit(instance.template.staffRoleId, { SendMessages: false }).catch(() => {});
    }

    // Transcript bauen
    const fetched = await ch.messages.fetch({ limit: 100 });
    const collected = Array.from(fetched.values()).reverse();
    let lastId = collected[0]?.id;
    let truncated = false;
    while (collected.length < TRANSCRIPT_MAX_MSGS && lastId) {
      const more = await ch.messages.fetch({ before: lastId, limit: 100 });
      if (more.size === 0) break;
      const arr = Array.from(more.values()).reverse();
      collected.unshift(...arr);
      lastId = arr[0]?.id;
    }
    // G9: pruefen ob es noch aeltere Messages gab.
    if (collected.length >= TRANSCRIPT_MAX_MSGS && lastId) {
      const probe = await ch.messages.fetch({ before: lastId, limit: 1 }).catch(() => null);
      if (probe && probe.size > 0) truncated = true;
    }

    const lines: string[] = [
      `# Ticket-Transcript ${instance.template.label}`,
      ``,
      `- **Channel:** #${ch.name} (\`${ch.id}\`)`,
      `- **Eroeffnet:** ${formatBerlin(instance.openedAt)} von ${instance.openerName} (\`${instance.openerDiscordId}\`)`,
      `- **Geschlossen:** ${formatBerlin(new Date())} von ${btn.user.username} (\`${btn.user.id}\`)`,
      `- **Nachrichten:** ${collected.length}${truncated ? ` (Limit ${TRANSCRIPT_MAX_MSGS} erreicht — aeltere Messages abgeschnitten)` : ''}`,
      ``,
      `---`,
      ``,
    ];
    for (const m of collected) {
      const ts = formatBerlin(m.createdAt);
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
    const safeLabel = instance.template.label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'ticket';
    const ticketNumber = (instance as unknown as { ticketNumber?: number }).ticketNumber ?? 0;
    const numStr = String(ticketNumber).padStart(4, '0');

    // ZIP-Archiv mit Transcript + heruntergeladenen Attachments (Screenshots/Bilder/Dateien).
    const zipBuffer = await buildTicketArchive({
      transcript,
      messages: collected,
      label: safeLabel,
    });
    const zipName = `ticket-${numStr}-${safeLabel}.zip`;
    const file = new AttachmentBuilder(zipBuffer, { name: zipName });

    let transcriptMessageId: string | null = null;
    const transcriptChannel = await btn.client.channels.fetch(instance.template.transcriptChannelId).catch(() => null);
    if (transcriptChannel && transcriptChannel.isTextBased() && !transcriptChannel.isDMBased()) {
      const sent = await (transcriptChannel as TextChannel).send({
        content: `📁 Transcript-Archiv für Ticket **#${numStr} ${instance.template.label}** von <@${instance.openerDiscordId}> (geschlossen von <@${btn.user.id}>, ${collected.length} Nachrichten)`,
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
        const archiveFile = new AttachmentBuilder(zipBuffer, {
          name: `archive-${numStr}-${safeLabel}.zip`,
        });
        await (archiveChannel as TextChannel).send({
          content: `🗄️ Archiv: Ticket **#${numStr} ${instance.template.label}** (Opener <@${instance.openerDiscordId}>, geschlossen von <@${btn.user.id}>, ${collected.length} Nachrichten)`,
          files: [archiveFile],
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
    }

    // DM an Opener
    try {
      const opener = await btn.client.users.fetch(instance.openerDiscordId);
      const dmFile = new AttachmentBuilder(zipBuffer, { name: zipName });
      await opener.send({
        content: `Dein Ticket **#${numStr} ${instance.template.label}** wurde geschlossen. Transcript-Archiv anbei.`,
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
      guildId: instance.guildId, instanceId: instance.id, ticketNumber,
      closedBy: btn.user.id, messages: collected.length,
      archiveSize: zipBuffer.length,
    });

    await btn.editReply({ content: 'Ticket geschlossen. Channel wird in 5 Sekunden geloescht.' });
    setTimeout(() => {
      ch.delete('Ticket geschlossen').catch(() => {});
    }, 5000);
  } catch (e) {
    logger.error('Ticket-Close-Fehler', e as Error);
    await btn.editReply({ content: 'Konnte Ticket nicht schliessen. Bitte Admin informieren.' }).catch(() => {});
  }
}

/**
 * ZIP-Archiv mit Markdown-Transcript + heruntergeladene Attachments (Bilder, Screenshots, Dateien).
 * Limits: pro Datei MAX_ATTACHMENT_BYTES, gesamt MAX_ZIP_TOTAL_BYTES.
 * Discord-Attachment-URLs sind authentifiziert/signiert -> Download via fetch.
 */
async function buildTicketArchive(opts: {
  transcript: string;
  messages: Message[];
  label: string;
}): Promise<Buffer> {
  const { transcript, messages, label } = opts;

  const archive = archiver('zip', { zlib: { level: 9 } });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    stream.on('end', () => resolve());
    stream.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(stream);

  // 1) Transcript.md im Root
  archive.append(transcript, { name: 'transcript.md' });

  // 2) Anhaenge in attachments/<msgId>-<filename>
  let totalBytes = Buffer.byteLength(transcript, 'utf8');
  const skipped: string[] = [];
  for (const m of messages) {
    if (m.attachments.size === 0) continue;
    for (const a of m.attachments.values()) {
      const size = a.size ?? 0;
      if (size > MAX_ATTACHMENT_BYTES) {
        skipped.push(`${a.name ?? a.id}: zu gross (${(size / 1024 / 1024).toFixed(1)} MB)`);
        continue;
      }
      if (totalBytes + size > MAX_ZIP_TOTAL_BYTES) {
        skipped.push(`${a.name ?? a.id}: ZIP-Limit erreicht`);
        continue;
      }
      try {
        const res = await fetch(a.url);
        if (!res.ok) {
          skipped.push(`${a.name ?? a.id}: HTTP ${res.status}`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (totalBytes + buf.length > MAX_ZIP_TOTAL_BYTES) {
          skipped.push(`${a.name ?? a.id}: ZIP-Limit erreicht`);
          continue;
        }
        const safeFile = (a.name ?? `attachment-${a.id}`).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
        archive.append(buf, { name: `attachments/${m.id}-${safeFile}` });
        totalBytes += buf.length;
      } catch (e) {
        skipped.push(`${a.name ?? a.id}: ${(e as Error).message}`);
      }
    }
  }

  // 3) skipped.txt falls relevant
  if (skipped.length > 0) {
    archive.append(`# Nicht aufgenommene Anhaenge fuer ${label}\n\n` + skipped.map(s => `- ${s}`).join('\n') + '\n', { name: 'skipped.txt' });
  }

  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}
