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
 * Kanonischer Live-Katalog der Loader-Registry. Diagnostik darf die komplette
 * Registry sehen; oeffentliche Hilfe wird ausschliesslich ueber
 * visibleCommandCatalog() erzeugt.
 */
export function buildCommandCatalog(client: ExtendedClient): CommandCatalogEntry[] {
  const entries = [...client.commands.values()].map(command => {
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
  return buildCommandCatalog(client).filter(entry => {
    // Deploy-Wahrheit zuerst: migrierte/entfernte Commands erscheinen nie.
    if (!entry.staysInDiscord) return false;

    // Produktvorgabe: /ai und DEV-Commands sind in /help vollstaendig unsichtbar,
    // auch fuer privilegierte Nutzer. Der technische Live-Katalog bleibt fuer
    // Diagnostik separat ueber buildCommandCatalog() verfuegbar.
    if (entry.name === 'ai' || entry.audience === 'developer') return false;

    if (entry.audience === 'admin') return access.isAdmin;
    if (entry.audience === 'manufacturer') return access.isManufacturer;
    return true;
  });
}

export function commandCatalogSummary(entries: readonly CommandCatalogEntry[]) {
  return {
    total: entries.length,
    public: entries.filter(entry => entry.audience === 'public').length,
    admin: entries.filter(entry => entry.audience === 'admin').length,
    developer: entries.filter(entry => entry.audience === 'developer').length,
    manufacturer: entries.filter(entry => entry.audience === 'manufacturer').length,
    dashboardReplacement: entries.filter(entry => entry.dashboardReplacement).length,
  };
}
