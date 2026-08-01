/**
 * Wartung: Nitrado-Token aller Verbindungen re-validieren und gueltige
 * Verbindungen reaktivieren (Recovery aus EXPIRED). Gibt NIEMALS den Token aus.
 * Ausfuehrung im Container:  node dist/scripts/nitradoRevalidate.js
 */
import prisma from '../database/prisma';
import { config } from '../config';
import { decrypt } from '../utils/security';
import { NitradoClient } from '../modules/nitrado/nitradoClient';

async function main(): Promise<void> {
  // eslint-disable-next-line local/no-unscoped-prisma-query -- Wartungs-Task ueber alle Guilds; nur Statusfelder, kein Cross-Guild-Leak.
  const conns = await prisma.nitradoConnection.findMany({
    select: { id: true, guildId: true, slot: true, alias: true, status: true, encryptedToken: true },
    orderBy: [{ guildId: 'asc' }, { slot: 'asc' }],
  });
  console.log(`[revalidate] ${conns.length} Verbindung(en)`);

  for (const c of conns) {
    let token: string;
    try {
      token = decrypt(c.encryptedToken, config.security.encryptionKey);
    } catch {
      console.log(`- ${c.alias} (slot ${c.slot}): DECRYPT-FEHLER`);
      continue;
    }
    const client = new NitradoClient(token);
    const r = await client.validateTokenDetailed();
    if (r.kind === 'VALID') {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- id ist global eindeutig; Statusfeld-Update.
      await prisma.nitradoConnection.updateMany({
        where: { id: c.id },
        data: { status: 'ACTIVE', lastValidatedAt: new Date(), lastErrorMessage: null },
      });
      console.log(`- ${c.alias} (slot ${c.slot}): VALID -> ACTIVE`);
    } else if (r.kind === 'INVALID') {
      // eslint-disable-next-line local/no-unscoped-prisma-query -- id ist global eindeutig; Statusfeld-Update.
      await prisma.nitradoConnection.updateMany({ where: { id: c.id }, data: { status: 'EXPIRED' } });
      const status = 'status' in r ? r.status : '?';
      console.log(`- ${c.alias} (slot ${c.slot}): INVALID (${status}) -> EXPIRED`);
    } else {
      console.log(`- ${c.alias} (slot ${c.slot}): ${r.kind} (transient) -> unveraendert (${c.status})`);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error('[revalidate] Fehler:', (e as Error).message); process.exit(1); });
