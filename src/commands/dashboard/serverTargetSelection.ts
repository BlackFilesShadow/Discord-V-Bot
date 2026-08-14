import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import prisma from '../../database/prisma';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';

export interface CommandServerTarget {
  id: string;
  guildId: string;
  slot: number;
  alias: string;
  nitradoServerId: string;
  encryptedToken: string;
}

export async function listCommandServerTargets(guildId: string): Promise<CommandServerTarget[]> {
  const rows = await prisma.nitradoConnection.findMany({
    where: {
      guildId,
      status: 'ACTIVE',
      nitradoServerId: { not: null },
      slot: { gte: 1, lte: MAX_GAME_SERVERS_PER_GUILD },
    },
    select: {
      id: true,
      guildId: true,
      slot: true,
      alias: true,
      nitradoServerId: true,
      encryptedToken: true,
    },
    orderBy: [{ slot: 'asc' }, { id: 'asc' }],
  });

  return rows
    .filter((row): row is typeof row & { nitradoServerId: string } => Boolean(row.nitradoServerId))
    .map(row => ({
      id: row.id,
      guildId: row.guildId,
      slot: row.slot,
      alias: row.alias,
      nitradoServerId: row.nitradoServerId,
      encryptedToken: row.encryptedToken,
    }));
}

/**
 * `slot` ist absichtlich eine String-Autocomplete-Option. Discord zeigt dem
 * Operator den hinterlegten Alias, waehrend als stabiler Wert die Connection-ID
 * uebertragen wird. Ohne Auswahl gilt die Operation fuer ALLE nutzbaren,
 * verknuepften Gameserver der Guild.
 */
export async function resolveSelectedOrAllServers(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<CommandServerTarget[] | null> {
  const targets = await listCommandServerTargets(guildId);
  if (targets.length === 0) {
    await interaction.reply({
      content: 'Kein aktiver, verknuepfter Nitrado-Gameserver verfuegbar.',
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const raw = interaction.options.getString('slot')?.trim() ?? '';
  if (!raw) return targets;

  const normalized = raw.toLowerCase();
  const selected = targets.find(target =>
    target.id === raw
    || target.alias.toLowerCase() === normalized
    || String(target.slot) === raw,
  );
  if (!selected) {
    const available = targets.map(t => `• **${t.alias}** (Slot ${t.slot})`).join('\n');
    await interaction.reply({
      content: `Der ausgewaehlte Server gehoert nicht zu den aktiven Gameservern dieser Guild.\n\n${available}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return null;
  }

  return [selected];
}

export async function autocompleteServerAlias(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = String(interaction.options.getFocused() ?? '').trim().toLowerCase();
  const targets = await listCommandServerTargets(interaction.guildId);
  const choices = targets
    .filter(t => !focused
      || t.alias.toLowerCase().includes(focused)
      || String(t.slot).includes(focused))
    .slice(0, 25)
    .map(t => ({
      name: `${t.alias} (Slot ${t.slot})`.slice(0, 100),
      value: t.id,
    }));

  await interaction.respond(choices);
}

export function targetLabel(target: Pick<CommandServerTarget, 'alias' | 'slot'>): string {
  return `${target.alias} (Slot ${target.slot})`;
}
