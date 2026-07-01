/**
 * Embed-Builder Helper (Dashboard-only).
 *
 * Baut aus einem DashboardEmbed-Datensatz einen discord.js-EmbedBuilder,
 * validiert die Discord-Limits + URLs + Channel-Anker und postet/editiert
 * die Nachricht im Ziel-Channel.
 *
 * Wird ausschliesslich vom Dashboard-Router `v2/embeds.ts` genutzt — es
 * existieren bewusst KEINE Slash-/Prefix-Commands fuer dieses Feature.
 */

import {
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type GuildTextBasedChannel,
} from 'discord.js';

// ── Discord-Limits (Stand API v10) ────────────────────────────────────────
export const EMBED_LIMITS = {
  content: 2000,
  title: 256,
  description: 4096,
  url: 512,
  authorName: 256,
  footerText: 2048,
  fieldName: 256,
  fieldValue: 1024,
  fieldCount: 25,
  total: 6000,
} as const;

export interface EmbedField {
  name: string;
  value: string;
  inline: boolean;
}

/** Strukturelle Sicht auf den DashboardEmbed-Datensatz (nur Anzeige-Felder). */
export interface EmbedData {
  content?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  color?: string | null;
  authorName?: string | null;
  authorIconUrl?: string | null;
  authorUrl?: string | null;
  footerText?: string | null;
  footerIconUrl?: string | null;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  showTimestamp?: boolean | null;
  fields?: unknown; // JSON aus der DB -> EmbedField[]
}

const CHANNEL_ANCHOR_RE = /<#(\d{17,20})>/g;

function s(v: string | null | undefined): string {
  return (v ?? '').trim();
}

/** Parst das JSON-`fields`-Feld defensiv in ein sauberes EmbedField[]. */
export function parseFields(raw: unknown): EmbedField[] {
  if (!Array.isArray(raw)) return [];
  const out: EmbedField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name : '';
    const value = typeof rec.value === 'string' ? rec.value : '';
    if (name.trim().length === 0 || value.trim().length === 0) continue;
    out.push({ name, value, inline: rec.inline === true });
  }
  return out;
}

