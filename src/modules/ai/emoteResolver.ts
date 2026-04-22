import { Guild } from 'discord.js';

/**
 * Wandelt `:emoji_name:` Vorkommen in einem Text in das Discord-Format `<:name:id>`
 * (bzw. `<a:name:id>` f\u00fcr animierte Emojis) um.
 *
 * Suchreihenfolge:
 *   1. Aktueller Server (bevorzugt, falls Name-Konflikt)
 *   2. ALLE anderen Server, in denen der Bot Mitglied ist (z.B. Emoji-Hub-Server)
 *
 * So kann der Owner einen privaten "Emoji-Vault"-Server anlegen, dort beliebige
 * Custom-Emojis hochladen und den Bot einladen \u2014 die Emojis sind dann auf
 * allen anderen Servern via `:name:` verwendbar (Discord erlaubt das via
 * "Externe Emojis verwenden"-Berechtigung).
 *
 * Unbekannte `:name:` werden unver\u00e4ndert gelassen (k\u00f6nnten Smileys wie `:)` sein).
 */
export function resolveCustomEmotes(text: string, guild: Guild | null | undefined): string {
  if (!text) return text;
  // Nicht innerhalb bereits formatierter Emojis matchen: < ... >
  return text.replace(/(?<!<a?):([a-zA-Z0-9_]{2,32}):(?![0-9]+>)/g, (match, name) => {
    // 1. Lokaler Server bevorzugt
    let emoji = guild?.emojis.cache.find(e => e.name === name);

    // 2. Fallback: alle anderen Guilds, in denen der Bot ist (Emoji-Hub)
    if (!emoji && guild?.client) {
      for (const g of guild.client.guilds.cache.values()) {
        if (guild && g.id === guild.id) continue;
        const found = g.emojis.cache.find(e => e.name === name);
        if (found) {
          emoji = found;
          break;
        }
      }
    }

    if (!emoji || !emoji.id) return match;
    return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
  });
}
