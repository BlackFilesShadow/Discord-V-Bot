/**
 * Zentrale Channel-Validierung fuer Dashboard-Routes und Embed-Poster.
 *
 * Prueft in einem Schritt:
 *   - Existenz (`channels.fetch`)
 *   - Channel-Type (text-based, nicht DM)
 *   - Guild-Membership (channel.guildId === guildId)
 *   - Bot-Permissions (Subset von `requiredPerms`)
 *
 * Verwendung in Dashboard-Save-Routes verhindert, dass Admins Channel
 * konfigurieren, in denen der Bot nicht senden kann (sonst silent failure
 * spaeter beim Embed-Post).
 */

import { PermissionFlagsBits, type Client, type GuildChannel, type PermissionResolvable } from 'discord.js';

export type ChannelValidation = { ok: true } | { ok: false; reason: string };

const PERM_LABELS: Record<string, string> = {
  [String(PermissionFlagsBits.SendMessages)]: 'SendMessages',
  [String(PermissionFlagsBits.EmbedLinks)]: 'EmbedLinks',
  [String(PermissionFlagsBits.AttachFiles)]: 'AttachFiles',
  [String(PermissionFlagsBits.ManageMessages)]: 'ManageMessages',
  [String(PermissionFlagsBits.ViewChannel)]: 'ViewChannel',
  [String(PermissionFlagsBits.ManageChannels)]: 'ManageChannels',
  [String(PermissionFlagsBits.ManageRoles)]: 'ManageRoles',
};

function permLabel(p: PermissionResolvable): string {
  return PERM_LABELS[String(p)] ?? String(p);
}

/**
 * Validiert, dass `channelId` zu `guildId` gehoert UND der Bot die geforderten
 * Permissions hat. Wenn `client` `null` ist (z.B. Tests), wird `{ ok: true }`
 * zurueckgegeben (Skip).
 */
export async function validateBotChannelAccess(
  client: Client | null,
  guildId: string,
  channelId: string,
  requiredPerms: PermissionResolvable[],
): Promise<ChannelValidation> {
  if (!client) return { ok: true };

  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) return { ok: false, reason: 'Channel existiert nicht oder Bot hat keinen Zugriff.' };
  if (!ch.isTextBased() || ch.isDMBased()) {
    return { ok: false, reason: 'Channel ist kein Text-Channel.' };
  }
  const gch = ch as GuildChannel;
  if (gch.guildId !== guildId) {
    return { ok: false, reason: 'Channel gehoert nicht zu dieser Guild.' };
  }
  const me = gch.guild?.members?.me;
  if (!me) return { ok: false, reason: 'Bot ist nicht in der Guild.' };
  const perms = gch.permissionsFor(me);
  if (!perms) return { ok: false, reason: 'Bot-Permissions konnten nicht ermittelt werden.' };
  for (const p of requiredPerms) {
    if (!perms.has(p)) {
      return { ok: false, reason: `Bot fehlt Permission "${permLabel(p)}" im Channel.` };
    }
  }
  return { ok: true };
}