/** #RRGGBB oder #AARRGGBB -> 0xRRGGBB (Alpha wird verworfen). null bei Leerwert. */
export function parseEmbedColor(hex: string | null | undefined): number | null {
  const v = s(hex).replace(/^#/, '');
  if (v.length === 6 && /^[0-9a-fA-F]{6}$/.test(v)) return parseInt(v, 16);
  if (v.length === 8 && /^[0-9a-fA-F]{8}$/.test(v)) return parseInt(v.slice(2), 16); // AARRGGBB -> RRGGBB
  return null;
}

/** true, wenn `url` eine gueltige http(s)-URL innerhalb der Laengenbegrenzung ist. */
export function isValidHttpUrl(url: string | null | undefined): boolean {
  const v = s(url);
  if (v.length === 0) return true; // leer = nicht gesetzt = ok
  if (v.length > EMBED_LIMITS.url) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** true, wenn der Embed sichtbaren Inhalt hat (Discord lehnt leere Embeds ab). */
export function embedHasContent(data: EmbedData): boolean {
  return (
    s(data.title).length > 0 ||
    s(data.description).length > 0 ||
    s(data.authorName).length > 0 ||
    s(data.footerText).length > 0 ||
    s(data.thumbnailUrl).length > 0 ||
    s(data.imageUrl).length > 0 ||
    parseFields(data.fields).length > 0
  );
}

/**
 * Validiert alle Discord-Limits + URLs. Gibt eine Fehlermeldung (deutsch)
 * zurueck oder `null`, wenn alles gueltig ist.
 */
export function validateEmbedContent(data: EmbedData): string | null {
  const content = s(data.content);
  if (content.length > EMBED_LIMITS.content) {
    return `Nachrichtentext darf max. ${EMBED_LIMITS.content} Zeichen haben.`;
  }
  if (s(data.title).length > EMBED_LIMITS.title) {
    return `Titel darf max. ${EMBED_LIMITS.title} Zeichen haben.`;
  }
  if (s(data.description).length > EMBED_LIMITS.description) {
    return `Beschreibung darf max. ${EMBED_LIMITS.description} Zeichen haben.`;
  }
  if (s(data.authorName).length > EMBED_LIMITS.authorName) {
    return `Autor-Name darf max. ${EMBED_LIMITS.authorName} Zeichen haben.`;
  }
  if (s(data.footerText).length > EMBED_LIMITS.footerText) {
    return `Footer-Text darf max. ${EMBED_LIMITS.footerText} Zeichen haben.`;
  }

  const fields = parseFields(data.fields);
  if (fields.length > EMBED_LIMITS.fieldCount) {
    return `Maximal ${EMBED_LIMITS.fieldCount} Felder erlaubt.`;
  }
  for (const f of fields) {
    if (f.name.length > EMBED_LIMITS.fieldName) {
      return `Feld-Name darf max. ${EMBED_LIMITS.fieldName} Zeichen haben.`;
    }
    if (f.value.length > EMBED_LIMITS.fieldValue) {
      return `Feld-Wert darf max. ${EMBED_LIMITS.fieldValue} Zeichen haben.`;
    }
  }

  // URL-Validierung
  const urlChecks: Array<[string, string | null | undefined]> = [
    ['Embed-URL', data.url],
    ['Autor-URL', data.authorUrl],
    ['Autor-Icon-URL', data.authorIconUrl],
    ['Footer-Icon-URL', data.footerIconUrl],
    ['Thumbnail-URL', data.thumbnailUrl],
    ['Bild-URL', data.imageUrl],
  ];
  for (const [label, url] of urlChecks) {
    if (!isValidHttpUrl(url)) {
      return `${label} ist keine gueltige http(s)-URL.`;
    }
  }

  if (s(data.color).length > 0 && parseEmbedColor(data.color) === null) {
    return 'Farbe muss ein Hex-Wert im Format #RRGGBB oder #AARRGGBB sein.';
  }

  // Gesamt-Zeichenbudget (Discord: 6000 ueber alle Text-Felder)
  const total =
    s(data.title).length +
    s(data.description).length +
    s(data.authorName).length +
    s(data.footerText).length +
    fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  if (total > EMBED_LIMITS.total) {
    return `Der Embed ueberschreitet das Gesamt-Limit von ${EMBED_LIMITS.total} Zeichen (aktuell ${total}).`;
  }

  return null;
}

/** Extrahiert alle eindeutigen Channel-Anker (`<#id>`) aus den Textfeldern. */
export function extractChannelAnchors(data: EmbedData): string[] {
  const fields = parseFields(data.fields);
  const haystack = [
    s(data.content),
    s(data.description),
    s(data.footerText),
    ...fields.flatMap((f) => [f.name, f.value]),
  ].join('\n');
  const ids = new Set<string>();
  for (const m of haystack.matchAll(CHANNEL_ANCHOR_RE)) {
    ids.add(m[1]);
  }
  return [...ids];
}

/**
 * Prueft, dass jeder Channel-Anker (`<#id>`) zu dieser Guild gehoert und der
 * Bot ihn sehen kann. `client === null` (Tests) -> Skip.
 */
export async function validateChannelAnchors(
  client: Client | null,
  guildId: string,
  data: EmbedData,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!client) return { ok: true };
  for (const channelId of extractChannelAnchors(data)) {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased() || ch.isDMBased()) {
      return { ok: false, reason: `Verlinkter Channel <#${channelId}> existiert nicht oder ist kein Text-Channel.` };
    }
    const gch = ch as GuildTextBasedChannel;
    if (gch.guildId !== guildId) {
      return { ok: false, reason: `Verlinkter Channel <#${channelId}> gehoert nicht zu dieser Guild.` };
    }
    const me = gch.guild?.members?.me;
    if (me && !gch.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)) {
      return { ok: false, reason: `Bot kann den verlinkten Channel <#${channelId}> nicht sehen.` };
    }
  }
  return { ok: true };
}

