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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type Client,
  type GuildTextBasedChannel,
  type Message,
  type ModalSubmitInteraction,
  type TextChannel,
  type UserSelectMenuInteraction,
} from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { config } from '../../config';

const TRANSCRIPT_MAX_MSGS = 1000;
const MAX_WELCOME_MESSAGES = 5;
const SYSTEM_CLOSER = 'SYSTEM';
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024; // 8 MB Markdown-Transcript-Limit (Discord-Upload-Limit free)

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

/**
 * Kompaktes Datum/Uhrzeit-Format ohne UTC-Suffix (fuer Embeds und Transcript-Zeilen).
 * Beispiel: "03.05.2026 20:16:42"
 */
function formatBerlinShort(d: Date): string {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** HTML-Escape fuer User-generated Content im Transcript-Render. */
function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

// Mutex pro Template-ID gegen parallele postTemplateEmbed-Aufrufe (F9).
const postLocks = new Map<string, Promise<unknown>>();
// Mutex pro <templateId>:<userId> gegen Mehrfach-Klick auf Open-Button (G3).
const openLocks = new Map<string, Promise<unknown>>();
// Mutex pro instanceId gegen Mehrfach-Klick auf Close- oder AddUser-Button.
// Verhindert doppeltes Transcript-Posten und doppeltes Channel-Delete.
const instanceLocks = new Map<string, Promise<unknown>>();

async function withInstanceLock<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = instanceLocks.get(instanceId);
  if (prev) {
    // Anderer Vorgang fuer dieselbe Instance laeuft — abbrechen statt warten,
    // damit der User eine sofortige Rueckmeldung bekommt.
    throw new Error('BUSY');
  }
  let release!: () => void;
  const p = new Promise<void>(res => { release = res; });
  instanceLocks.set(instanceId, p);
  try {
    return await fn();
  } finally {
    instanceLocks.delete(instanceId);
    release();
  }
}

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

/**
 * Mappt Embed-Hex-Farbe auf den nativen Discord-ButtonStyle.
 * Frontend erlaubt nur Rot/Gruen/Blau; alles andere faellt auf Primary (Blau) zurueck.
 */
function openButtonStyleFor(hex: string): ButtonStyle {
  const v = (hex || '').toLowerCase();
  if (v === '#dc2626') return ButtonStyle.Danger;   // Rot
  if (v === '#22c55e') return ButtonStyle.Success;  // Gruen
  if (v === '#3b82f6') return ButtonStyle.Primary;  // Blau
  return ButtonStyle.Primary;
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

function buildOpenButton(templateId: string, label: string, embedColor: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ttkt:open:${templateId}`)
      .setLabel(label.slice(0, 80) || 'Ticket öffnen')
      .setEmoji('🎫')
      .setStyle(openButtonStyleFor(embedColor)),
  );
}

function buildCloseButton(instanceId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ttkt:close:${instanceId}`)
      .setLabel('Ticket schließen')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`ttkt:adduser:${instanceId}`)
      .setLabel('Nutzer hinzufügen')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ============================================================
// Close-Flow Helfer: Transcript-Build (Markdown + HTML), Close-Embed,
// Edit-Reason-Modal. Transcript-URL zeigt auf die public Web-Route
// /transcripts/<instanceId> (kein Auth — UUID v4 ist unguessable).
// ============================================================

interface CollectedMessage {
  id: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  createdAt: Date;
  content: string;
  attachments: Array<{ name: string; url: string }>;
  hasEmbeds: boolean;
}

function collectMessage(m: Message): CollectedMessage {
  const authorName = m.member?.displayName
    ?? m.author?.globalName
    ?? m.author?.username
    ?? 'Unbekannt';
  const attachments: Array<{ name: string; url: string }> = [];
  for (const a of m.attachments.values()) {
    attachments.push({ name: a.name ?? 'attachment', url: a.url });
  }
  return {
    id: m.id,
    authorId: m.author?.id ?? '0',
    authorName,
    isBot: Boolean(m.author?.bot),
    createdAt: m.createdAt,
    content: m.content ?? '',
    attachments,
    hasEmbeds: m.embeds.length > 0,
  };
}

interface TranscriptMeta {
  ticketLabel: string;
  ticketNumber: string; // bereits zero-padded
  channelName: string;
  guildName: string;
  openedAt: Date;
  openedByName: string;
  closedAt: Date;
  closedByName: string;
  claimedByName: string | null;
  closeReason: string | null;
  truncated: boolean;
  totalMessages: number;
}

/**
 * Kompakter Markdown-Transcript: ein Kopfblock + ein Block pro Nachricht.
 * Eine Zeile pro Nachricht-Header (`[DD.MM.YYYY HH:mm:ss] Name:`), dann Inhalt.
 * Keine Discord-IDs im sichtbaren Text — nur Display-Names.
 */
