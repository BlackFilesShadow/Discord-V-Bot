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

type TargetLookup = CommandServerTarget | 'AMBIGUOUS' | null;

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

function findSelectedTarget(targets: CommandServerTarget[], raw: string): TargetLookup {
  const byId = targets.find(target => target.id === raw);
  if (byId) return byId;

  const bySlot = targets.find(target => String(target.slot) === raw);
  if (bySlot) return bySlot;

  const normalized = raw.toLowerCase();
  const aliasMatches = targets.filter(target => target.alias.toLowerCase() === normalized);
  if (aliasMatches.length === 1) return aliasMatches[0];
  if (aliasMatches.length > 1) return 'AMBIGUOUS';
  return null;
}

async function rejectMissingTargets(interaction: ChatInputCommandInteraction): Promise<null> {
  await interaction.reply({
    content: 'Kein aktiver, verknuepfter Nitrado-Gameserver verfuegbar.',
    flags: MessageFlags.Ephemeral,
  });
  return null;
}

async function rejectUnknownTarget(
  interaction: ChatInputCommandInteraction,
  targets: CommandServerTarget[],
): Promise<null> {
  const available = targets.map(t => `• **${t.alias}** (Slot ${t.slot})`).join('\n');
  await interaction.reply({
    content: `Der ausgewaehlte Server gehoert nicht zu den aktiven Gameservern dieser Guild.\n\n${available}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  return null;
}

async function rejectAmbiguousTarget(
  interaction: ChatInputCommandInteraction,
  targets: CommandServerTarget[],
): Promise<null> {
  const available = targets.map(t => `• **${t.alias}** (Slot ${t.slot})`).join('\n');
  await interaction.reply({
    content: `Dieser Alias ist nicht eindeutig. Waehle den Server aus der Discord-Autocomplete-Liste oder verwende die eindeutige Slotnummer.\n\n${available}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  return null;
}

export async function resolveSelectedOrAllServers(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<CommandServerTarget[] | null> {
  const targets = await listCommandServerTargets(guildId);
  if (targets.length === 0) return rejectMissingTargets(interaction);

  const raw = interaction.options.getString('slot')?.trim() ?? '';
  if (!raw) return targets;

  const selected = findSelectedTarget(targets, raw);
  if (selected === 'AMBIGUOUS') return rejectAmbiguousTarget(interaction, targets);
  if (!selected) return rejectUnknownTarget(interaction, targets);
  return [selected];
}

export async function resolveSingleServer(
  interaction: ChatInputCommandInteraction,
  guildId: string,
): Promise<CommandServerTarget | null> {
  const targets = await listCommandServerTargets(guildId);
  if (targets.length === 0) return rejectMissingTargets(interaction);

  const raw = interaction.options.getString('slot')?.trim() ?? '';
  if (raw) {
    const selected = findSelectedTarget(targets, raw);
    if (selected === 'AMBIGUOUS') return rejectAmbiguousTarget(interaction, targets);
    if (!selected) return rejectUnknownTarget(interaction, targets);
    return selected;
  }

  if (targets.length === 1) return targets[0];

  const available = targets.map(t => `• **${t.alias}** (Slot ${t.slot})`).join('\n');
  await interaction.reply({
    content: `Mehrere aktive Gameserver gefunden. Waehle fuer diesen Vorgang den Server ueber seinen Alias aus.\n\n${available}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  return null;
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

/** Visible embed/server labels use only the configured alias. Slot numbers stay internal/UI-only. */
export function targetLabel(target: Pick<CommandServerTarget, 'alias' | 'slot'>): string {
  return target.alias;
}
