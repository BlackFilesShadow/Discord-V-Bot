import type { ExtendedClient, Command } from '../types';
import { classifyCommand, type CommandCategory, type MigrationStatus } from './inventory';

export type CommandAudience = 'public' | 'admin' | 'developer' | 'manufacturer';

export interface CommandCatalogEntry {
  name: string;
  description: string;
  source: string | null;
  category: CommandCategory;
  audience: CommandAudience;
  migrationStatus: MigrationStatus;
  dashboardReplacement: boolean;
  staysInDiscord: boolean;
  cooldownSeconds: number | null;
}

function audienceOf(command: Command): CommandAudience {
  if (command.devOnly) return 'developer';
  if (command.manufacturerOnly) return 'manufacturer';
  if (command.adminOnly) return 'admin';
  return 'public';
}

/**
 * Canonical live command catalog. Discord /help and dashboard diagnostics must
 * derive command metadata from this registry instead of maintaining separate
 * handwritten command lists.
 */
export function buildCommandCatalog(client: ExtendedClient): CommandCatalogEntry[] {
  const entries = [...client.commands.values()].map((command) => {
    const source = client.commandSources?.get(command.data.name) ?? null;
    const classification = classifyCommand({
      name: command.data.name,
      source: source ?? undefined,
      adminOnly: command.adminOnly,
      devOnly: command.devOnly,
      manufacturerOnly: command.manufacturerOnly,
    });
    const json = command.data.toJSON();
    return {
      name: command.data.name,
      description: json.description ?? '',
      source,
      category: classification.category,
      audience: audienceOf(command),
      migrationStatus: classification.migrationStatus,
      dashboardReplacement: classification.dashboardReplacement,
      staysInDiscord: classification.staysInDiscord,
      cooldownSeconds: typeof command.cooldown === 'number' ? command.cooldown : null,
    } satisfies CommandCatalogEntry;
  });
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function visibleCommandCatalog(
  client: ExtendedClient,
  access: { isAdmin: boolean; isDeveloper: boolean; isManufacturer: boolean },
): CommandCatalogEntry[] {
  return buildCommandCatalog(client).filter((entry) => {
    if (!entry.staysInDiscord) return false;
    if (entry.audience === 'developer') return access.isDeveloper;
    if (entry.audience === 'admin') return access.isAdmin;
    if (entry.audience === 'manufacturer') return access.isManufacturer;
    return true;
  });
}

export function commandCatalogSummary(entries: readonly CommandCatalogEntry[]) {
  return {
    total: entries.length,
    public: entries.filter((e) => e.audience === 'public').length,
    admin: entries.filter((e) => e.audience === 'admin').length,
    developer: entries.filter((e) => e.audience === 'developer').length,
    manufacturer: entries.filter((e) => e.audience === 'manufacturer').length,
    dashboardReplacement: entries.filter((e) => e.dashboardReplacement).length,
  };
}