function buildTranscriptMarkdown(meta: TranscriptMeta, msgs: CollectedMessage[]): string {
  const out: string[] = [];
  out.push(`# Ticket #${meta.ticketNumber} — ${meta.ticketLabel}`);
  out.push('');
  out.push(`Server: ${meta.guildName}  ·  Channel: #${meta.channelName}`);
  out.push(`Eröffnet:    ${formatBerlinShort(meta.openedAt)}  von ${meta.openedByName}`);
  out.push(`Geschlossen: ${formatBerlinShort(meta.closedAt)}  von ${meta.closedByName}`);
  if (meta.claimedByName) out.push(`Übernommen:  von ${meta.claimedByName}`);
  if (meta.closeReason) out.push(`Grund:       ${meta.closeReason}`);
  out.push(`Nachrichten: ${meta.totalMessages}${meta.truncated ? ` (Limit ${TRANSCRIPT_MAX_MSGS} erreicht — ältere abgeschnitten)` : ''}`);
  out.push('');
  out.push('---');
  out.push('');
  for (const m of msgs) {
    const ts = formatBerlinShort(m.createdAt);
    const tag = m.isBot ? ' [BOT]' : '';
    const body = m.content.length > 0 ? m.content : (m.hasEmbeds ? '*[Embed]*' : '*[ohne Text]*');
    out.push(`[${ts}] ${m.authorName}${tag}:`);
    out.push(body);
    if (m.attachments.length > 0) {
      for (const a of m.attachments) out.push(`  📎 ${a.name} — ${a.url}`);
    }
    out.push('');
  }
  return out.join('\n');
}

/**
 * Selbststaendiges HTML fuer die public Transcript-Ansicht.
 * Inline-CSS, kein externes Asset — robust gegen CDN-Ausfaelle und einfach archivierbar.
 */
