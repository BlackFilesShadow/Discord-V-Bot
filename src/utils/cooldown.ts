/**
 * Zentrales Cooldown-System für Slash-Commands.
 *
 * In-Memory Map (kein DB-Roundtrip → 0ms-Latenz, hält Discord 3s-Limit ein).
 * Pro Bot-Restart werden Cooldowns zurückgesetzt — das ist akzeptabel,
 * weil Cooldowns ohnehin im Sekunden-/Minutenbereich liegen.
 *
 * Verwendung im Command-Handler:
 *   const cd = checkCooldown(userId, commandName, command.cooldown);
 *   if (!cd.ok) { reply(`Bitte ${cd.remainingSec}s warten.`); return; }
 */

interface CooldownEntry {
  expiresAt: number;
}

const cooldowns = new Map<string, CooldownEntry>();

const CLEANUP_INTERVAL_MS = 60_000;
const MAX_ENTRIES = 50_000; // Sicherheitsventil gegen unbegrenztes Wachstum

function key(userId: string, command: string): string {
  return `${userId}:${command}`;
}

export interface CooldownResult {
  ok: boolean;
  remainingSec: number;
}

/**
 * Prüft Cooldown und setzt einen neuen, falls noch keiner aktiv.
 * @returns ok=true wenn ausführbar, ok=false mit verbleibender Wartezeit wenn nicht.
 */
export function checkCooldown(userId: string, command: string, seconds: number | undefined): CooldownResult {
  if (!seconds || seconds <= 0) return { ok: true, remainingSec: 0 };

  const k = key(userId, command);
  const now = Date.now();
  const entry = cooldowns.get(k);

  if (entry && entry.expiresAt > now) {
    return { ok: false, remainingSec: Math.ceil((entry.expiresAt - now) / 1000) };
  }

  // Neuen Cooldown setzen
  if (cooldowns.size >= MAX_ENTRIES) {
    // Notbremse: ältesten Eintrag entfernen, um unbegrenztes Wachstum zu verhindern.
    const firstKey = cooldowns.keys().next().value;
    if (firstKey) cooldowns.delete(firstKey);
  }
  cooldowns.set(k, { expiresAt: now + seconds * 1000 });
  return { ok: true, remainingSec: 0 };
}

/**
 * Entfernt einen aktiven Cooldown (z. B. für Admin-Override).
 */
export function clearCooldown(userId: string, command: string): void {
  cooldowns.delete(key(userId, command));
}

/**
 * Aktuelle Anzahl gecachter Cooldown-Einträge (für Metriken).
 */
export function getCooldownStats(): { entries: number } {
  return { entries: cooldowns.size };
}

// Periodisches Cleanup abgelaufener Einträge.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cooldowns) {
    if (v.expiresAt <= now) cooldowns.delete(k);
  }
}, CLEANUP_INTERVAL_MS).unref?.();