/** Baut den discord.js-EmbedBuilder aus dem Datensatz. */
export function buildDiscordEmbed(data: EmbedData): EmbedBuilder {
  const embed = new EmbedBuilder();

  const title = s(data.title);
  if (title) embed.setTitle(title.slice(0, EMBED_LIMITS.title));

  const description = s(data.description);
  if (description) embed.setDescription(description.slice(0, EMBED_LIMITS.description));

  const url = s(data.url);
  if (url && isValidHttpUrl(url)) embed.setURL(url);

  const color = parseEmbedColor(data.color);
  if (color !== null) embed.setColor(color);

  const authorName = s(data.authorName);
  if (authorName) {
    const iconURL = s(data.authorIconUrl);
    const authorUrl = s(data.authorUrl);
    embed.setAuthor({
      name: authorName.slice(0, EMBED_LIMITS.authorName),
      ...(iconURL && isValidHttpUrl(iconURL) ? { iconURL } : {}),
      ...(authorUrl && isValidHttpUrl(authorUrl) ? { url: authorUrl } : {}),
    });
  }

  const footerText = s(data.footerText);
  if (footerText) {
    const iconURL = s(data.footerIconUrl);
    embed.setFooter({
      text: footerText.slice(0, EMBED_LIMITS.footerText),
      ...(iconURL && isValidHttpUrl(iconURL) ? { iconURL } : {}),
    });
  }

  const thumbnailUrl = s(data.thumbnailUrl);
  if (thumbnailUrl && isValidHttpUrl(thumbnailUrl)) embed.setThumbnail(thumbnailUrl);

  const imageUrl = s(data.imageUrl);
  if (imageUrl && isValidHttpUrl(imageUrl)) embed.setImage(imageUrl);

  if (data.showTimestamp) embed.setTimestamp(new Date());

  const fields = parseFields(data.fields).slice(0, EMBED_LIMITS.fieldCount);
  if (fields.length > 0) {
    embed.addFields(
      fields.map((f) => ({
        name: f.name.slice(0, EMBED_LIMITS.fieldName),
        value: f.value.slice(0, EMBED_LIMITS.fieldValue),
        inline: f.inline,
      })),
    );
  }

  return embed;
}

// Serialisiert konkurrierende Post/Edit-Aufrufe pro Embed-ID (kein Doppel-Post).
const postLocks = new Map<string, Promise<{ messageId: string }>>();

export interface SendableEmbed extends EmbedData {
  id: string;
  guildId: string;
  channelId: string | null;
  messageId: string | null;
}

/**
 * Postet den Embed im Ziel-Channel — oder editiert die bestehende Nachricht,
 * wenn `messageId` gesetzt und noch vorhanden ist. Gibt die (ggf. neue)
 * messageId zurueck. Mentions werden bewusst unterdrueckt.
 */
export async function sendOrEditEmbed(
  client: Client,
  row: SendableEmbed,
): Promise<{ messageId: string }> {
  const prev = postLocks.get(row.id);
  if (prev) {
    try { await prev; } catch { /* vorheriger Lauf-Fehler ignorieren */ }
  }

  const run = (async (): Promise<{ messageId: string }> => {
    if (!row.channelId) throw new Error('Kein Ziel-Channel gesetzt.');

    const channel = await client.channels.fetch(row.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      throw new Error('Ziel-Channel nicht verfuegbar oder kein Text-Channel.');
    }
    const gch = channel as GuildTextBasedChannel;
    if (gch.guildId !== row.guildId) {
      throw new Error('Ziel-Channel gehoert nicht zur richtigen Guild.');
    }

    if (!embedHasContent(row)) {
      throw new Error('Embed hat keinen sichtbaren Inhalt.');
    }

    const embed = buildDiscordEmbed(row);
    const content = s(row.content) || undefined;
    const payload = { content, embeds: [embed], allowedMentions: { parse: [] as never[] } };

    let messageId = row.messageId;
    if (messageId) {
      try {
        const existing = await gch.messages.fetch(messageId);
        await existing.edit(payload);
        return { messageId };
      } catch {
        messageId = null; // Nachricht wurde geloescht -> neu posten
      }
    }
    const sent = await gch.send(payload);
    return { messageId: sent.id };
  })();

  postLocks.set(row.id, run);
  try {
    return await run;
  } finally {
    if (postLocks.get(row.id) === run) postLocks.delete(row.id);
  }
}