function buildTranscriptHtml(meta: TranscriptMeta, msgs: CollectedMessage[]): string {
  const safeTitle = htmlEscape(`Ticket #${meta.ticketNumber} — ${meta.ticketLabel}`);
  const rows = msgs.map(m => {
    const ts = formatBerlinShort(m.createdAt);
    const name = htmlEscape(m.authorName);
    const tag = m.isBot ? '<span class="bot">BOT</span>' : '';
    const body = m.content.length > 0
      ? htmlEscape(m.content).replace(/\n/g, '<br>')
      : (m.hasEmbeds ? '<em class="muted">[Embed]</em>' : '<em class="muted">[ohne Text]</em>');
    const atts = m.attachments.length === 0 ? '' :
      `<div class="atts">${m.attachments.map(a =>
        `<a href="${htmlEscape(a.url)}" target="_blank" rel="noopener">📎 ${htmlEscape(a.name)}</a>`,
      ).join('')}</div>`;
    return `<div class="msg">
      <div class="hdr"><span class="name">${name}</span>${tag}<span class="ts">${ts}</span></div>
      <div class="body">${body}</div>
      ${atts}
    </div>`;
  }).join('\n');
  const reasonInner = meta.closeReason
    ? `<div><span class="k">Grund</span><span class="v">${htmlEscape(meta.closeReason)}</span></div>` : '';
  const reasonRow = `<!--reason-->${reasonInner}<!--/reason-->`;
  const claimRow = meta.claimedByName
    ? `<div><span class="k">Übernommen</span><span class="v">${htmlEscape(meta.claimedByName)}</span></div>` : '';
  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0b0d10; color: #e6e8eb; line-height: 1.45; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px 18px 80px; }
  header { padding: 18px 20px; border: 1px solid #232830; background: #12161b;
    border-radius: 12px; margin-bottom: 20px; }
  header h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
  header .meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px;
    font-size: 13px; color: #b9c1cb; margin-top: 10px; }
  header .meta .k { color: #7d8896; }
  header .meta .v { color: #e6e8eb; }
  .msg { padding: 10px 12px; border-left: 2px solid #232830; margin: 6px 0;
    background: #0f1318; border-radius: 6px; }
  .msg .hdr { display: flex; align-items: baseline; gap: 8px; font-size: 13px; }
  .msg .name { font-weight: 600; color: #fff; }
  .msg .bot { font-size: 10px; padding: 1px 6px; border-radius: 4px;
    background: #2a3440; color: #8ab4f8; }
  .msg .ts { margin-left: auto; color: #7d8896; font-variant-numeric: tabular-nums; font-size: 12px; }
  .msg .body { margin-top: 4px; white-space: pre-wrap; word-wrap: break-word; font-size: 14px; }
  .msg .atts { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
  .msg .atts a { font-size: 12px; color: #8ab4f8; text-decoration: none;
    background: #1a2027; padding: 3px 8px; border-radius: 4px; }
  .msg .atts a:hover { background: #232b34; }
  .muted { color: #7d8896; }
  footer { margin-top: 28px; text-align: center; font-size: 11px; color: #5d6571; }
</style>
</head><body><div class="wrap">
<header>
  <h1>${safeTitle}</h1>
  <div class="meta">
    <span class="k">Server</span><span class="v">${htmlEscape(meta.guildName)}</span>
    <span class="k">Channel</span><span class="v">#${htmlEscape(meta.channelName)}</span>
    <span class="k">Eröffnet</span><span class="v">${formatBerlinShort(meta.openedAt)} von ${htmlEscape(meta.openedByName)}</span>
    <span class="k">Geschlossen</span><span class="v">${formatBerlinShort(meta.closedAt)} von ${htmlEscape(meta.closedByName)}</span>
    ${claimRow}
    ${reasonRow}
    <span class="k">Nachrichten</span><span class="v">${meta.totalMessages}${meta.truncated ? ` (Limit ${TRANSCRIPT_MAX_MSGS} — ältere abgeschnitten)` : ''}</span>
  </div>
</header>
${rows || '<p class="muted">Keine Nachrichten.</p>'}
<footer>V-BOT Ticket-Transcript · generiert ${formatBerlinShort(meta.closedAt)}</footer>
</div></body></html>`;
}

/**
 * Baut das "Ticket geschlossen"-Embed mit allen relevanten Feldern.
 * Display-Names statt blanken Discord-IDs (Mentions sind safe — allowedMentions.parse=[]).
 */
function buildClosedEmbed(args: {
  meta: TranscriptMeta;
  ticketLabel: string;
  ticketNumber: string;
  openerDiscordId: string;
  closedByDiscordId: string;
  embedColor: string;
}): EmbedBuilder {
  const m = args.meta;
  const isSnowflake = (id: string) => /^\d{17,20}$/.test(id);
  const openerLine = isSnowflake(args.openerDiscordId)
    ? `${m.openedByName}\n<@${args.openerDiscordId}>`
    : m.openedByName;
  const closerLine = isSnowflake(args.closedByDiscordId)
    ? `${m.closedByName}\n<@${args.closedByDiscordId}>`
    : m.closedByName;
  const e = new EmbedBuilder()
    .setColor(parseColor(args.embedColor || '#dc2626'))
    .setAuthor({ name: 'V-BOT  •  TICKET GESCHLOSSEN' })
    .setTitle(`🔒  Ticket #${args.ticketNumber} · ${args.ticketLabel}`)
    .addFields(
      { name: '👤  Eröffnet von',  value: openerLine, inline: true },
      { name: '🛠️  Geschlossen von', value: closerLine, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      { name: '🕒  Eröffnet',      value: formatBerlinShort(m.openedAt),  inline: true },
      { name: '🕒  Geschlossen',   value: formatBerlinShort(m.closedAt), inline: true },
      { name: '💬  Nachrichten',   value: String(m.totalMessages),         inline: true },
      { name: '🤝  Übernommen',    value: m.claimedByName ?? '_nicht übernommen_', inline: false },
      { name: '📝  Grund',         value: m.closeReason ?? '_kein Grund angegeben_', inline: false },
    )
    .setFooter({ text: 'High-End Support  •  Klicke unten für das vollständige Web-Transcript' });
  return e;
}

function buildClosedButtons(instanceId: string): ActionRowBuilder<ButtonBuilder> {
  const base = (config.dashboard.url || '').replace(/\/+$/, '');
  const url = `${base}/transcripts/${encodeURIComponent(instanceId)}`;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Online-Transcript öffnen')
      .setEmoji('📄')
      .setURL(url),
    new ButtonBuilder()
      .setCustomId(`ttkt:reason:${instanceId}`)
      .setLabel('Grund bearbeiten')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
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
    const buttonText = ((t as unknown as { buttonLabel?: string | null }).buttonLabel || t.label).slice(0, 80) || 'Ticket oeffnen';
    const row = buildOpenButton(t.id, buttonText, t.embedColor);

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
      const closedAt = new Date();
      const numStr = String((inst as unknown as { templateNumber?: number | null }).templateNumber
        ?? inst.ticketNumber ?? 0).padStart(2, '0');

      let collectedMsgs: CollectedMessage[] = [];
      let truncated = false;
      let channelName = `ticket-${safeLabel}`;
      let guildName = 'Server';

      if (ch && !ch.isDMBased() && ch.isTextBased()) {
        const tch = ch as TextChannel;
        channelName = tch.name;
        guildName = tch.guild?.name ?? 'Server';
        // Vollstaendige History bis TRANSCRIPT_MAX_MSGS sammeln (nicht nur 100).
        const fetched = await tch.messages.fetch({ limit: 100 }).catch(() => null);
        const collected = fetched ? Array.from(fetched.values()).reverse() : [];
        let lastId = collected[0]?.id;
        while (collected.length < TRANSCRIPT_MAX_MSGS && lastId) {
          const more = await tch.messages.fetch({ before: lastId, limit: 100 }).catch(() => null);
          if (!more || more.size === 0) break;
          const arr = Array.from(more.values()).reverse();
          collected.unshift(...arr);
          lastId = arr[0]?.id;
        }
        if (collected.length >= TRANSCRIPT_MAX_MSGS && lastId) {
          const probe = await tch.messages.fetch({ before: lastId, limit: 1 }).catch(() => null);
          if (probe && probe.size > 0) truncated = true;
        }
        collectedMsgs = collected.map(collectMessage);
      }

      const meta: TranscriptMeta = {
        ticketLabel: template.label,
        ticketNumber: numStr,
        channelName,
        guildName,
        openedAt: inst.openedAt,
        openedByName: inst.openerName,
        closedAt,
        closedByName: 'System (Template gelöscht)',
        claimedByName: null,
        closeReason: 'System-Close: Ticket-Template wurde gelöscht.',
        truncated,
        totalMessages: collectedMsgs.length,
      };
      const transcriptMd = buildTranscriptMarkdown(meta, collectedMsgs);
      const transcriptHtml = buildTranscriptHtml(meta, collectedMsgs);

      let transcriptBuf = Buffer.from(transcriptMd, 'utf8');
      if (transcriptBuf.length > MAX_TRANSCRIPT_BYTES) {
        transcriptBuf = transcriptBuf.subarray(0, MAX_TRANSCRIPT_BYTES);
      }
      const fileName = `ticket-${numStr}-${safeLabel}.md`;

      const closedEmbed = buildClosedEmbed({
        meta,
        ticketLabel: template.label,
        ticketNumber: numStr,
        openerDiscordId: inst.openerDiscordId,
        closedByDiscordId: SYSTEM_CLOSER,
        embedColor: template.embedColor,
      });
      const closedButtons = buildClosedButtons(inst.id);

      let transcriptMessageId: string | null = null;
      const targets = new Set<string>();
      targets.add(template.transcriptChannelId);
      if (template.archiveChannelId) targets.add(template.archiveChannelId);
      for (const targetId of targets) {
        const tgt = await client.channels.fetch(targetId).catch(() => null);
        if (tgt && tgt.isTextBased() && !tgt.isDMBased()) {
          const sent = await (tgt as TextChannel).send({
            embeds: [closedEmbed],
            components: [closedButtons],
            files: [new AttachmentBuilder(transcriptBuf, { name: fileName })],
            allowedMentions: { parse: [] },
          }).catch(() => null);
          if (sent && transcriptMessageId === null) transcriptMessageId = sent.id;
        }
      }

      if (ch && !ch.isDMBased() && ch.isTextBased()) {
        await (ch as TextChannel).delete('Ticket-Template geloescht').catch(() => {});
      }

      await prisma.ticketInstance.update({
        where: { id: inst.id },
        data: {
          status: 'CLOSED',
          closedAt,
          closedBy: SYSTEM_CLOSER,
          closedByName: meta.closedByName,
          closeReason: meta.closeReason,
          transcriptMessageId,
          transcriptText: transcriptMd,
          transcriptHtml,
          transcriptCreatedAt: closedAt,
        },
      });
      logAudit('TICKET_CLOSED_SYSTEM', 'TICKET', {
        guildId: inst.guildId, instanceId: inst.id, templateId,
        messages: collectedMsgs.length,
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

  // Channel-Name: `{NN}-{label}` mit pro-Template fortlaufender Nummer (siehe weiter unten).
  // Discord-Channel-Limit: 100 Zeichen, lowercase, nur a-z0-9 und -.
  const labelBase = t.label.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'ticket';

  let channel: TextChannel | null = null;
  let instance: Awaited<ReturnType<typeof prisma.ticketInstance.create>> | null = null;
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

    // Per-Template Counter atomar inkrementieren und als templateNumber persistieren.
    // Globale ticketNumber bleibt als interne Eindeutigkeits-ID erhalten, fuer Channel-Name
    // + Embeds wird die per-Template Nummer verwendet (parallele Nummernkreise pro Template).
    const { createdInstance, templateNumber } = await prisma.$transaction(async (tx) => {
      const updated = await tx.ticketTemplate.update({
        where: { id: t.id },
        data: { ticketCounter: { increment: 1 } },
        select: { ticketCounter: true },
      });
      const inst = await tx.ticketInstance.create({
        data: {
          templateId: t.id,
          guildId: guild.id,
          channelId: `pending:${btn.id}`,
          openerDiscordId: btn.user.id,
          openerName: btn.user.username,
          templateNumber: updated.ticketCounter,
          // Opener wird sofort als Teilnehmer erfasst (DB-Quelle der Wahrheit fuer Dashboard).
          userIds: [btn.user.id],
        },
      });
      return { createdInstance: inst, templateNumber: updated.ticketCounter };
    });
    instance = createdInstance;
    const openedAt = createdInstance.openedAt;
    const numStr = String(templateNumber).padStart(2, '0');
    // Channel-Name: NN-Label (Label kommt aus Template, ohne Username, fortlaufend pro Template).
    const safeName = `${numStr}-${labelBase}`.slice(0, 95);

    channel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: t.categoryId ?? undefined,
      permissionOverwrites: overwrites.map(o => ({
        id: o.id,
        ...(o.allow ? { allow: o.allow } : {}),
        ...(o.deny ? { deny: o.deny } : {}),
      })),
      reason: `Ticket #${numStr} (${t.label}) geoeffnet von ${btn.user.tag}`,
    }) as TextChannel;

    await prisma.ticketInstance.update({
      where: { id: createdInstance.id },
      data: { channelId: channel.id },
    });

    const messages = normalizeWelcomeMessages((t as unknown as { welcomeMessages?: unknown }).welcomeMessages, t.welcomeText);
    const color = parseColor(t.embedColor);

    const welcome = new EmbedBuilder()
      .setTitle(`🎫  ${t.label}`)
      .setDescription(messages[0])
      .setColor(color)
      .setTimestamp(openedAt)
      .addFields(
        { name: 'Eroeffnet von', value: `<@${btn.user.id}>`, inline: true },
        { name: 'Eroeffnet am', value: `<t:${Math.floor(openedAt.getTime() / 1000)}:F> (<t:${Math.floor(openedAt.getTime() / 1000)}:R>)`, inline: true },
        { name: 'Ticket-Nr.', value: `#${numStr}`, inline: true },
      )
      .setFooter({ text: `V-Bot Ticket-System  •  Slot ${t.slot}  •  #${numStr}` });

    const mentionRoleIds = Array.isArray((t as unknown as { mentionRoleIds?: unknown }).mentionRoleIds)
      ? ((t as unknown as { mentionRoleIds: unknown[] }).mentionRoleIds.filter((r): r is string => typeof r === 'string'))
      : [];
    const mentionLine = mentionRoleIds.length > 0
      ? mentionRoleIds.map(r => `<@&${r}>`).join(' ')
      : '';
    await channel.send({
      content: mentionLine || undefined,
      embeds: [welcome],
      components: [buildCloseButton(createdInstance.id)],
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
      guildId: guild.id, templateId: t.id, instanceId: createdInstance.id,
      ticketNumber: createdInstance.ticketNumber, templateNumber, channelId: channel.id, userId: btn.user.id,
      mentionedRoleIds: mentionRoleIds, mentionedRoleCount: mentionRoleIds.length,
      managerRoleIds,
    });

    await btn.editReply({ content: `Ticket erstellt: <#${channel.id}>` });
  } catch (e) {
    logger.error('Ticket-Open-Fehler', e as Error);
    // F1: Cleanup bei Teilfehler. Channel und Instance konsistent zuruecksetzen.
    // Lueckenlose Per-Template-Nummerierung: Counter zurueckrollen, wenn die Instance
    // ungenutzt geloescht wird. Nur dekrementieren, wenn die Instance wirklich diese Nummer
    // bekommen hat und der Counter seitdem nicht weitergelaufen ist (Atomar via WHERE-Clause).
    if (instance) {
      const inst = instance as unknown as { templateNumber?: number | null; templateId: string };
      const tn = inst.templateNumber;
      await prisma.ticketInstance.delete({ where: { id: instance.id } }).catch(() => {});
      if (typeof tn === 'number' && tn > 0) {
        await prisma.ticketTemplate.updateMany({
          where: { id: inst.templateId, ticketCounter: tn },
          data: { ticketCounter: { decrement: 1 } },
        }).catch(() => {});
      }
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
  // Mehrfach-Klick / Race-Schutz: pro Instance nur EIN aktiver Close-Vorgang.
  try {
    await withInstanceLock(instanceId, () => closeTicketLocked(btn, instanceId));
  } catch (e) {
    if ((e as Error).message === 'BUSY') {
      await btn.reply({ content: 'Schliess-Vorgang laeuft bereits.', ephemeral: true }).catch(() => {});
      return;
    }
    throw e;
  }
}

async function closeTicketLocked(btn: ButtonInteraction, instanceId: string): Promise<void> {
  const instance = await prisma.ticketInstance.findUnique({
    where: { id: instanceId },
    include: { template: true },
  });
  if (!instance || instance.status !== 'OPEN') {
    await btn.reply({ content: 'Ticket bereits geschlossen.', ephemeral: true });
    return;
  }

  // Permission-Check: Opener darf NICHT mehr eigenes Ticket schliessen (User-Vorgabe).
  // Nur Server-Owner, Discord-Administrator, Staff-Rolle und Manager-Rollen duerfen schliessen.
  // Konsistent mit canManageTicketForMember (gleicher Pfad wie AddUser).
  let canClose = false;
  if (btn.guild) {
    try {
      const member = await btn.guild.members.fetch(btn.user.id);
      canClose = canManageTicketForMember(member, instance, btn.guild.ownerId);
    } catch {
      // member fetch failed — leave canClose false
    }
  }
  // Hartes Veto: auch wenn der Opener selbst Manager-/Staff-Rolle traegt, darf er sein
  // EIGENES Ticket nicht schliessen (User-Anforderung: "Opener darf nicht close").
  if (btn.user.id === instance.openerDiscordId && btn.user.id !== btn.guild?.ownerId) {
    canClose = false;
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

    // templateNumber bevorzugen (per-Template Zaehler); Fallback auf globale ticketNumber fuer Legacy-Rows.
    const inst = instance as unknown as { templateNumber?: number | null; ticketNumber?: number };
    const displayNumber = inst.templateNumber ?? inst.ticketNumber ?? 0;
    const numStr = String(displayNumber).padStart(2, '0');
    const safeLabel = instance.template.label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'ticket';

    // Display-Name des Schliessenden bestimmen — KEINE Discord-IDs im sichtbaren Transcript.
    const closerMember = btn.guild ? await btn.guild.members.fetch(btn.user.id).catch(() => null) : null;
    const closedByName = closerMember?.displayName
      ?? btn.user.globalName
      ?? btn.user.username
      ?? 'Unbekannt';

    // Vorhandener Claimer (falls Feature spaeter genutzt wird).
    const instAny = instance as unknown as { claimedByName?: string | null; closeReason?: string | null };
    const claimedByName = instAny.claimedByName ?? null;
    const closeReason = instAny.closeReason ?? null;

    const closedAt = new Date();
    const collectedMsgs = collected.map(collectMessage);
    const meta: TranscriptMeta = {
      ticketLabel: instance.template.label,
      ticketNumber: numStr,
      channelName: ch.name,
      guildName: btn.guild?.name ?? 'Server',
      openedAt: instance.openedAt,
      openedByName: instance.openerName,
      closedAt,
      closedByName,
      claimedByName,
      closeReason,
      truncated,
      totalMessages: collectedMsgs.length,
    };

    const transcriptMd = buildTranscriptMarkdown(meta, collectedMsgs);
    const transcriptHtml = buildTranscriptHtml(meta, collectedMsgs);

    // Markdown-Datei (Plain-Backup als Discord-Anhang). Limit auf 8 MB cappen.
    let transcriptBuf = Buffer.from(transcriptMd, 'utf8');
    let transcriptTruncated = false;
    if (transcriptBuf.length > MAX_TRANSCRIPT_BYTES) {
      transcriptBuf = transcriptBuf.subarray(0, MAX_TRANSCRIPT_BYTES);
      transcriptTruncated = true;
    }
    const fileName = `ticket-${numStr}-${safeLabel}.md`;
    const file = new AttachmentBuilder(transcriptBuf, { name: fileName });

    const closedEmbed = buildClosedEmbed({
      meta,
      ticketLabel: instance.template.label,
      ticketNumber: numStr,
      openerDiscordId: instance.openerDiscordId,
      closedByDiscordId: btn.user.id,
      embedColor: instance.template.embedColor,
    });
    const closedButtons = buildClosedButtons(instance.id);

    let transcriptMessageId: string | null = null;
    const transcriptChannel = await btn.client.channels.fetch(instance.template.transcriptChannelId).catch(() => null);
    if (transcriptChannel && transcriptChannel.isTextBased() && !transcriptChannel.isDMBased()) {
      const sent = await (transcriptChannel as TextChannel).send({
        embeds: [closedEmbed],
        components: [closedButtons],
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
        const archiveFile = new AttachmentBuilder(transcriptBuf, { name: `archive-${numStr}-${safeLabel}.md` });
        await (archiveChannel as TextChannel).send({
          embeds: [closedEmbed],
          components: [closedButtons],
          files: [archiveFile],
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
    }

    // Striktes Verbot: KEINE DM. Transcript geht ausschliesslich in den konfigurierten Channel.

    await prisma.ticketInstance.update({
      where: { id: instance.id },
      data: {
        status: 'CLOSED',
        closedAt,
        closedBy: btn.user.id,
        closedByName,
        transcriptMessageId,
        transcriptText: transcriptMd,
        transcriptHtml,
        transcriptCreatedAt: closedAt,
      },
    });

    logAudit('TICKET_CLOSED', 'TICKET', {
      guildId: instance.guildId, instanceId: instance.id,
      ticketNumber: inst.ticketNumber, templateNumber: inst.templateNumber ?? null,
      closedBy: btn.user.id, messages: collectedMsgs.length,
      transcriptBytes: transcriptBuf.length,
      transcriptTruncated,
    });

    await btn.editReply({ content: 'Ticket geschlossen. Channel wird in 5 Sekunden geloescht.' });
    setTimeout(() => {
      ch.delete('Ticket geschlossen').catch(() => {});
    }, 5000);
  } catch (e) {
    logger.error('Ticket-Close-Fehler', e as Error);
    logAudit('TICKET_CLOSE_FAILED', 'TICKET', {
      guildId: instance.guildId, instanceId: instance.id,
      closedBy: btn.user.id, error: (e as Error).message,
    });
    await btn.editReply({ content: 'Konnte Ticket nicht schliessen. Bitte Admin informieren.' }).catch(() => {});
  }
}

/**
 * Add-User-Button: zeigt einem berechtigten Staff-Mitglied ein ephemeres
 * Discord-User-Select-Menu zur Auswahl des hinzuzufuegenden Nutzers.
 * Berechtigt: Server-Owner, Staff-Rolle, Manager-Rollen (analog Close-Permission).
 */
export async function handleAddUserButton(btn: ButtonInteraction): Promise<void> {
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
    await btn.reply({ content: 'Ticket nicht (mehr) offen.', ephemeral: true });
    return;
  }
  if (!btn.guild) {
    await btn.reply({ content: 'Nur in Servern verfuegbar.', ephemeral: true });
    return;
  }

  // Permission-Check: nur Owner / Staff / Manager (verhindert dass normale
  // User mit Channel-Zugriff via Button andere Mitglieder hinzufuegen koennen).
  const allowed = await canManageTicket(btn, instance);
  if (!allowed) {
    await btn.reply({
      content: 'Du hast keine Berechtigung, Nutzer zu diesem Ticket hinzuzufuegen.',
      ephemeral: true,
    });
    return;
  }

  const select = new UserSelectMenuBuilder()
    .setCustomId(`ttkt:adduser:${instanceId}`)
    .setPlaceholder('Nutzer auswaehlen...')
    .setMinValues(1)
    .setMaxValues(1);

  await btn.reply({
    content: 'Waehle den Nutzer aus, der zu diesem Ticket hinzugefuegt werden soll:',
    components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)],
    ephemeral: true,
  });
}

/**
 * Add-User-Select-Submit: validiert, prueft Mitgliedschaft, gewaehrt Channel-Zugriff
 * und persistiert den Nutzer in `TicketInstance.userIds`.
 */
export async function handleAddUserSelect(select: UserSelectMenuInteraction): Promise<void> {
  const instanceId = select.customId.split(':')[2];
  if (!instanceId || !select.guild) {
    await select.reply({ content: 'Ungueltige Select-ID.', ephemeral: true });
    return;
  }
  const instance = await prisma.ticketInstance.findUnique({
    where: { id: instanceId },
    include: { template: true },
  });
  if (!instance || instance.status !== 'OPEN') {
    await select.reply({ content: 'Ticket nicht (mehr) offen.', ephemeral: true });
    return;
  }

  // Re-Check Berechtigung (User koennte zwischenzeitlich Rolle verloren haben).
  // WICHTIG: gleicher Bypass wie im Button-Handler (Owner + Admin + Staff/Manager).
  const member = await select.guild.members.fetch(select.user.id).catch(() => null);
  const canAdd = canManageTicketForMember(member, instance, select.guild.ownerId);
  if (!canAdd) {
    await select.reply({ content: 'Du hast keine Berechtigung mehr.', ephemeral: true });
    return;
  }

  const targetId = select.values[0];
  if (!targetId || !/^\d{17,20}$/.test(targetId)) {
    await select.reply({ content: 'Kein gueltiger Nutzer ausgewaehlt.', ephemeral: true });
    return;
  }

  await select.deferReply({ ephemeral: true });

  // Target-User existiert in dieser Guild?
  const target = await select.guild.members.fetch(targetId).catch(() => null);
  if (!target) {
    await select.editReply({ content: 'Nutzer ist kein Mitglied dieses Servers.' });
    return;
  }
  if (target.user.bot) {
    await select.editReply({ content: 'Bots koennen nicht hinzugefuegt werden.' });
    return;
  }

  // Duplicate-Check (DB ist die Source-of-Truth).
  const existingUserIds = (instance as unknown as { userIds?: string[] }).userIds ?? [];
  if (existingUserIds.includes(target.id) || target.id === instance.openerDiscordId) {
    await select.editReply({ content: 'Nutzer ist bereits im Ticket hinzugefuegt.' });
    return;
  }

  const channel = await select.client.channels.fetch(instance.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await select.editReply({ content: 'Ticket-Channel nicht verfuegbar.' });
    return;
  }
  const ch = channel as TextChannel;

  try {
    await ch.permissionOverwrites.edit(target.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });
    // DB-State synchron halten: userIds Array um neuen Nutzer erweitern.
    await prisma.ticketInstance.update({
      where: { id: instance.id },
      data: { userIds: { set: [...existingUserIds, target.id] } },
    });
    await ch.send({
      content: `\u2795 <@${target.id}> wurde von <@${select.user.id}> zum Ticket hinzugefuegt.`,
      allowedMentions: { users: [target.id] },
    });
    logAudit('TICKET_USER_ADDED', 'TICKET', {
      guildId: instance.guildId,
      instanceId: instance.id,
      addedBy: select.user.id,
      addedUser: target.id,
    });
    await select.editReply({ content: `Nutzer <@${target.id}> hinzugefuegt.` });
  } catch (e) {
    logger.error('Ticket-AddUser-Fehler', e as Error);
    await select.editReply({ content: 'Konnte Nutzer nicht hinzufuegen.' });
  }
}

/**
/**
 * Berechtigungs-Helper: prueft frisch gegen DB+Member-Cache.
 * Owner / Discord-Administrator / Staff-Rolle / Manager-Rolle duerfen das Ticket verwalten.
 */
type TicketWithTemplate = Awaited<ReturnType<typeof prisma.ticketInstance.findUnique>> & {
  template: { staffRoleId: string | null; managerRoleIds?: unknown };
};

async function canManageTicket(btn: ButtonInteraction, instance: TicketWithTemplate | null): Promise<boolean> {
  if (!instance || !btn.guild) return false;
  if (btn.user.id === btn.guild.ownerId) return true;
  const m = await btn.guild.members.fetch(btn.user.id).catch(() => null);
  return canManageTicketForMember(m, instance, btn.guild.ownerId);
}

interface CanManageMember {
  id: string;
  roles: { cache: { has: (id: string) => boolean } };
  permissions?: { has: (perm: bigint) => boolean };
}

function canManageTicketForMember(
  member: CanManageMember | null,
  instance: TicketWithTemplate | null,
  guildOwnerId?: string,
): boolean {
  if (!instance || !member) return false;
  // Owner-Bypass (defensiv, falls aufrufer es nicht vorgeprueft hat).
  if (guildOwnerId && member.id === guildOwnerId) return true;
  // Discord-Administrator-Bypass: Server-Admins duerfen Ticket-Verwaltung machen.
  if (member.permissions && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (instance.template.staffRoleId && member.roles.cache.has(instance.template.staffRoleId)) return true;
  const managerRoleIds = (instance.template as unknown as { managerRoleIds?: unknown }).managerRoleIds;
  if (Array.isArray(managerRoleIds)) {
    for (const rid of managerRoleIds) {
      if (typeof rid === 'string' && member.roles.cache.has(rid)) return true;
    }
  }
  return false;
}

// ============================================================
// Reason-Bearbeiten: Button im "Ticket geschlossen"-Embed oeffnet ein
// Modal. Submission persistiert TicketInstance.closeReason und editiert
// das Embed mit dem aktualisierten Grund-Feld.
// ============================================================

export async function handleCloseReasonButton(btn: ButtonInteraction): Promise<void> {
  const instanceId = btn.customId.split(':')[2];
  if (!instanceId) {
    await btn.reply({ content: 'Ungueltige Button-ID.', ephemeral: true });
    return;
  }
  const inst = await prisma.ticketInstance.findUnique({
    where: { id: instanceId },
    include: { template: true },
  });
  if (!inst) {
    await btn.reply({ content: 'Ticket nicht gefunden.', ephemeral: true });
    return;
  }
  if (!btn.guild) {
    await btn.reply({ content: 'Nur in Servern verfuegbar.', ephemeral: true });
    return;
  }
  const member = await btn.guild.members.fetch(btn.user.id).catch(() => null);
  if (!canManageTicketForMember(member, inst, btn.guild.ownerId)) {
    await btn.reply({ content: 'Du darfst den Grund dieses Tickets nicht bearbeiten.', ephemeral: true });
    return;
  }
  const current = (inst as unknown as { closeReason?: string | null }).closeReason ?? '';
  const modal = new ModalBuilder()
    .setCustomId(`ttkt:reason:${instanceId}`)
    .setTitle('Grund bearbeiten');
  const input = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Schliess-Grund (max 500 Zeichen)')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(false)
    .setValue(current.slice(0, 500));
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await btn.showModal(modal);
}

export async function handleCloseReasonModal(modal: ModalSubmitInteraction): Promise<void> {
  const instanceId = modal.customId.split(':')[2];
  if (!instanceId) {
    await modal.reply({ content: 'Ungueltige Modal-ID.', ephemeral: true });
    return;
  }
  const inst = await prisma.ticketInstance.findUnique({
    where: { id: instanceId },
    include: { template: true },
  });
  if (!inst) {
    await modal.reply({ content: 'Ticket nicht gefunden.', ephemeral: true });
    return;
  }
  if (!modal.guild) {
    await modal.reply({ content: 'Nur in Servern verfuegbar.', ephemeral: true });
    return;
  }
  const member = await modal.guild.members.fetch(modal.user.id).catch(() => null);
  if (!canManageTicketForMember(member, inst, modal.guild.ownerId)) {
    await modal.reply({ content: 'Du darfst den Grund dieses Tickets nicht bearbeiten.', ephemeral: true });
    return;
  }
  const raw = modal.fields.getTextInputValue('reason').trim();
  const next: string | null = raw.length === 0 ? null : raw.slice(0, 500);

  // Persistiertes HTML in-place patchen, damit /transcripts/<id> sofort aktuell ist.
  // Marker: <!--reason--> ... <!--/reason--> wird vom HTML-Builder eingebettet.
  const instAny = inst as unknown as { transcriptHtml?: string | null };
  let nextHtml: string | null | undefined = undefined;
  if (typeof instAny.transcriptHtml === 'string') {
    const block = next === null ? ''
      : `<div><span class="k">Grund</span><span class="v">${htmlEscape(next)}</span></div>`;
    if (instAny.transcriptHtml.includes('<!--reason-->')) {
      nextHtml = instAny.transcriptHtml.replace(
        /<!--reason-->[\s\S]*?<!--\/reason-->/,
        `<!--reason-->${block}<!--/reason-->`,
      );
    }
  }

  await prisma.ticketInstance.update({
    where: { id: inst.id },
    data: {
      closeReason: next,
      ...(nextHtml !== undefined ? { transcriptHtml: nextHtml } : {}),
    },
  });

  // Embed im Transcript-Channel komplett neu rendern (sicherer als Field-Index-Patch).
  const tmId = (inst as unknown as { transcriptMessageId?: string | null }).transcriptMessageId;
  let embedPatched = false;
  if (tmId) {
    try {
      const ch = await modal.client.channels.fetch(inst.template.transcriptChannelId).catch(() => null);
      if (ch && ch.isTextBased() && !ch.isDMBased()) {
        const msg = await (ch as TextChannel).messages.fetch(tmId).catch(() => null);
        if (msg && msg.embeds[0]) {
          // Frische Daten ziehen (closedByName, claimedByName, openedAt usw.)
          const fresh = await prisma.ticketInstance.findUnique({
            where: { id: inst.id },
            include: { template: true },
          });
          if (fresh) {
            const fAny = fresh as unknown as {
              templateNumber?: number | null; ticketNumber?: number;
              closedByName?: string | null; claimedByName?: string | null;
              closeReason?: string | null;
            };
            const numStr = String(fAny.templateNumber ?? fAny.ticketNumber ?? 0).padStart(2, '0');
            const meta: TranscriptMeta = {
              ticketLabel: fresh.template.label,
              ticketNumber: numStr,
              channelName: msg.embeds[0].title?.replace(/^.*·\s*/, '') ?? fresh.template.label,
              guildName: modal.guild.name,
              openedAt: fresh.openedAt,
              openedByName: fresh.openerName,
              closedAt: fresh.closedAt ?? new Date(),
              closedByName: fAny.closedByName ?? 'Unbekannt',
              claimedByName: fAny.claimedByName ?? null,
              closeReason: fAny.closeReason ?? null,
              truncated: false,
              totalMessages: 0,
            };
            // totalMessages aus altem Embed retten (Field "Nachrichten").
            const oldFields = msg.embeds[0].fields ?? [];
            const msgsField = oldFields.find(f => f.name?.includes('Nachrichten'));
            if (msgsField) {
              const n = parseInt(msgsField.value || '0', 10);
              if (Number.isFinite(n)) meta.totalMessages = n;
            }
            const newEmbed = buildClosedEmbed({
              meta,
              ticketLabel: fresh.template.label,
              ticketNumber: numStr,
              openerDiscordId: fresh.openerDiscordId,
              closedByDiscordId: fresh.closedBy ?? SYSTEM_CLOSER,
              embedColor: fresh.template.embedColor,
            });
            await msg.edit({ embeds: [newEmbed] }).catch(() => {});
            embedPatched = true;
          }
        }
      }
    } catch (err) {
      logger.warn(`Reason-Edit: Embed-Patch fehlgeschlagen: ${(err as Error).message}`);
    }
  }

  logAudit('TICKET_REASON_EDITED', 'TICKET', {
    guildId: inst.guildId, instanceId: inst.id, byUser: modal.user.id,
    cleared: next === null, embedPatched,
  });

  await modal.reply({
    content: next === null
      ? `Grund entfernt.${embedPatched ? '' : ' (Embed konnte nicht aktualisiert werden.)'}`
      : `Grund aktualisiert.${embedPatched ? '' : ' (Embed konnte nicht aktualisiert werden.)'}`,
    ephemeral: true,
  });
}
