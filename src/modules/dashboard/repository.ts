/**
 * Dashboard-Guild-Link-Repository — pro Guild ein Eintrag, 5-stelliger alias5.
 */
import prisma from '../../database/prisma';
import type { GuildId, UserDiscordId } from '../../types/scope';

export interface DashboardLinkRow {
  guildId: GuildId;
  ownerDiscordId: UserDiscordId;
  alias5: string;
  createdAt: Date;
}

function gen5(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function uniqueAlias5(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const c = gen5();
    const exists = await prisma.dashboardGuildLink.findUnique({ where: { alias5: c } });
    if (!exists) return c;
  }
  throw new Error('Konnte keinen freien Guild-Identifier generieren');
}

export async function getOrCreate(
  guildId: GuildId,
  ownerDiscordId: UserDiscordId,
): Promise<DashboardLinkRow> {
  const existing = await prisma.dashboardGuildLink.findUnique({ where: { guildId } });
  if (existing) {
    return {
      guildId: existing.guildId as GuildId,
      ownerDiscordId: existing.ownerDiscordId as UserDiscordId,
      alias5: existing.alias5,
      createdAt: existing.createdAt,
    };
  }
  const alias5 = await uniqueAlias5();
  const created = await prisma.dashboardGuildLink.create({
    data: { guildId, ownerDiscordId, alias5 },
  });
  return {
    guildId: created.guildId as GuildId,
    ownerDiscordId: created.ownerDiscordId as UserDiscordId,
    alias5: created.alias5,
    createdAt: created.createdAt,
  };
}

export async function get(guildId: GuildId): Promise<DashboardLinkRow | null> {
  const row = await prisma.dashboardGuildLink.findUnique({ where: { guildId } });
  if (!row) return null;
  return {
    guildId: row.guildId as GuildId,
    ownerDiscordId: row.ownerDiscordId as UserDiscordId,
    alias5: row.alias5,
    createdAt: row.createdAt,
  };
}
