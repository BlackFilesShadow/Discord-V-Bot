import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type TextChannel,
} from 'discord.js';
import type { GuildId } from '../../types/scope';

export interface MarketDiscordChannelConfig {
  catalogChannelId: string | null;
  directBuyEnabled: boolean;
  directBuyChannelId: string | null;
  orderChannelId: string | null;
  orderReadyChannelId: string | null;
}

function discordCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' || typeof code === 'string' ? String(code) : null;
}

function discordMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : 'unbekannter Discord-Fehler';
}

async function requireTextChannel(
  client: Client,
  guildId: GuildId,
  channelId: string,
  label: string,
): Promise<TextChannel> {
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) throw new Error('V-Bot ist nicht mit diesem Discord-Server verbunden.');

  let fetched;
  try {
    fetched = await guild.channels.fetch(channelId);
  } catch (error) {
    const code = discordCode(error);
    if (code === '10003') throw new Error(`${label} wurde auf Discord nicht gefunden oder wurde gelöscht.`);
    if (code === '50001') throw new Error(`V-Bot hat keinen Zugriff auf den ${label}.`);
    if (code === '50013') throw new Error(`V-Bot fehlen Berechtigungen im ${label}.`);
    throw new Error(`${label} konnte nicht von Discord gelesen werden: ${discordMessage(error)}`);
  }

  if (!fetched) throw new Error(`${label} wurde auf Discord nicht gefunden oder ist für V-Bot nicht sichtbar.`);
  if (fetched.type !== ChannelType.GuildText) throw new Error(`${label} muss ein normaler Discord-Textkanal sein.`);

  const channel = fetched as TextChannel;
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) throw new Error('V-Bot-Mitglied konnte auf diesem Discord-Server nicht aufgelöst werden.');

  const perms = channel.permissionsFor(me);
  const required = [
    [PermissionFlagsBits.ViewChannel, 'Kanal ansehen'],
    [PermissionFlagsBits.SendMessages, 'Nachrichten senden'],
    [PermissionFlagsBits.EmbedLinks, 'Links einbetten'],
    [PermissionFlagsBits.ReadMessageHistory, 'Nachrichtenverlauf lesen'],
  ] as const;
  const missing = required.filter(([permission]) => !perms?.has(permission)).map(([, name]) => name);
  if (missing.length > 0) {
    throw new Error(`V-Bot fehlen im ${label} folgende Rechte: ${missing.join(', ')}.`);
  }

  return channel;
}

export async function validateMarketDiscordChannels(
  client: Client,
  guildId: GuildId,
  config: MarketDiscordChannelConfig,
): Promise<void> {
  if (config.catalogChannelId) {
    await requireTextChannel(client, guildId, config.catalogChannelId, 'Verkaufsliste-Kanal');
  }

  if (!config.directBuyEnabled) return;
  if (!config.directBuyChannelId) throw new Error('Bei aktiviertem Direktkauf muss ein Direktkauf-Kanal gewählt werden.');
  if (!config.orderChannelId) throw new Error('Bei aktiviertem Direktkauf muss ein Bestellungs-Kanal gewählt werden.');
  if (!config.orderReadyChannelId) throw new Error('Bei aktiviertem Direktkauf muss ein Bestellung-bereit-Kanal gewählt werden.');

  await requireTextChannel(client, guildId, config.directBuyChannelId, 'Direktkauf-Kanal');
  await requireTextChannel(client, guildId, config.orderChannelId, 'Bestellungs-Kanal');
  await requireTextChannel(client, guildId, config.orderReadyChannelId, 'Bestellung-bereit-Kanal');
}
