/**
 * Wartung: Nitrado-Token aller Verbindungen re-validieren und gueltige
 * Verbindungen reaktivieren (Recovery aus EXPIRED). Gibt NIEMALS den Token aus.
 * Ausfuehrung im Container: node dist/src/scripts/nitradoRevalidate.js
 *
 * Nitrado-1Y: Der globale Scan ist nur Kandidatenfindung. Die eigentliche
 * Validierung laeuft pro Connection unter dem kanonischen Config-Lock und liest
 * den Token erst nach Lockgewinn frisch, damit ein alter Skript-Snapshot keine
 * parallele Tokenrotation oder Delete/Recreate-Aktion ueberschreibt.
 */
import prisma from '../database/prisma';
import { revalidateConnectionMaintenanceOnce } from '../modules/nitrado/maintenanceRevalidate';

async function main(): Promise<void> {
  // eslint-disable-next-line local/no-unscoped-prisma-query -- reiner globaler Kandidatenscan; jeder Kandidat wird danach frisch unter Connection-Lock und Guild+Connection-Scope gelesen.
  const conns = await prisma.nitradoConnection.findMany({
    where: { status: { in: ['ACTIVE', 'EXPIRED'] } },
    select: { id: true, guildId: true },
    orderBy: [{ guildId: 'asc' }, { slot: 'asc' }],
  });
  console.log(`[revalidate] ${conns.length} Verbindung(en)`);

  for (const candidate of conns) {
    try {
      const result = await revalidateConnectionMaintenanceOnce(candidate);
      switch (result.kind) {
        case 'BUSY':
          console.log(`- ${result.id}: BUSY -> uebersprungen`);
          break;
        case 'MISSING':
          console.log(`- ${result.id}: zwischen Scan und Lock entfernt/geaendert -> uebersprungen`);
          break;
        case 'DECRYPT_FAILED':
          console.log(`- ${result.alias} (slot ${result.slot}): DECRYPT-FEHLER`);
          break;
        case 'VALID':
          console.log(`- ${result.alias} (slot ${result.slot}): VALID -> ACTIVE`);
          break;
        case 'INVALID':
          console.log(`- ${result.alias} (slot ${result.slot}): INVALID (${result.status ?? '?'}) -> EXPIRED`);
          break;
        case 'TRANSIENT':
          console.log(
            `- ${result.alias} (slot ${result.slot}): ${result.result.kind} (transient) -> unveraendert (${result.previousStatus})`,
          );
          break;
      }
    } catch (error) {
      console.log(`- ${candidate.id}: FEHLER ${(error as Error).message}`);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[revalidate] Fehler:', (e as Error).message); process.exit(1); });
